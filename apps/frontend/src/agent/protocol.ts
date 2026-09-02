import type { ToolDefinition } from './tools';
import type { ChatMessage } from '../store/chatStore';

export const PROTOCOL_VERSION = 'mvp-0.2';

export interface RelayEnvelope {
  v?: string;
  type: string;
  id?: string;
  replyTo?: string;
  payload?: Record<string, unknown>;
}

export interface SnapshotPayload {
  sessionId: string;
  uiSpec: Record<string, unknown> | null;
  messageHistory: ChatMessage[];
  toolSchema: ToolDefinition[];
  plannerCpMemoryLimit: number;
  guiAdaptationEnabled: boolean;
  /**
   * A scanned quick-demo card is running: the planner should describe each GUI
   * adaptation out loud rather than leave the screen to speak for itself.
   *
   * Absent or false is the study behaviour, unchanged. It rides the snapshot
   * rather than its own envelope because it is fixed for the session and the
   * snapshot is the one payload the agent re-requests after a reset, a
   * reconnect and a respawn — the same reason `preferenceProfile` is here.
   */
  narrateAdaptations?: boolean;
  /**
   * Ask the planner to write the spoken sentence short, instead of writing it
   * for the eye and having the frontend gate cut it afterwards.
   *
   * Unlike `narrateAdaptations` this is NOT session-fixed — voice can be
   * toggled from the composer — so it is re-sent whenever it changes and the
   * agent treats an absent field as "unchanged".
   */
  spokenBrevity?: boolean;
  /** 전체 stage 메타데이터 (goal + fieldGuide). 초기화 시 한 번만 전송. */
  stageMeta?: Array<{ stage: string; goal: string; fieldGuide: string }>;
  /**
   * Preference memory to open the session with. Rides this payload because the
   * agent re-requests it after a reset, a reconnect and a respawn, so the seed
   * replays on all three without the host having to notice any of them.
   */
  preferenceProfile?: PreferenceProfilePayload | null;
}

/** Mirrors `PreferenceProfilePayload` in the agent runtime. */
export interface PreferenceProfilePayload {
  /** Monotonic. The agent applies a revision once and ignores repeats. */
  revision: number;
  preferences: AgentPreference[];
}

/**
 * One GUI adaptation the agent just withdrew, because the preference that
 * justified it is gone. Present only on the snapshot that follows a removal.
 */
export interface AgentRevokedAdaptation {
  stage: string;
  filters: Array<{ field: string; operator: string; value: unknown }>;
  clearHighlight: boolean;
}

/** Mirrors `Preference` in the agent runtime. */
export interface AgentPreference {
  id: string;
  description: string;
  strength: 'hard' | 'soft';
  relevantStages: string[];
}

export interface AgentConflictScope {
  stage: string;
  movie?: string;
  theater?: string;
  date?: string;
  showing?: string;
}

export interface AgentDeadEnd {
  id: string;
  preferenceIds: string[];
  scope: AgentConflictScope;
  reason: string;
  createdAt: string;
  lastSeenAt: string;
  count: number;
}

export interface AgentAttemptedBranch {
  stage: string;
  parentContextKey: string;
  itemId: string;
  createdAt: string;
  reason?: string;
}

export interface AgentStageBinding {
  stage: string;
  parentContextKey: string;
  filters: Array<{
    field: string;
    operator: string;
    value: unknown;
    preferenceIds: string[];
  }>;
  highlight: {
    itemIds: string[];
    coverage: 'full' | 'partial';
    preferenceIds: string[];
  } | null;
  updatedAt: string;
}

export interface AgentPendingConflict {
  preferenceIds: string[];
  description: string;
  scope: AgentConflictScope;
  createdAt: string;
}

/**
 * Payload of the `agent.memory` envelope — the agent's preference memory and
 * workflow-navigation state, which the demo renders instead of hiding.
 */
export interface AgentMemorySnapshot {
  updatedAt: string;
  reason: string;
  stage: string | null;
  preferences: AgentPreference[];
  deadEnds: AgentDeadEnd[];
  attemptedBranches: AgentAttemptedBranch[];
  committedWorkflow: Record<string, unknown> | null;
  pendingConflict: AgentPendingConflict | null;
  backtrackContinuation: { targetStage: string } | null;
  stageBindings: AgentStageBinding[];
  /** Removed by hand this session; restorable from the panel. */
  forgottenPreferences: AgentPreference[];
  /** An instruction to un-apply, not state. Empty on every other snapshot. */
  revokedAdaptations: AgentRevokedAdaptation[];
}

/**
 * What a second surface may ask the booking window to do on its behalf.
 *
 * The mirror never talks to the relay. It asks the booking window, which owns
 * the socket, to send on its behalf — so the write still leaves from the one
 * place that was ever allowed to write, and the relay's rule that a viewer
 * connection is read-only stays exactly as it is.
 *
 * Two surfaces send these, over two different transports, and both stop at the
 * host:
 *   - the second-screen mirror, over BroadcastChannel (same machine);
 *   - the paired phone, as `companion.memory.command` over the relay.
 *
 * Neither is an escalation. The mirror is another window on the operator's own
 * machine, where whoever has it can already drive the booking UI; the phone
 * already holds the microphone, so it can already create and retract
 * preferences by speaking. A read-only VIEWER gets none of this and is refused
 * on every outbound frame by the relay itself.
 */
export type MemoryCommand =
  | { kind: 'preference.delete'; preferenceId: string }
  | { kind: 'preference.restore'; preferenceId: string }
  | { kind: 'preference.clear' }
  | { kind: 'profile.load'; presetId: string };

/** Untrusted on both transports, so every field is re-checked here. */
export function parseMemoryCommand(value: unknown): MemoryCommand | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const read = (key: string): string =>
    typeof record[key] === 'string' ? (record[key] as string).trim() : '';

  switch (record.kind) {
    case 'preference.delete':
    case 'preference.restore': {
      const preferenceId = read('preferenceId');
      return preferenceId ? { kind: record.kind, preferenceId } : null;
    }
    case 'preference.clear':
      return { kind: 'preference.clear' };
    case 'profile.load': {
      const presetId = read('presetId');
      return presetId ? { kind: 'profile.load', presetId } : null;
    }
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asScope(value: unknown): AgentConflictScope | null {
  const scope = asRecord(value);
  if (!scope) return null;
  return {
    stage: asString(scope.stage),
    ...(typeof scope.movie === 'string' ? { movie: scope.movie } : {}),
    ...(typeof scope.theater === 'string' ? { theater: scope.theater } : {}),
    ...(typeof scope.date === 'string' ? { date: scope.date } : {}),
    ...(typeof scope.showing === 'string' ? { showing: scope.showing } : {}),
  };
}

/**
 * The device roster, as the demo-only `relay.devices` envelope carries it.
 *
 * Deliberately separate from `relay.presence`: that payload is written verbatim
 * to the study relay log, so it cannot grow a field for a booth feature.
 */
export interface DeviceRosterPayload {
  kioskActive: boolean;
  agentCount: number;
  agents: Array<{ id: string; name: string }>;
  viewerCount: number;
  /** Outside `companion` so both survive the slot emptying. */
  companionAttachCount: number;
  companionMissingForMs: number | null;
  companion: { lastSeenAgoMs: number | null } | null;
}

export function parseDeviceRoster(payload: unknown): DeviceRosterPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const companion = asRecord(record.companion);
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return {
    kioskActive: record.kioskActive === true,
    agentCount: count(record.agentCount),
    agents: (Array.isArray(record.agents) ? record.agents : [])
      .map((entry) => {
        const item = asRecord(entry);
        const id = asString(item?.id).trim();
        const name = asString(item?.name).trim();
        return id && name ? { id, name } : null;
      })
      .filter((entry): entry is { id: string; name: string } => entry !== null),
    viewerCount: count(record.viewerCount),
    companionAttachCount: count(record.companionAttachCount),
    companionMissingForMs:
      typeof record.companionMissingForMs === 'number' &&
      Number.isFinite(record.companionMissingForMs)
        ? Math.max(0, record.companionMissingForMs)
        : null,
    companion: companion
      ? {
          // Null is "never heard from", which is NOT the same as zero. Zero
          // would read as freshly seen and paint a silent phone green.
          lastSeenAgoMs:
            typeof companion.lastSeenAgoMs === 'number' && Number.isFinite(companion.lastSeenAgoMs)
              ? Math.max(0, companion.lastSeenAgoMs)
              : null,
        }
      : null,
  };
}

function asPreferenceList(value: unknown): AgentPreference[] {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const item = asRecord(entry);
      const id = asString(item?.id).trim();
      const description = asString(item?.description).trim();
      if (!id || !description) return null;
      return {
        id,
        description,
        strength: item?.strength === 'soft' ? 'soft' : 'hard',
        relevantStages: asStringArray(item?.relevantStages),
      } satisfies AgentPreference;
    })
    .filter((entry): entry is AgentPreference => entry !== null);
}

/**
 * The panel renders whatever arrives, so a malformed envelope must degrade to an
 * empty section rather than throw inside React.
 */
export function parseAgentMemorySnapshot(payload: unknown): AgentMemorySnapshot | null {
  const record = asRecord(payload);
  if (!record) return null;

  const preferences = asPreferenceList(record.preferences);
  const forgottenPreferences = asPreferenceList(record.forgottenPreferences);

  const revokedAdaptations = (
    Array.isArray(record.revokedAdaptations) ? record.revokedAdaptations : []
  )
    .map((entry) => {
      const item = asRecord(entry);
      const stage = asString(item?.stage).trim();
      if (!stage) return null;
      return {
        stage,
        filters: (Array.isArray(item?.filters) ? item.filters : [])
          .map((raw) => {
            const filter = asRecord(raw);
            const field = asString(filter?.field).trim();
            if (!field) return null;
            return { field, operator: asString(filter?.operator), value: filter?.value };
          })
          .filter((raw): raw is NonNullable<typeof raw> => raw !== null),
        clearHighlight: item?.clearHighlight === true,
      } satisfies AgentRevokedAdaptation;
    })
    .filter((entry): entry is AgentRevokedAdaptation => entry !== null);

  const deadEnds = (Array.isArray(record.deadEnds) ? record.deadEnds : [])
    .map((entry) => {
      const item = asRecord(entry);
      const id = asString(item?.id).trim();
      const reason = asString(item?.reason).trim();
      const scope = asScope(item?.scope);
      if (!id || !reason || !scope) return null;
      return {
        id,
        preferenceIds: asStringArray(item?.preferenceIds),
        scope,
        reason,
        createdAt: asString(item?.createdAt),
        lastSeenAt: asString(item?.lastSeenAt),
        count: typeof item?.count === 'number' && item.count > 0 ? Math.floor(item.count) : 1,
      } satisfies AgentDeadEnd;
    })
    .filter((entry): entry is AgentDeadEnd => entry !== null);

  const attemptedBranches = (Array.isArray(record.attemptedBranches) ? record.attemptedBranches : [])
    .map((entry) => {
      const item = asRecord(entry);
      const stage = asString(item?.stage).trim();
      const itemId = asString(item?.itemId).trim();
      if (!stage || !itemId) return null;
      return {
        stage,
        parentContextKey: asString(item?.parentContextKey),
        itemId,
        createdAt: asString(item?.createdAt),
        ...(typeof item?.reason === 'string' ? { reason: item.reason } : {}),
      } satisfies AgentAttemptedBranch;
    })
    .filter((entry): entry is AgentAttemptedBranch => entry !== null);

  const stageBindings = (Array.isArray(record.stageBindings) ? record.stageBindings : [])
    .map((entry) => {
      const item = asRecord(entry);
      const stage = asString(item?.stage).trim();
      if (!stage) return null;
      const highlight = asRecord(item?.highlight);
      return {
        stage,
        parentContextKey: asString(item?.parentContextKey),
        filters: (Array.isArray(item?.filters) ? item.filters : [])
          .map((raw) => {
            const filter = asRecord(raw);
            const field = asString(filter?.field).trim();
            if (!field) return null;
            return {
              field,
              operator: asString(filter?.operator),
              value: filter?.value,
              preferenceIds: asStringArray(filter?.preferenceIds),
            };
          })
          .filter((raw): raw is NonNullable<typeof raw> => raw !== null),
        highlight: highlight
          ? {
              itemIds: asStringArray(highlight.itemIds),
              coverage: highlight.coverage === 'partial' ? ('partial' as const) : ('full' as const),
              preferenceIds: asStringArray(highlight.preferenceIds),
            }
          : null,
        updatedAt: asString(item?.updatedAt),
      } satisfies AgentStageBinding;
    })
    .filter((entry): entry is AgentStageBinding => entry !== null);

  const pendingConflictRaw = asRecord(record.pendingConflict);
  const pendingConflictScope = asScope(pendingConflictRaw?.scope);
  const continuationRaw = asRecord(record.backtrackContinuation);
  const targetStage = asString(continuationRaw?.targetStage).trim();

  return {
    updatedAt: asString(record.updatedAt),
    reason: asString(record.reason),
    stage: typeof record.stage === 'string' ? record.stage : null,
    preferences,
    deadEnds,
    attemptedBranches,
    committedWorkflow: asRecord(record.committedWorkflow),
    pendingConflict:
      pendingConflictRaw && pendingConflictScope
        ? {
            preferenceIds: asStringArray(pendingConflictRaw.preferenceIds),
            description: asString(pendingConflictRaw.description),
            scope: pendingConflictScope,
            createdAt: asString(pendingConflictRaw.createdAt),
          }
        : null,
    backtrackContinuation: targetStage ? { targetStage } : null,
    stageBindings,
    forgottenPreferences,
    revokedAdaptations,
  };
}
