import fs from 'fs';
import path from 'path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { spawnSync } from 'child_process';
import {
  createSessionDbFromTemplate,
  destroySessionDb,
  getSessionDbHandle,
  resolveRuntimeDbDir,
  resolveSessionDbPath,
} from './dbManager';
import {
  getScenarioById,
  getScenarioCatalog,
  getScenarioTemplatePath,
} from './scenarioCatalog';
import {
  getStudyModeConfig,
  getStudyConditionCode,
  isStudyModeId,
  normalizeStudyMode,
  DEFAULT_STUDY_MODE,
  DEMO_STUDY_MODE,
} from './modes';
import { startAgentForSession, stopAgentForSession } from './agentSupervisor';
import {
  appendInteractionLog,
  appendInteractionLogSafe,
  createInteractionLogFilePath,
  deleteInteractionLogArtifacts,
  hasCompletedBookingLog,
} from './interactionLogService';
import type {
  ScenarioDefinition,
  StudyModeId,
  StudySessionContext,
  StudySessionRecord,
  StudySessionTokenPayload,
} from './types';

interface CreateSessionInput {
  scenarioId: string;
  studyMode?: string;
  participantId?: string;
  loggingParticipantId?: string;
  /**
   * User-provided OpenAI API key for public demo sessions. Held in memory only
   * (see `sessionApiKeys`); never persisted, logged, or returned to the client.
   */
  apiKey?: string;
  /**
   * Session id reserved by the caller. Access-code redemption binds a code to an
   * id before the session exists, so that a bad code costs no agent process and
   * no database clone.
   */
  presetSessionId?: string;
}

export class StudySessionCapacityError extends Error {
  readonly code = 'DEMO_SESSION_CAPACITY_REACHED';
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = 'StudySessionCapacityError';
  }
}

interface PersistedSessionFile {
  sessions: StudySessionRecord[];
}

interface CreateSessionResult {
  record: StudySessionRecord;
  scenario: ScenarioDefinition;
  studyModeConfig: ReturnType<typeof getStudyModeConfig>;
  studyToken: string;
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const SESSION_TTL_MS = Number.parseInt(process.env.STUDY_SESSION_TTL_MS || '', 10) || 4 * 60 * 60 * 1000;
// Without STUDY_SESSION_SECRET, tokens are signed with a per-process random
// secret and do not survive a server restart.
const TOKEN_SECRET = process.env.STUDY_SESSION_SECRET || randomBytes(32).toString('hex');
const TUTORIAL_SCENARIO_ID = 'scn_t1_solo_weekend_3d_tutorial';
// A malformed value must never disable the cap (Number('ten') === NaN, and every
// `>= NaN` comparison is false), so parse strictly and fall back to 10.
const DEMO_MAX_CONCURRENT_SESSIONS = parsePositiveIntEnv(
  process.env.DEMO_MAX_CONCURRENT_SESSIONS,
  10
);
// Public demo visitors mostly just close the tab. Without a short lifetime and an
// idle reaper their records stay 'active' for the full study TTL and hold demo
// capacity (plus an agent child process) hostage.
const DEMO_SESSION_TTL_MS = parsePositiveIntEnv(
  process.env.DEMO_SESSION_TTL_MS,
  60 * 60 * 1000
);
const DEMO_SESSION_IDLE_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.DEMO_SESSION_IDLE_TIMEOUT_MS,
  15 * 60 * 1000
);

const sessions = new Map<string, StudySessionRecord>();
// User-provided OpenAI API keys, keyed by sessionId. In-memory only: never
// persisted to disk, never logged, never placed on a record/token/context.
const sessionApiKeys = new Map<string, string>();
// Last time a session resolved a context (any authenticated request or relay
// join). Memory-only; used to reap abandoned demo sessions.
const sessionLastSeenAt = new Map<string, number>();

function resolveBackendRootForSeeding(): string {
  const candidates = [
    path.resolve(process.cwd(), 'apps/backend'),
    process.cwd(),
    path.resolve(__dirname, '../..'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return process.cwd();
}

function runScenarioTemplateSeed(): void {
  const backendRoot = resolveBackendRootForSeeding();
  const distSeedPath = path.resolve(backendRoot, 'dist/db/seedScenarios.js');
  const commandResult = fs.existsSync(distSeedPath)
    ? spawnSync(process.execPath, [distSeedPath], {
        cwd: backendRoot,
        env: process.env,
        stdio: 'inherit',
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'db:seed:scenarios'], {
        cwd: backendRoot,
        env: process.env,
        stdio: 'inherit',
      });

  if (commandResult.status !== 0) {
    throw new Error('Failed to generate scenario template DBs.');
  }
}

function ensureScenarioTemplateDb(scenario: ScenarioDefinition): string {
  const templateDbPath = getScenarioTemplatePath(scenario);
  if (fs.existsSync(templateDbPath)) {
    return templateDbPath;
  }

  console.warn(
    `[study] Scenario template DB missing. Regenerating templates: ${templateDbPath}`
  );
  runScenarioTemplateSeed();

  if (!fs.existsSync(templateDbPath)) {
    throw new Error(`Scenario template DB not found: ${templateDbPath}`);
  }
  return templateDbPath;
}

function shouldEnforceSingleActiveAgentSession(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function forgetSessionApiKey(sessionId: string): void {
  sessionApiKeys.delete(sessionId);
}

function forgetSessionActivity(sessionId: string): void {
  sessionLastSeenAt.delete(sessionId);
}

function touchSessionActivity(sessionId: string): void {
  sessionLastSeenAt.set(sessionId, now().getTime());
}

function isAbandonedDemoSession(record: StudySessionRecord, current: number): boolean {
  if (record.studyMode !== DEMO_STUDY_MODE) return false;
  const lastSeen = sessionLastSeenAt.get(record.sessionId) ?? Date.parse(record.createdAt);
  if (!Number.isFinite(lastSeen)) return false;
  return current - lastSeen > DEMO_SESSION_IDLE_TIMEOUT_MS;
}

/**
 * Removes session DBs left behind by an unclean shutdown. Demo records are never
 * persisted (no logging of any kind), so after a crash there is no record left to
 * expire and their `.db` files would otherwise stay on disk forever.
 */
function sweepOrphanedSessionDbs(): void {
  let entries: string[];
  let dir: string;
  try {
    dir = resolveRuntimeDbDir();
    if (!fs.existsSync(dir)) return;
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const match = entry.match(/^(st_[0-9a-f]+)\.db(-wal|-shm|-journal)?$/);
    if (!match) continue;
    if (sessions.has(match[1])) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
    } catch {
      // Best-effort cleanup.
    }
  }
}

function countActiveDemoSessions(): number {
  let count = 0;
  for (const record of sessions.values()) {
    if (record.status !== 'active') continue;
    if (record.studyMode !== DEMO_STUDY_MODE) continue;
    count += 1;
  }
  return count;
}

function sessionsFileCandidates(): string[] {
  return [
    path.resolve(process.cwd(), 'apps/backend/.runtime/study-sessions.json'),
    path.resolve(process.cwd(), '.runtime/study-sessions.json'),
    path.resolve(__dirname, '../../.runtime/study-sessions.json'),
  ];
}

function resolveSessionsFilePath(): string {
  for (const candidate of sessionsFileCandidates()) {
    const parent = path.dirname(candidate);
    if (fs.existsSync(parent)) return candidate;
  }
  return sessionsFileCandidates()[0];
}

function ensureSessionsFileDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function now(): Date {
  return new Date();
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf-8');
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', TOKEN_SECRET).update(encodedPayload).digest('base64url');
}

function safeEqualText(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parseToken(token: string): StudySessionTokenPayload | null {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;
  const expected = signPayload(encodedPayload);
  if (!safeEqualText(signature, expected)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as StudySessionTokenPayload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.sessionId !== 'string' ||
      typeof payload.relaySessionId !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.iat !== 'number'
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function createToken(record: StudySessionRecord): string {
  const payload: StudySessionTokenPayload = {
    sessionId: record.sessionId,
    relaySessionId: record.relaySessionId,
    iat: Date.parse(record.createdAt),
    exp: Date.parse(record.expiresAt),
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function parseStudyMode(input: string | undefined): StudyModeId {
  if (input && isStudyModeId(input)) return input;
  return normalizeStudyMode(input);
}

function loadPersistedSessions(): void {
  const filePath = resolveSessionsFilePath();
  if (!fs.existsSync(filePath)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PersistedSessionFile;
    const records = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      if (record.status !== 'active') continue;
      const normalizedStudyMode = normalizeStudyMode(
        typeof record.studyMode === 'string' ? record.studyMode : undefined
      );
      sessions.set(record.sessionId, {
        ...record,
        conditionLabel:
          typeof record.conditionLabel === 'string' && record.conditionLabel.trim()
            ? record.conditionLabel.trim()
            : getStudyConditionCode(normalizedStudyMode),
        studyMode: normalizedStudyMode,
      });
    }
  } catch {
    // Ignore malformed runtime files; service will rebuild state.
  }
}

function deactivateSession(
  record: StudySessionRecord,
  status: 'finished' | 'expired',
  options?: {
    purgeInteractionArtifacts?: boolean;
  }
): void {
  const finishedAt = now().toISOString();
  if (options?.purgeInteractionArtifacts && !hasCompletedBookingLog(record)) {
    deleteInteractionLogArtifacts(record);
  } else {
    appendInteractionLogSafe(record, {
      type: `study.session.${status}`,
      payload: {
        status,
        finishedAt,
      },
    });
  }
  sessions.set(record.sessionId, {
    ...record,
    status,
    finishedAt,
  });
  stopAgentForSession(record.sessionId);
  forgetSessionApiKey(record.sessionId);
  forgetSessionActivity(record.sessionId);
  destroySessionDb(record.sessionId);
}

function deactivateOtherActiveAgentSessions(keepSessionId?: string): boolean {
  if (!shouldEnforceSingleActiveAgentSession()) return false;

  let changed = false;
  for (const record of sessions.values()) {
    if (record.status !== 'active') continue;
    if (keepSessionId && record.sessionId === keepSessionId) continue;
    // Public demo visitors run concurrently; they must never evict each other.
    if (record.studyMode === DEMO_STUDY_MODE) continue;
    const studyModeConfig = getStudyModeConfig(record.studyMode);
    if (!studyModeConfig.agentEnabled) continue;
    deactivateSession(record, 'expired', { purgeInteractionArtifacts: true });
    changed = true;
  }
  return changed;
}

function keepLatestActiveAgentSession(): boolean {
  if (!shouldEnforceSingleActiveAgentSession()) return false;

  const activeAgentSessions = Array.from(sessions.values())
    .filter((record) => {
      if (record.status !== 'active') return false;
      // Demo sessions are exempt from single-active enforcement.
      if (record.studyMode === DEMO_STUDY_MODE) return false;
      return getStudyModeConfig(record.studyMode).agentEnabled;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  if (activeAgentSessions.length <= 1) return false;
  const [, ...stale] = activeAgentSessions;
  let changed = false;
  for (const record of stale) {
    deactivateSession(record, 'expired', { purgeInteractionArtifacts: true });
    changed = true;
  }
  return changed;
}

function restartAgentsForActiveSessions(): boolean {
  let changed = false;
  for (const record of sessions.values()) {
    if (record.status !== 'active') continue;
    const scenario = getScenarioById(record.scenarioId);
    if (!scenario) continue;
    // Expiry is lazy and request-driven, so a record can still say `active`
    // long after its TTL. Respawning an agent for one produces a process that
    // busy-polls the relay for a host that will never arrive, and it comes back
    // on every restart because nothing ever marks the record dead.
    if (Date.parse(record.expiresAt) <= now().getTime()) {
      deactivateSession(record, 'expired');
      changed = true;
      continue;
    }
    // The per-session database is the session's whole world. If it is gone —
    // cleaned up, or lost with the runtime directory — the session cannot be
    // served, so retire it instead of starting an agent that cannot work.
    if (!fs.existsSync(resolveSessionDbPath(record.sessionId))) {
      deactivateSession(record, 'expired');
      changed = true;
      continue;
    }
    const apiKey = sessionApiKeys.get(record.sessionId);
    // `sessionApiKeys` is memory-only, so a session created with a visitor key
    // cannot be resumed after a restart. Expire it rather than respawning an
    // agent that would silently run on the operator's credentials.
    if (record.usesSessionApiKey && !apiKey) {
      deactivateSession(record, 'expired');
      changed = true;
      continue;
    }
    const studyModeConfig = getStudyModeConfig(record.studyMode);
    if (!studyModeConfig.agentEnabled) continue;
    startAgentForSession({
      sessionId: record.sessionId,
      relaySessionId: record.relaySessionId,
      scenarioId: scenario.id,
      participantId: record.participantId,
      loggingParticipantId: record.loggingParticipantId,
      interactionLogFile: record.interactionLogFile,
      studyMode: record.studyMode,
      modeConfig: studyModeConfig,
      apiKey,
    });
  }
  return changed;
}

function persistSessions(): void {
  const filePath = resolveSessionsFilePath();
  ensureSessionsFileDir(filePath);
  // Demo sessions are never written to disk (no logging of any kind).
  const all = Array.from(sessions.values()).filter(
    (record) => record.studyMode !== DEMO_STUDY_MODE
  );
  const payload: PersistedSessionFile = { sessions: all };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function markExpiredSessions(): boolean {
  let changed = false;
  const current = now().getTime();
  for (const [sessionId, record] of sessions.entries()) {
    if (record.status !== 'active') continue;
    if (Date.parse(record.expiresAt) > current && !isAbandonedDemoSession(record, current)) {
      continue;
    }
    const expired: StudySessionRecord = {
      ...record,
      status: 'expired',
      finishedAt: now().toISOString(),
    };
    appendInteractionLogSafe(record, {
      type: 'study.session.expired',
      payload: {
        status: 'expired',
        finishedAt: expired.finishedAt,
      },
    });
    sessions.set(sessionId, expired);
    stopAgentForSession(sessionId);
    forgetSessionApiKey(sessionId);
    forgetSessionActivity(sessionId);
    destroySessionDb(sessionId);
    changed = true;
  }
  return changed;
}

function buildSessionContext(record: StudySessionRecord): StudySessionContext | null {
  if (record.status !== 'active') return null;
  const scenario = getScenarioById(record.scenarioId);
  if (!scenario) return null;
  const dbHandle = getSessionDbHandle(record.sessionId);
  if (!dbHandle) return null;
  touchSessionActivity(record.sessionId);
  return {
    record,
    scenario,
    studyModeConfig: getStudyModeConfig(record.studyMode),
    db: dbHandle.db,
  };
}

loadPersistedSessions();
sweepOrphanedSessionDbs();
let normalizedActiveSessions = false;
if (keepLatestActiveAgentSession()) {
  normalizedActiveSessions = true;
}
if (markExpiredSessions()) {
  normalizedActiveSessions = true;
}
if (restartAgentsForActiveSessions()) {
  normalizedActiveSessions = true;
}
if (normalizedActiveSessions) {
  persistSessions();
}

export function listScenarios(): ScenarioDefinition[] {
  return getScenarioCatalog();
}

/**
 * Canonical participant id for logging is `Pnn`. The study corpus contains one
 * session whose payload says `p16` while its filename says `P16`, and a
 * case-sensitive filter over that corpus silently drops the participant
 * entirely — the difference between a 31-participant and a 32-participant
 * analysis. Normalize participant-shaped ids here, at the single point of
 * entry, and warn on anything that is not canonical so it is visible at session
 * creation rather than months later during analysis.
 *
 * Non participant-shaped ids (pilot names like `test123`) are left untouched:
 * rewriting them would be guesswork. Nothing is rejected — refusing to start a
 * session mid-study over a typo would be worse than logging one.
 */
function normalizeLoggingParticipantId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const participantShaped = /^p(\d+)$/i.exec(trimmed);
  const normalized = participantShaped ? `P${participantShaped[1]}` : trimmed;

  if (!/^P\d{2}$/.test(normalized)) {
    console.warn(
      `[study] loggingParticipantId "${trimmed}" is not canonical Pnn. ` +
        'It will be logged as-is; downstream analysis must filter it explicitly.'
    );
  } else if (normalized !== trimmed) {
    console.warn(`[study] loggingParticipantId "${trimmed}" normalized to "${normalized}".`);
  }
  return normalized;
}

/**
 * Mints a study session id without creating the session.
 *
 * Access-code redemption needs an id to bind the code to *before* the session
 * exists, so that a bad code is rejected without having spawned an agent
 * process or cloned a database. The caller passes the reserved id back in as
 * `presetSessionId`.
 */
export function allocateStudySessionId(): string {
  return `st_${randomUUID().replace(/-/g, '')}`;
}

export function createStudySession(input: CreateSessionInput): CreateSessionResult {
  const scenario = getScenarioById(input.scenarioId);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${input.scenarioId}`);
  }

  let changed = false;
  if (markExpiredSessions()) {
    changed = true;
  }

  const requestedStudyMode = parseStudyMode(input.studyMode);
  const requestedStudyModeConfig = getStudyModeConfig(requestedStudyMode);
  if (
    requestedStudyModeConfig.agentEnabled &&
    requestedStudyMode !== DEMO_STUDY_MODE &&
    deactivateOtherActiveAgentSessions()
  ) {
    changed = true;
  }

  if (changed) {
    persistSessions();
  }

  if (
    requestedStudyMode === DEMO_STUDY_MODE &&
    countActiveDemoSessions() >= DEMO_MAX_CONCURRENT_SESSIONS
  ) {
    throw new StudySessionCapacityError(
      `Demo is at capacity (${DEMO_MAX_CONCURRENT_SESSIONS} concurrent sessions). Please try again in a few minutes.`
    );
  }

  const studyMode = requestedStudyMode;
  const studyModeConfig = requestedStudyModeConfig;
  const conditionLabel = getStudyConditionCode(studyMode);
  const trimmedApiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';

  // A demo session must run entirely on the visitor's own key: without one the
  // agent and the speech routes would fall back to the operator's credentials.
  if (studyMode === DEMO_STUDY_MODE && !trimmedApiKey) {
    throw new Error('OPENAI_API_KEY_MISSING');
  }

  const templateDbPath = ensureScenarioTemplateDb(scenario);
  const sessionId = input.presetSessionId ?? allocateStudySessionId();
  const relaySessionId = `relay_${sessionId}`;
  const createdAt = now().toISOString();
  const ttlMs = studyMode === DEMO_STUDY_MODE ? DEMO_SESSION_TTL_MS : SESSION_TTL_MS;
  const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
  const participantId =
    typeof input.participantId === 'string' && input.participantId.trim()
      ? input.participantId.trim()
      : `P-${sessionId.slice(-6)}`;
  const loggingParticipantId = normalizeLoggingParticipantId(input.loggingParticipantId);
  const apiKey = trimmedApiKey;
  // Demo mode records nothing: an undefined log file disables backend
  // interaction logs, the agent LLM trace writer, and the frontend logger.
  const interactionLogFile =
    scenario.id === TUTORIAL_SCENARIO_ID || studyMode === DEMO_STUDY_MODE
      ? undefined
      : createInteractionLogFilePath(
          loggingParticipantId,
          conditionLabel,
          scenario.id,
          createdAt
        );

  const dbHandle = createSessionDbFromTemplate(sessionId, templateDbPath);
  try {
    const record: StudySessionRecord = {
      sessionId,
      relaySessionId,
      participantId,
      ...(loggingParticipantId ? { loggingParticipantId } : {}),
      interactionLogFile,
      conditionLabel,
      scenarioId: scenario.id,
      studyMode,
      dbPath: dbHandle.dbPath,
      status: 'active',
      createdAt,
      expiresAt,
      // Flag only -- the key itself stays in `sessionApiKeys`.
      ...(apiKey ? { usesSessionApiKey: true } : {}),
    };

    appendInteractionLog(record, {
      type: 'study.session.started',
      payload: {
        createdAt,
        expiresAt,
        conditionLabel,
        scenario: {
          id: scenario.id,
          title: scenario.title,
        },
        participantId,
        loggingParticipantId: loggingParticipantId ?? null,
      },
    });

    sessions.set(sessionId, record);
    touchSessionActivity(sessionId);
    if (apiKey) {
      sessionApiKeys.set(sessionId, apiKey);
    }

    if (studyModeConfig.agentEnabled) {
      startAgentForSession({
        sessionId,
        relaySessionId,
        scenarioId: scenario.id,
        participantId,
        loggingParticipantId,
        interactionLogFile,
        studyMode,
        modeConfig: studyModeConfig,
        apiKey,
      });
    }

    persistSessions();
    const studyToken = createToken(record);
    return {
      record,
      scenario,
      studyModeConfig,
      studyToken,
    };
  } catch (error) {
    sessions.delete(sessionId);
    sessionApiKeys.delete(sessionId);
    forgetSessionActivity(sessionId);
    stopAgentForSession(sessionId);
    destroySessionDb(sessionId);
    throw error;
  }
}

export function getSessionContextByToken(token: string): StudySessionContext | null {
  if (!token.trim()) return null;
  if (markExpiredSessions()) {
    persistSessions();
  }
  const payload = parseToken(token.trim());
  if (!payload) return null;

  const record = sessions.get(payload.sessionId);
  if (!record) return null;
  if (record.relaySessionId !== payload.relaySessionId) return null;
  if (record.status !== 'active') return null;
  if (Date.parse(record.expiresAt) <= now().getTime()) return null;

  return buildSessionContext(record);
}

export function getSessionContextById(sessionId: string): StudySessionContext | null {
  if (markExpiredSessions()) {
    persistSessions();
  }
  const record = sessions.get(sessionId);
  if (!record) return null;
  return buildSessionContext(record);
}

export function finishSessionByToken(token: string): StudySessionRecord | null {
  const context = getSessionContextByToken(token);
  if (!context) return null;

  const finishedAt = now().toISOString();
  appendInteractionLogSafe(context.record, {
    type: 'study.session.finished',
    payload: {
      status: 'finished',
      finishedAt,
    },
  });

  const finished: StudySessionRecord = {
    ...context.record,
    status: 'finished',
    finishedAt,
  };
  sessions.set(context.record.sessionId, finished);
  stopAgentForSession(context.record.sessionId);
  forgetSessionApiKey(context.record.sessionId);
  forgetSessionActivity(context.record.sessionId);
  destroySessionDb(context.record.sessionId);
  persistSessions();
  return finished;
}

/**
 * Returns the in-memory, user-provided OpenAI API key for a valid study token.
 * Deliberately kept off StudySessionContext so it is never spread into
 * `request.study` or serialized into any response.
 */
export function getSessionApiKeyByToken(token: string): string | null {
  if (!token.trim()) return null;
  if (markExpiredSessions()) {
    persistSessions();
  }
  const payload = parseToken(token.trim());
  if (!payload) return null;

  const record = sessions.get(payload.sessionId);
  if (!record) return null;
  if (record.relaySessionId !== payload.relaySessionId) return null;
  if (record.status !== 'active') return null;
  if (Date.parse(record.expiresAt) <= now().getTime()) return null;

  return sessionApiKeys.get(record.sessionId) || null;
}

export function getStudyModeByRelaySessionId(relaySessionId: string): StudyModeId | null {
  if (!relaySessionId.trim()) return null;
  for (const record of sessions.values()) {
    if (record.relaySessionId === relaySessionId) {
      return record.studyMode;
    }
  }
  return null;
}
