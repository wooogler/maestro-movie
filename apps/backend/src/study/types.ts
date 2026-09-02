import type { db as defaultDb } from '../db';

export type StudyDb = typeof defaultDb;

export type StudyModeId =
  | 'basic-tuning-voice-off'
  | 'basic-tuning-voice-on'
  | 'full-tuning-voice-off'
  | 'full-tuning-voice-on'
  | 'demo';

export interface StudyModeConfig {
  agentEnabled: boolean;
  guiAdaptationEnabled: boolean;
  cpMemoryWindow: number;
  voiceModeAvailable: boolean;
}

export interface ScenarioSeedFilters {
  includeMovieIds?: string[];
  includeTheaterIds?: string[];
}

export interface ScenarioStepBriefs {
  movie?: string;
  theater?: string;
  date?: string;
  time?: string;
  seat?: string;
  confirm?: string;
}

export interface ScenarioDefinition {
  id: string;
  title: string;
  background?: string;
  story: string;
  stepBriefs?: ScenarioStepBriefs;
  narratorPreferenceTypes: string[];
  seatRows?: string[];
  templateDbFile: string;
  seedDataFile?: string;
  seedFilters?: ScenarioSeedFilters;
  /**
   * The day this scenario's world is set on, and how many days the calendar
   * offers from it. Read from the scenario's dataset when it has one; scenarios
   * without a dataset fall back to FIXED_CURRENT_DATE and the default window.
   */
  todayIso?: string;
  dateWindowDays?: number;
}

export interface StudySessionRecord {
  sessionId: string;
  relaySessionId: string;
  participantId: string;
  loggingParticipantId?: string;
  interactionLogFile?: string;
  /**
   * Where this session's LLM trace is written, independent of
   * `interactionLogFile`. They are separate because that field is a five-way
   * switch — backend interaction log, frontend logger, agent trace, agent
   * runtime log, and the trace's file name — and the public demo needs exactly
   * one of those five: the trace, for tuning the planner. Undefined means no
   * trace is written and the export route has nothing to serve.
   */
  llmTraceFile?: string;
  conditionLabel: string;
  scenarioId: string;
  studyMode: StudyModeId;
  dbPath: string;
  status: 'active' | 'finished' | 'expired';
  createdAt: string;
  expiresAt: string;
  finishedAt?: string;
  /**
   * Marks a session that was created with a user-provided OpenAI key. Only the
   * flag is persisted -- the key itself is memory-only (see `sessionApiKeys` in
   * sessionService) and must never reach this record. After a backend restart
   * the key is gone, so a flagged session is expired instead of being resumed on
   * the operator's credentials.
   */
  usesSessionApiKey?: boolean;
}

/**
 * `scope` is load-bearing. Every token is signed with the same secret and has
 * the same shape, so without it a read-only view token would satisfy
 * `getSessionContextByToken` and grant the whole study session: the host role on
 * the relay, the trace download, and the power to finish the session. Absent
 * means `study`, so tokens minted before this field existed keep working.
 *
 * `agent` names the session an agent process may attach to, and nothing else.
 * It exists because `relay.join` used to accept `role: 'agent'` with a raw
 * `relaySessionId` and no credential at all, while `relay.joined` echoed that
 * id back to every joiner — so anyone holding a view token could read the id
 * out of their own join reply, open a second socket as an agent, and drive the
 * live session: `tool.call` into the booking GUI, `agent.message` spoken aloud,
 * `session.end`. The id is now withheld from token-authenticated roles and an
 * agent must present this scope.
 *
 * `companion` names the session a paired phone may act as the microphone and
 * speaker for. It is write-capable on the relay, unlike `view`, but only on a
 * lane that reaches the host — never the agent. It carries a `jti` so a pairing
 * can be revoked, and unlike the other scopes its own `exp` is enforced.
 */
export type StudySessionTokenScope = 'study' | 'view' | 'agent' | 'companion';

export interface StudySessionTokenPayload {
  sessionId: string;
  relaySessionId: string;
  exp: number;
  iat: number;
  scope?: StudySessionTokenScope;
  /**
   * Revocation handle, `companion` scope only. Absent on every other scope, and
   * a companion token without one is refused rather than accepted — an equality
   * test between two `undefined`s would otherwise fail open and make every
   * revoked pairing valid again.
   */
  jti?: string;
}

export interface StudySessionContext {
  record: StudySessionRecord;
  scenario: ScenarioDefinition;
  studyModeConfig: StudyModeConfig;
  db: StudyDb;
}
