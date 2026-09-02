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

/**
 * A preference set the host hands over before the conversation starts, so a
 * session can open with memory already in it.
 *
 * Keyed on `revision`, never on which ids happen to be missing from memory. A
 * presence-based rule would resurrect anything the visitor retracted: a
 * `snapshot.state` arrives after most successful tool calls, so a retracted
 * preference would be re-seeded within a turn of being withdrawn.
 */
export interface PreferenceProfilePayload {
  revision: number;
  preferences: Preference[];
}

/** A preference the visitor removed by hand, kept so it can be restored. */
export interface ForgottenPreference {
  preference: Preference;
  /** Case-folded description, so re-wording the same text cannot slip past. */
  descriptionKey: string;
  removedAt: string;
}

/**
 * A GUI adaptation that just lost the preference justifying it.
 *
 * The agent prunes its own filter traces when a preference goes away, but the
 * booking screen is the host's; without being told, it stays narrowed by a
 * requirement nobody holds any more. This is the host's instruction to undo
 * exactly that much and no more.
 */
export interface RevokedAdaptation {
  stage: ConflictStage;
  filters: FilterExpression[];
  clearHighlight: boolean;
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
  /**
   * The host is running a scanned quick-demo card: narrate each GUI adaptation
   * instead of leaving the screen to speak for itself. Session-fixed, and it
   * rides the snapshot for the same reason `preferenceProfile` does — the
   * snapshot is the one lane replayed after a reset, a reconnect and a respawn.
   */
  narrateAdaptations?: boolean;
  /**
   * Write the spoken sentence short instead of letting the frontend cut it.
   * Voice-mode demo sessions only; session-fixed and snapshot-borne for the
   * same reason `narrateAdaptations` is.
   */
  spokenBrevity?: boolean;
  stageMeta?: Array<{ stage: string; goal: string; fieldGuide: string }>;
  /**
   * Ride-along preference memory. This payload is the only lane the agent
   * re-requests after a reset, after a relay reconnect and after a respawn, so
   * seeding here is what makes a preloaded memory survive all three for free.
   * Absent means "no instruction", never "clear what you have".
   */
  preferenceProfile?: PreferenceProfilePayload | null;
}

export interface StateUpdatedPayload {
  source?: string;
  uiSpec: unknown | null;
  messageHistory: unknown[];
  toolSchema: ToolSchemaItem[];
  plannerCpMemoryLimit?: number;
  plannerCpEnabled?: boolean;
  guiAdaptationEnabled?: boolean;
  narrateAdaptations?: boolean;
  spokenBrevity?: boolean;
}

export interface PerceivedContext {
  sessionId: string | null;
  stage: string | null;
  uiSpec: unknown | null;
  messageHistoryTail: unknown[];
  toolSchema: ToolSchemaItem[];
  plannerCpMemoryLimit: number;
  guiAdaptationEnabled: boolean;
  narrateAdaptations: boolean;
  spokenBrevity: boolean;
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
  /** Removed by hand this session, and restorable from the panel. */
  forgottenPreferences: Preference[];
  /**
   * Only ever non-empty on the publish that immediately follows a deliberate
   * removal. It is an instruction to the host, not state: the host un-applies
   * these and the next snapshot carries none.
   */
  revokedAdaptations: RevokedAdaptation[];
}
