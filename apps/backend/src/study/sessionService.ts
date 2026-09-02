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
  isDemoStudyMode,
  isStudyModeId,
  normalizeStudyMode,
  DEFAULT_STUDY_MODE,
  DEMO_STUDY_MODE,
} from './modes';
import { startAgentForSession, stopAgentForSession } from './agentSupervisor';
import {
  appendInteractionLog,
  appendInteractionLogSafe,
  buildLlmTraceRelativeFile,
  createDemoInteractionLogFilePath,
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
  StudySessionTokenScope,
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
  /**
   * The demo visitor ticked the research-recording box on the setup screen.
   * Nothing else turns demo recording on: it is the visitor's decision, made
   * before the session exists, and it is the only reason a `logs/demo/` file is
   * ever written.
   */
  researchConsent?: boolean;
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
  /** Read-only pairing token for a second device. Never grants the host role. */
  viewToken: string;
  /**
   * The credential the agent process joins the relay with. Returned so the
   * executable checks can assert what it cannot do; `POST /study/sessions`
   * builds its response as an explicit literal and must never include it.
   */
  agentToken: string;
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
/*
 * `DEMO_TRACE_ENABLED` used to live here, as the operator's way to record booth
 * traffic for planner tuning. The setup screen now asks the visitor instead,
 * and an environment variable that recorded someone who had just been asked and
 * said no would make that question a lie — so the switch is gone rather than
 * ANDed with the answer. Consent alone decides.
 */

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

/**
 * Live companion pairings: sessionId -> the `jti` of the one companion token
 * that is currently valid, plus how many Realtime credentials that pairing may
 * still mint.
 *
 * Memory-only and never persisted, so a backend restart revokes every pairing —
 * which is the behaviour we want: a phone paired to a session that no longer has
 * a live relay must re-pair rather than keep a standing capability.
 *
 * The mint gate is the reason this is a record and not just a string. The
 * session-bound OpenAI key at a conference booth IS the operator key (the
 * access-code flow copies it in), so a pairing that could mint unboundedly would
 * let anyone who photographed the booth QR spend it.
 *
 * The gate is **live attachment**, not a one-shot budget. An earlier version
 * granted N mints per relay join, which looked equivalent and was not: the
 * phone's own voice session has a five-deep reconnect ladder and renews itself
 * every 50 minutes, and every one of those attempts mints. A phone could
 * therefore exhaust its budget without its relay socket ever dropping, and then
 * be permanently mute with only a page reload to recover. Requiring the socket
 * to be open right now is both a stronger bound — an attacker must hold the
 * single companion slot, which visibly evicts the visitor's phone — and one that
 * legitimate retries cannot trip. The rolling limit on top is a rate limit, not
 * a budget: it refills with time.
 */
interface CompanionPairing {
  jti: string;
  /** Whether a phone is attached to the relay for this session right now. */
  attached: boolean;
  /** Epoch-ms of recent mints, for the rolling rate limit. */
  mints: number[];
}

const companionPairings = new Map<string, CompanionPairing>();

/** How long a scanned pairing stays usable. Never longer than the session. */
const COMPANION_TOKEN_TTL_MS = parsePositiveIntEnv(
  process.env.COMPANION_TOKEN_TTL_MINUTES,
  60
) * 60_000;

/** Rolling rate limit for companion Realtime mints. Refills with time. */
const COMPANION_MINT_WINDOW_MS = parsePositiveIntEnv(
  process.env.COMPANION_MINT_WINDOW_MINUTES,
  10
) * 60_000;
const COMPANION_MINTS_PER_WINDOW = parsePositiveIntEnv(
  process.env.COMPANION_MINTS_PER_WINDOW,
  12
);

function forgetCompanionPairing(sessionId: string): void {
  companionPairings.delete(sessionId);
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

function parseToken(
  token: string,
  expectedScope: StudySessionTokenScope
): StudySessionTokenPayload | null {
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
    // A token minted before `scope` existed is a study token. A view token
    // always carries the field, so it can never be mistaken for one.
    if ((payload.scope ?? 'study') !== expectedScope) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function createToken(
  record: StudySessionRecord,
  scope: StudySessionTokenScope = 'study',
  options?: { jti?: string; expiresAtMs?: number }
): string {
  const payload: StudySessionTokenPayload = {
    sessionId: record.sessionId,
    relaySessionId: record.relaySessionId,
    iat: Date.parse(record.createdAt),
    // Never outlives the session, whatever the caller asks for.
    exp: Math.min(Date.parse(record.expiresAt), options?.expiresAtMs ?? Number.MAX_SAFE_INTEGER),
    scope,
    // Spread so the emitted bytes of a study/view/agent token are unchanged.
    ...(options?.jti ? { jti: options.jti } : {}),
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
  forgetCompanionPairing(record.sessionId);
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
      llmTraceFile: record.llmTraceFile,
      studyMode: record.studyMode,
      modeConfig: studyModeConfig,
      apiKey,
      // Scoped to this session and to the agent role alone. See the note on
      // StudySessionTokenScope for what it is closing.
      agentToken: createToken(record, 'agent'),
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
    forgetCompanionPairing(sessionId);
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
  // An undefined interaction log file disables the backend interaction log, the
  // frontend logger and the agent runtime log in one move — that is how the
  // tutorial records nothing about the person using it, and how a demo visitor
  // who did not consent is recorded no differently than before this existed.
  const isDemo = studyMode === DEMO_STUDY_MODE;
  // The booth asks, once, on the setup screen. This flag is the answer, and it
  // is the whole of what separates a recorded demo session from an anonymous
  // one — there is no environment variable that can record a visitor who said
  // no, and none that can skip asking.
  const demoRecordingConsented = isDemo && input.researchConsent === true;
  const interactionLogFile =
    scenario.id === TUTORIAL_SCENARIO_ID
      ? undefined
      : isDemo
        ? demoRecordingConsented
          ? createDemoInteractionLogFilePath(sessionId, createdAt)
          : undefined
        : createInteractionLogFilePath(
            loggingParticipantId,
            conditionLabel,
            scenario.id,
            createdAt
          );

  // The trace is still tracked separately, because the two are not the same
  // decision for a *study* session. For a demo session they now move together:
  // a trace carries the visitor's own utterances inside the prompts it
  // captures, so it exists exactly when the visitor agreed to be recorded.
  // Either way demo output goes to `logs/demo/`, never `logs/trace/` or
  // `logs/interaction/`, which is what the study corpus tools glob.
  const llmTraceFile = interactionLogFile
    ? buildLlmTraceRelativeFile(interactionLogFile)
    : undefined;

  const dbHandle = createSessionDbFromTemplate(sessionId, templateDbPath);
  try {
    const record: StudySessionRecord = {
      sessionId,
      relaySessionId,
      participantId,
      ...(loggingParticipantId ? { loggingParticipantId } : {}),
      interactionLogFile,
      ...(llmTraceFile ? { llmTraceFile } : {}),
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
        // First line of a consented demo log says why the file exists at all.
        ...(isDemo ? { researchConsent: demoRecordingConsented } : {}),
      },
    });

    sessions.set(sessionId, record);
    touchSessionActivity(sessionId);
    if (apiKey) {
      sessionApiKeys.set(sessionId, apiKey);
    }

    const agentToken = createToken(record, 'agent');

    if (studyModeConfig.agentEnabled) {
      startAgentForSession({
        sessionId,
        relaySessionId,
        scenarioId: scenario.id,
        participantId,
        loggingParticipantId,
        interactionLogFile,
        llmTraceFile,
        studyMode,
        modeConfig: studyModeConfig,
        apiKey,
        agentToken,
      });
    }

    persistSessions();
    const studyToken = createToken(record);
    // A second device pairs with this session by scanning a QR of this token.
    // Read-only by construction — see the scope note on StudySessionTokenPayload.
    const viewToken = createToken(record, 'view');
    return {
      record,
      scenario,
      studyModeConfig,
      studyToken,
      viewToken,
      agentToken,
    };
  } catch (error) {
    sessions.delete(sessionId);
    sessionApiKeys.delete(sessionId);
    forgetSessionActivity(sessionId);
    forgetCompanionPairing(sessionId);
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
  const payload = parseToken(token.trim(), 'study');
  if (!payload) return null;

  const record = sessions.get(payload.sessionId);
  if (!record) return null;
  if (record.relaySessionId !== payload.relaySessionId) return null;
  if (record.status !== 'active') return null;
  if (Date.parse(record.expiresAt) <= now().getTime()) return null;

  return buildSessionContext(record);
}

/**
 * Resolves a read-only view token to the relay session it may watch.
 *
 * Returns the relay session id and nothing else on purpose: a viewer needs to be
 * routed to a session, and handing back a `StudySessionContext` would give a
 * second device the record, the database path and the scenario.
 */
/**
 * Resolves an agent token to the relay session that agent may attach to.
 *
 * Same narrow return as the view resolver above, for the same reason. The agent
 * role is the most powerful one on the relay — it can drive the booking GUI and
 * end the session — so it must name its session through a signed token rather
 * than a raw id, exactly as host and viewer already do.
 */
/**
 * Mints the pairing token a phone scans to become this session's microphone and
 * speaker. Demo-only, and deliberately not minted with the session: the
 * capability should exist for the seconds a visitor is actually pairing, not for
 * the whole session, and `POST /study/sessions` keeps its exact response shape.
 *
 * Minting rotates the `jti`, so scanning a fresh QR revokes the previous phone.
 */
export function createCompanionToken(
  studyToken: string
): { companionToken: string; expiresAt: string } | null {
  const context = getSessionContextByToken(studyToken);
  if (!context) return null;

  // Spelled out as a positive demo test with an explicit refusal on the other
  // arm. A study condition must never acquire phone voice by falling through.
  if (!isDemoStudyMode(context.record.studyMode)) {
    return null;
  }

  const record = context.record;
  const expiresAtMs = Math.min(
    Date.parse(record.expiresAt),
    now().getTime() + COMPANION_TOKEN_TTL_MS
  );
  const jti = randomUUID();
  // Not attached yet: a token that was photographed but never paired can mint
  // nothing, because minting requires a live companion socket.
  companionPairings.set(record.sessionId, { jti, attached: false, mints: [] });

  return {
    companionToken: createToken(record, 'companion', { jti, expiresAtMs }),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/** Shared gate for both companion resolvers. Returns the record or null. */
function resolveCompanionRecord(token: string): StudySessionRecord | null {
  if (!token.trim()) return null;
  if (markExpiredSessions()) {
    persistSessions();
  }
  const payload = parseToken(token.trim(), 'companion');
  if (!payload) return null;

  // Unlike the other scopes, a companion token's own expiry is enforced. The
  // other scopes live exactly as long as their session and the record checks
  // below already cover them; this one is deliberately shorter-lived, and a TTL
  // nothing reads would be decoration.
  if (typeof payload.exp !== 'number' || payload.exp <= now().getTime()) return null;

  // A companion token must carry a jti and it must be the current one. Written
  // as an explicit string test first: comparing a missing jti against a missing
  // pairing would be `undefined === undefined`, which fails open.
  if (typeof payload.jti !== 'string' || !payload.jti) return null;
  const pairing = companionPairings.get(payload.sessionId);
  if (!pairing || pairing.jti !== payload.jti) return null;

  const record = sessions.get(payload.sessionId);
  if (!record) return null;
  if (record.relaySessionId !== payload.relaySessionId) return null;
  if (record.status !== 'active') return null;
  if (!isDemoStudyMode(record.studyMode)) return null;
  if (Date.parse(record.expiresAt) <= now().getTime()) return null;

  return record;
}

/**
 * Resolves a companion token to the relay session its phone may attach to.
 *
 * Narrow return, same as the view and agent resolvers. Deliberately does NOT
 * call `touchSessionActivity`: a paired phone left on a shelf must not hold a
 * demo slot open against the idle reaper.
 */
export function getRelaySessionIdByCompanionToken(token: string): string | null {
  return resolveCompanionRecord(token)?.relaySessionId ?? null;
}

/**
 * Records whether a phone is attached to this session's relay right now. Called
 * by the relay on companion join and on companion disconnect; this is the gate
 * on spending the session's OpenAI key.
 */
export function setCompanionAttached(relaySessionId: string, attached: boolean): void {
  for (const record of sessions.values()) {
    if (record.relaySessionId !== relaySessionId) continue;
    const pairing = companionPairings.get(record.sessionId);
    if (!pairing) return;
    pairing.attached = attached;
    return;
  }
}

/**
 * Resolves the OpenAI key backing a companion's Realtime mint, consuming one of
 * the allowance granted at attach time. Returns null when the pairing is invalid
 * or the allowance is spent.
 *
 * NOTE — and this is the guarantee that must not be overstated anywhere: at a
 * conference booth this key IS the operator key, because the access-code flow
 * copies `OPENAI_API_KEY` into the session. Keeping `getEnvOpenAiApiKey` out of
 * this function proves nothing on its own. What actually bounds the exposure is
 * the attach requirement plus this allowance.
 */
export function consumeCompanionApiKey(token: string): string | null {
  const record = resolveCompanionRecord(token);
  if (!record) return null;
  const pairing = companionPairings.get(record.sessionId);
  if (!pairing || !pairing.attached) return null;

  const nowMs = now().getTime();
  pairing.mints = pairing.mints.filter((at) => nowMs - at < COMPANION_MINT_WINDOW_MS);
  if (pairing.mints.length >= COMPANION_MINTS_PER_WINDOW) return null;

  const key = sessionApiKeys.get(record.sessionId);
  if (!key || !key.trim()) return null;
  pairing.mints.push(nowMs);
  return key.trim();
}

export function getRelaySessionIdByAgentToken(token: string): string | null {
  if (!token.trim()) return null;
  if (markExpiredSessions()) {
    persistSessions();
  }
  const payload = parseToken(token.trim(), 'agent');
  if (!payload) return null;

  const record = sessions.get(payload.sessionId);
  if (!record) return null;
  if (record.relaySessionId !== payload.relaySessionId) return null;
  if (record.status !== 'active') return null;
  if (Date.parse(record.expiresAt) <= now().getTime()) return null;

  return record.relaySessionId;
}

export function getRelaySessionIdByViewToken(token: string): string | null {
  if (!token.trim()) return null;
  if (markExpiredSessions()) {
    persistSessions();
  }
  const payload = parseToken(token.trim(), 'view');
  if (!payload) return null;

  const record = sessions.get(payload.sessionId);
  if (!record) return null;
  if (record.relaySessionId !== payload.relaySessionId) return null;
  if (record.status !== 'active') return null;
  if (Date.parse(record.expiresAt) <= now().getTime()) return null;

  return record.relaySessionId;
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
  forgetCompanionPairing(context.record.sessionId);
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
  const payload = parseToken(token.trim(), 'study');
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
