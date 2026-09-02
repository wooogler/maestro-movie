import fs from 'node:fs';
import path from 'node:path';

interface StudyInteractionLogEventInput {
  type: string;
  payload: unknown;
  clientTimestamp?: string;
}

export interface StudyLlmTraceLogWriter {
  enabled: boolean;
  append: (event: StudyInteractionLogEventInput) => void;
}

function readNonEmptyEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function createDisabledWriter(): StudyLlmTraceLogWriter {
  return {
    enabled: false,
    append: () => {},
  };
}

/**
 * The trace lands in a `trace` directory beside the interaction log's own
 * directory, not in a fixed `logs/trace`. A demo session's interaction path is
 * `logs/demo/interaction/...`, so its trace goes to `logs/demo/trace/...` and
 * never mixes with consented study data.
 *
 * `buildLlmTraceRelativeFile` in
 * `apps/backend/src/study/interactionLogService.ts` derives the same path on
 * the reading side. The two must agree or the download 404s.
 */
export function buildLlmTraceLogFilePath(interactionLogFile: string): string {
  const parsed = path.parse(interactionLogFile);
  const extension = parsed.ext || '.jsonl';
  const fileName = `${parsed.name}.llm-trace${extension}`;
  const traceDir = parsed.dir ? path.join(path.dirname(parsed.dir), 'trace') : path.join('logs', 'trace');
  return path.resolve(process.cwd(), traceDir, fileName);
}

export function createStudyLlmTraceLogWriterFromEnv(): StudyLlmTraceLogWriter {
  const sessionId = readNonEmptyEnv('AGENT_RUNTIME_SESSION_ID');
  const relaySessionId = readNonEmptyEnv('AGENT_SESSION_ID');
  const interactionLogFile = readNonEmptyEnv('AGENT_INTERACTION_LOG_FILE');
  // Handed over by the backend, which is the only party that also knows where
  // the export route will look. The derivation below is the fallback for an
  // agent started without it — a manual run, or a backend from before this
  // variable existed.
  const explicitTraceFile = readNonEmptyEnv('AGENT_LLM_TRACE_FILE');

  const traceSource = explicitTraceFile ?? interactionLogFile;
  if (!sessionId || !relaySessionId || !traceSource) {
    return createDisabledWriter();
  }

  const filePath = explicitTraceFile
    ? path.resolve(process.cwd(), explicitTraceFile)
    : buildLlmTraceLogFilePath(traceSource);
  const loggingParticipantId = readNonEmptyEnv('AGENT_LOGGING_PARTICIPANT_ID');
  const sessionParticipantId = readNonEmptyEnv('AGENT_PARTICIPANT_ID');
  const scenarioId = readNonEmptyEnv('AGENT_STUDY_ID');
  const studyMode = readNonEmptyEnv('AGENT_STUDY_MODE');

  return {
    enabled: true,
    append: (event) => {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const entry = {
          timestamp: new Date().toISOString(),
          ...(event.clientTimestamp ? { clientTimestamp: event.clientTimestamp } : {}),
          sessionId,
          relaySessionId,
          participantId: loggingParticipantId,
          sessionParticipantId,
          scenarioId,
          studyMode,
          type: event.type,
          payload: event.payload,
        };
        fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
      } catch (error) {
        console.error('Failed to append LLM trace log from agent:', error);
      }
    },
  };
}
