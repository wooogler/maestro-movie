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
  /** 전체 stage 메타데이터 (goal + fieldGuide). 초기화 시 한 번만 전송. */
  stageMeta?: Array<{ stage: string; goal: string; fieldGuide: string }>;
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
 * The panel renders whatever arrives, so a malformed envelope must degrade to an
 * empty section rather than throw inside React.
 */
export function parseAgentMemorySnapshot(payload: unknown): AgentMemorySnapshot | null {
  const record = asRecord(payload);
  if (!record) return null;

  const preferences = (Array.isArray(record.preferences) ? record.preferences : [])
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
  };
}
