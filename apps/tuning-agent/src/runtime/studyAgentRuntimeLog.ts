/**
 * Durable sink for the agent process's own runtime events.
 *
 * The user-study build routed every `monitor.pushEvent` call — 42 sites,
 * including `runtime.fatal`, `action.exception`, `planner.cancelled` and
 * `relay.connect_failed` — into an in-memory ring buffer served over SSE, and
 * nothing else. The monitor is disabled in production, so in the study those
 * calls were no-ops. When 43 planner turns vanished inside one participant's
 * six sessions, there was no record of why: the incident had to be inferred
 * afterwards from a request/response count mismatch in the LLM trace files.
 *
 * This writes the same events to `logs/agent-runtime/<stem>.agent-runtime.jsonl`
 * alongside the interaction and LLM trace logs, using the same env-gating, so a
 * session that gets no interaction log (demo mode) gets no runtime log either.
 *
 * `llm.*` events are skipped: they already have a dedicated, much larger trace
 * file and duplicating those payloads would multiply the log volume for nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface StudyAgentRuntimeLogWriter {
  enabled: boolean;
  append: (type: string, payload: unknown) => void;
}

function readNonEmptyEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildRuntimeLogFilePath(interactionLogFile: string): string {
  const parsed = path.parse(interactionLogFile);
  const extension = parsed.ext || '.jsonl';
  const fileName = `${parsed.name}.agent-runtime${extension}`;
  return path.resolve(process.cwd(), 'logs', 'agent-runtime', fileName);
}

export function createStudyAgentRuntimeLogWriterFromEnv(): StudyAgentRuntimeLogWriter {
  const sessionId = readNonEmptyEnv('AGENT_RUNTIME_SESSION_ID');
  const relaySessionId = readNonEmptyEnv('AGENT_SESSION_ID');
  const interactionLogFile = readNonEmptyEnv('AGENT_INTERACTION_LOG_FILE');

  if (!sessionId || !relaySessionId || !interactionLogFile) {
    return { enabled: false, append: () => {} };
  }

  const filePath = buildRuntimeLogFilePath(interactionLogFile);
  const loggingParticipantId = readNonEmptyEnv('AGENT_LOGGING_PARTICIPANT_ID');
  const sessionParticipantId = readNonEmptyEnv('AGENT_PARTICIPANT_ID');
  const scenarioId = readNonEmptyEnv('AGENT_STUDY_ID');
  const studyMode = readNonEmptyEnv('AGENT_STUDY_MODE');

  let directoryReady = false;

  return {
    enabled: true,
    append: (type, payload) => {
      // The LLM traces have their own file; see the module comment.
      if (type.startsWith('llm.')) return;
      try {
        if (!directoryReady) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          directoryReady = true;
        }
        const entry = {
          timestamp: new Date().toISOString(),
          sessionId,
          relaySessionId,
          participantId: loggingParticipantId,
          sessionParticipantId,
          scenarioId,
          studyMode,
          type,
          payload,
        };
        fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
      } catch (error) {
        console.error('Failed to append agent runtime log:', error);
      }
    },
  };
}
