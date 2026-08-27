export const PROTOCOL_VERSION = 'mvp-0.2';
export const CONFLICT_STAGES = ['movie', 'theater', 'date', 'time', 'seat', 'confirm'] as const;

export interface RelayEnvelope {
  v?: string;
  type: string;
  id?: string;
  replyTo?: string;
  payload?: Record<string, unknown>;
}

export interface ToolSchemaItem {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  params?: unknown;
}

export type ConflictStage = (typeof CONFLICT_STAGES)[number];

export interface Preference {
  id: string;
  description: string;
  strength: 'hard' | 'soft';
  relevantStages: ConflictStage[];
}

export interface ConflictScope {
  stage: ConflictStage;
  movie?: string;
  theater?: string;
  date?: string;
  showing?: string;
}

export interface DeadEnd {
  id: string;
  preferenceIds: string[];
  scope: ConflictScope;
  reason: string;
  createdAt: string;
  lastSeenAt: string;
  count: number;
}

export interface ConflictMemory {
  preferenceIds: string[];
  description: string;
}

export interface BacktrackContinuation {
  targetStage: string;
}

export type FilterOperator = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'in';

export interface FilterExpression {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

export interface PreferenceBinding {
  id: string;
  strength: Preference['strength'];
}

export interface AlternativeFilterTrace {
  filter: FilterExpression;
  preferenceBindings: PreferenceBinding[];
  createdAt: string;
}

export type HighlightCoverage = 'full' | 'partial';

export interface AlternativeHighlightTrace {
  itemIds: string[];
  coverage: HighlightCoverage;
  preferenceBindings: PreferenceBinding[];
  createdAt: string;
}

export interface StageAlternativeMemory {
  stage: ConflictStage;
  parentContextKey: string;
  valueField: string;
  items: Record<string, unknown>[];
  filters: AlternativeFilterTrace[];
  highlight: AlternativeHighlightTrace | null;
  updatedAt: string;
}

export interface UserMessagePayload {
  text: string;
  stage?: string;
}

export interface SnapshotStatePayload {
  sessionId: string;
  uiSpec: unknown | null;
  messageHistory: unknown[];
  toolSchema: ToolSchemaItem[];
  plannerCpMemoryLimit?: number;
  plannerCpEnabled?: boolean;
  guiAdaptationEnabled?: boolean;
  stageMeta?: Array<{ stage: string; goal: string; fieldGuide: string }>;
}

export interface StateUpdatedPayload {
  source?: string;
  uiSpec: unknown | null;
  messageHistory: unknown[];
  toolSchema: ToolSchemaItem[];
  plannerCpMemoryLimit?: number;
  plannerCpEnabled?: boolean;
  guiAdaptationEnabled?: boolean;
}

export interface PerceivedContext {
  sessionId: string | null;
  stage: string | null;
  uiSpec: unknown | null;
  messageHistoryTail: unknown[];
  toolSchema: ToolSchemaItem[];
  plannerCpMemoryLimit: number;
  guiAdaptationEnabled: boolean;
  lastUserMessage: UserMessagePayload | null;
  lastUpdatedAt: string;
  stageMeta?: Array<{ stage: string; goal: string; fieldGuide: string }>;
}

export type PlannedActionType = 'tool.call' | 'agent.message' | 'snapshot.get' | 'session.end';

export interface PlannedAction {
  type: PlannedActionType;
  reason: string;
  payload: Record<string, unknown>;
}

export interface PlanDecision {
  action: PlannedAction | null;
  explainText?: string;
  conflictMemory?: ConflictMemory | null;
  backtrackContinuation?: BacktrackContinuation | null;
  actionPreferenceIds?: string[] | null;
  actionHighlightCoverage?: HighlightCoverage | null;
  source: 'llm' | 'rule';
  fallbackReason?: string;
}

export interface ActionOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  uiSpec?: unknown;
  replan: boolean;
}



export interface AttemptedBranch {
  stage: ConflictStage;
  parentContextKey: string;
  itemId: string;
  createdAt: string;
  reason?: string;
}

export interface EpisodicRecord {
  timestamp: string;
  stage: string | null;
  actionType: PlannedActionType;
  ok: boolean;
  code?: string;
  reason: string;
}

/**
 * One filter the agent applied to a stage, together with the preferences that
 * justified it. The demo memory panel draws the arrow from a preference chip to
 * the GUI adaptation it caused; this is the data behind that arrow.
 */
export interface StageFilterBinding {
  field: string;
  operator: FilterOperator;
  value: unknown;
  preferenceIds: string[];
}

export interface StageHighlightBinding {
  itemIds: string[];
  coverage: HighlightCoverage;
  preferenceIds: string[];
}

export interface StageBinding {
  stage: ConflictStage;
  parentContextKey: string;
  filters: StageFilterBinding[];
  highlight: StageHighlightBinding | null;
  updatedAt: string;
}

export interface PendingConflictSnapshot {
  preferenceIds: string[];
  description: string;
  scope: ConflictScope;
  createdAt: string;
}

/**
 * Payload of the `agent.memory` envelope: everything the agent knows about the
 * user that is otherwise invisible to them. Sent to the host so the demo can
 * render preference memory and workflow navigation instead of leaving both
 * mechanisms buried in the planner.
 */
export interface AgentMemorySnapshot {
  updatedAt: string;
  /** Why this snapshot was published — useful when reading a relay log. */
  reason: string;
  stage: string | null;
  preferences: Preference[];
  deadEnds: DeadEnd[];
  attemptedBranches: AttemptedBranch[];
  committedWorkflow: Record<string, unknown> | null;
  pendingConflict: PendingConflictSnapshot | null;
  backtrackContinuation: BacktrackContinuation | null;
  stageBindings: StageBinding[];
}
