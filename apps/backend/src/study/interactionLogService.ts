import fs from 'fs';
import path from 'path';
import type { StudySessionRecord } from './types';
import { toShortScenarioFileLabel } from './scenarioFileLabels';

export interface StudyInteractionLogEventInput {
  type: string;
  payload: unknown;
  clientTimestamp?: string;
}

const WORKSPACE_ROOT = path.resolve(__dirname, '../../../../');
const LOG_ROOT_DIR = path.resolve(WORKSPACE_ROOT, 'logs');
const INTERACTION_LOG_DIR = path.resolve(LOG_ROOT_DIR, 'interaction');
const LLM_TRACE_LOG_DIR = path.resolve(LOG_ROOT_DIR, 'trace');
const DEMO_LOG_ROOT_DIR = path.resolve(LOG_ROOT_DIR, 'demo');

function sanitizeFileToken(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

function formatFileTimestamp(iso: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const getPart = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${getPart('year')}${getPart('month')}${getPart('day')}-${getPart('hour')}${getPart('minute')}${getPart('second')}`;
}

function resolveLogFilePath(relativeFile: string): string {
  return path.resolve(WORKSPACE_ROOT, relativeFile);
}

function getLogParticipantId(record: StudySessionRecord): string | null {
  if (typeof record.loggingParticipantId !== 'string') return null;
  const value = record.loggingParticipantId.trim();
  return value || null;
}

function getRelativeLogFile(record: StudySessionRecord): string | null {
  if (typeof record.interactionLogFile !== 'string') return null;
  const value = record.interactionLogFile.trim();
  return value || null;
}

/**
 * The trace that belongs to an interaction log: same stem, in the `trace`
 * directory beside it. Only sessions that keep an interaction log go through
 * here — a demo session has none and uses `createDemoLlmTraceFilePath`.
 *
 * `buildLlmTraceLogFilePath` in `apps/tuning-agent/src/runtime/studyLlmTraceLog.ts`
 * is the same rule on the writing side, used when the backend did not hand the
 * agent an explicit path. `npm run check:logpaths` holds the two together.
 */
export function buildLlmTraceRelativeFile(relativeFile: string): string {
  const parsed = path.posix.parse(relativeFile);
  const extension = parsed.ext || '.jsonl';
  const traceDir = parsed.dir
    ? path.posix.join(path.posix.dirname(parsed.dir), 'trace')
    : path.posix.join('logs', 'trace');
  return path.posix.join(traceDir, `${parsed.name}.llm-trace${extension}`);
}

export function createInteractionLogFileName(
  participantId: string | null | undefined,
  conditionLabel: string | null | undefined,
  scenarioId: string | null | undefined,
  createdAt: string
): string {
  const safeTimestamp = formatFileTimestamp(createdAt);
  const safePid =
    typeof participantId === 'string' && participantId.trim()
      ? sanitizeFileToken(participantId, 'participant')
      : null;
  const safeCondition =
    typeof conditionLabel === 'string' && conditionLabel.trim()
      ? sanitizeFileToken(conditionLabel, 'condition')
      : 'condition';
  const safeScenario =
    sanitizeFileToken(toShortScenarioFileLabel(scenarioId) || scenarioId || 'scenario', 'scenario');
  return safePid
    ? `${safePid}-${safeCondition}-${safeScenario}-${safeTimestamp}.jsonl`
    : `${safeCondition}-${safeScenario}-${safeTimestamp}.jsonl`;
}

/**
 * The stem both demo files share.
 *
 * It carries the session id because demo visitors run concurrently and have no
 * participant id: a name built only from a whole-second timestamp would have
 * two visitors who started in the same second appending to one file.
 */
function buildDemoLogStem(sessionId: string, createdAt: string): string {
  return `demo-${sanitizeFileToken(sessionId, 'session')}-${formatFileTimestamp(createdAt)}`;
}

/**
 * Where a session's trace goes.
 *
 * A session that also keeps an interaction log puts its trace beside it, under
 * the same stem — that is the existing `logs/trace/<stem>.llm-trace.jsonl` and
 * it is unchanged. A demo session's pair lives under `logs/demo/` instead, and
 * because both demo paths are built from `buildDemoLogStem`, deriving the trace
 * from the interaction log with `buildLlmTraceRelativeFile` lands on exactly
 * the name this function returns.
 */
export function createDemoLlmTraceFilePath(sessionId: string, createdAt: string): string {
  return path.posix.join('logs', 'demo', 'trace', `${buildDemoLogStem(sessionId, createdAt)}.llm-trace.jsonl`);
}

/**
 * Where a *consenting* demo visitor's interaction log goes.
 *
 * Never `logs/interaction/`: that directory is the study corpus, and a booth
 * visitor is not a study participant. They agreed to have this session recorded
 * for research, not to be filed alongside a consented, counterbalanced,
 * PID-carrying run. A demo log has no participant id in it at all.
 */
export function createDemoInteractionLogFilePath(sessionId: string, createdAt: string): string {
  return path.posix.join('logs', 'demo', 'interaction', `${buildDemoLogStem(sessionId, createdAt)}.jsonl`);
}

export function createInteractionLogFilePath(
  participantId: string | null | undefined,
  conditionLabel: string | null | undefined,
  scenarioId: string | null | undefined,
  createdAt: string
): string {
  const fileName = createInteractionLogFileName(
    participantId,
    conditionLabel,
    scenarioId,
    createdAt
  );
  return path.posix.join('logs', 'interaction', fileName);
}

export function hasInteractionLogging(record: StudySessionRecord): boolean {
  return Boolean(getRelativeLogFile(record));
}

export function appendInteractionLog(
  record: StudySessionRecord,
  event: StudyInteractionLogEventInput
): string | null {
  const relativeFile = getRelativeLogFile(record);
  if (!relativeFile) {
    return null;
  }
  const loggingParticipantId = getLogParticipantId(record);

  const filePath = resolveLogFilePath(relativeFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const entry = {
    timestamp: new Date().toISOString(),
    ...(event.clientTimestamp ? { clientTimestamp: event.clientTimestamp } : {}),
    sessionId: record.sessionId,
    relaySessionId: record.relaySessionId,
    participantId: loggingParticipantId,
    sessionParticipantId: record.participantId,
    conditionLabel: record.conditionLabel,
    scenarioId: record.scenarioId,
    studyMode: record.studyMode,
    type: event.type,
    payload: event.payload,
  };

  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  return relativeFile;
}

export function appendInteractionLogSafe(
  record: StudySessionRecord,
  event: StudyInteractionLogEventInput
): string | null {
  try {
    return appendInteractionLog(record, event);
  } catch (error) {
    console.error('Failed to append interaction log:', error);
    return null;
  }
}

export function readInteractionLogFile(
  record: StudySessionRecord
): { fileName: string; content: Buffer } | null {
  const relativeFile = getRelativeLogFile(record);
  if (!relativeFile) {
    return null;
  }

  const filePath = resolveLogFilePath(relativeFile);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return {
    fileName: path.posix.basename(relativeFile),
    content: fs.readFileSync(filePath),
  };
}

export function getLlmTraceFile(record: StudySessionRecord): string | null {
  const explicit =
    typeof record.llmTraceFile === 'string' ? record.llmTraceFile.trim() : '';
  if (explicit) return explicit;
  // Sessions persisted before `llmTraceFile` existed still derive it, so a
  // restart does not lose the download for a session already in flight.
  const relativeFile = getRelativeLogFile(record);
  return relativeFile ? buildLlmTraceRelativeFile(relativeFile) : null;
}

export function hasLlmTrace(record: StudySessionRecord): boolean {
  return Boolean(getLlmTraceFile(record));
}

export function readLlmTraceLogFile(
  record: StudySessionRecord
): { fileName: string; content: Buffer } | null {
  const llmTraceRelativeFile = getLlmTraceFile(record);
  if (!llmTraceRelativeFile) {
    return null;
  }

  const filePath = resolveLogFilePath(llmTraceRelativeFile);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return {
    fileName: path.posix.basename(llmTraceRelativeFile),
    content: fs.readFileSync(filePath),
  };
}

/**
 * Purges an abandoned study session's files.
 *
 * Only sessions this sweep can reach have one: it runs when a study session is
 * evicted, and demo sessions are exempt from eviction. That matters now that a
 * consenting demo visitor has an interaction log of their own — it exists
 * because they agreed to it, and deleting it when they walk away from the booth
 * would collect nothing.
 */
export function deleteInteractionLogArtifacts(record: StudySessionRecord): void {
  const relativeFile = getRelativeLogFile(record);
  if (!relativeFile) {
    return;
  }

  const interactionFilePath = resolveLogFilePath(relativeFile);
  // The recorded path, not a re-derivation of it: they agree for a study
  // session today, and this stays right if that ever stops being true.
  const llmTraceRelativeFile = getLlmTraceFile(record) ?? buildLlmTraceRelativeFile(relativeFile);
  const llmTraceFilePath = resolveLogFilePath(llmTraceRelativeFile);

  if (fs.existsSync(interactionFilePath)) {
    fs.rmSync(interactionFilePath, { force: true });
  }
  if (fs.existsSync(llmTraceFilePath)) {
    fs.rmSync(llmTraceFilePath, { force: true });
  }
}

export function hasCompletedBookingLog(record: StudySessionRecord): boolean {
  const relativeFile = getRelativeLogFile(record);
  if (!relativeFile) {
    return false;
  }

  const filePath = resolveLogFilePath(relativeFile);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.includes('"type":"booking.completed"') || content.includes('"type":"study.session.finished"');
  } catch {
    return false;
  }
}

export function ensureInteractionLogDir(): void {
  fs.mkdirSync(INTERACTION_LOG_DIR, { recursive: true });
  fs.mkdirSync(LLM_TRACE_LOG_DIR, { recursive: true });
  // Created unconditionally so an operator can see whether anything has been
  // recorded for the demo without having to run a session first. Both stay
  // empty unless a visitor ticks the consent box on the setup screen.
  fs.mkdirSync(path.resolve(DEMO_LOG_ROOT_DIR, 'trace'), { recursive: true });
  fs.mkdirSync(path.resolve(DEMO_LOG_ROOT_DIR, 'interaction'), { recursive: true });
}
