import {
  isOpenAiAuthError,
  planActionWithOpenAI,
  type PlannerWorkflow,
  type PlannerWorkflowMemory,
} from '../llm/llmPlanner';
import { resolveOpenAiApiKey } from '../llm/openaiKey';
import { refreshModelEnvVars } from './envRefresh';
import { agentNotice } from './agentNotices';
import type { AgentMemory } from './memory';
import { isSelectableItem } from './filterSimulation';
import { isProfilePreferenceId } from './cpMemory';
import {
  getEnabledVisibleItems,
  getHighlightedIds,
  getSelectedId,
  getSelectedListIds,
  toUISpecLike,
  type UISpecLike,
} from './uiModel';
import {
  buildWorkflowSelectionState,
  getWorkflowParentContextKey,
  getWorkflowSelectionId,
  WORKFLOW_STAGE_ORDER,
  type WorkflowStage,
} from './workflowState';
import type {
  BacktrackContinuation,
  ConflictMemory,
  DeadEnd,
  PerceivedContext,
  PlanDecision,
  PlannedAction,
  Preference,
  ToolSchemaItem,
} from '../types';

type Stage = WorkflowStage;
const STAGE_ORDER = WORKFLOW_STAGE_ORDER;

const RAW_SCAN_WINDOW = 24;
const RECENT_WINDOW = 8;
const MAX_HISTORY_ENTRIES = 12;

type HistoryMessageType = 'system' | 'user' | 'agent';

interface CompactedHistoryEntry {
  index: number;
  type: HistoryMessageType;
  value: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

function toHistoryType(value: unknown): HistoryMessageType | null {
  const type = readTrimmedString(value);
  if (type === 'system' || type === 'user' || type === 'agent') return type;
  return null;
}

/**
 * Is a filter applied to this stage at all?
 *
 * Deliberately lenient: the count below never evaluates the conditions, so a
 * malformed entry must still gate the field ON. Dropping it would fail toward
 * exactly the silence this exists to fix. The spec type is
 * `FilterState | FilterState[]` (frontend spec/types.ts); applyFilter only ever
 * writes the array form, but the single form is legal.
 */
function hasActiveFilter(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => asRecord(entry) !== null);
  return asRecord(value) !== null;
}

function compactVisibleItems(
  value: unknown
): Array<{ id: string; value: string; isDisabled?: true }> {
  if (!Array.isArray(value)) return [];
  const compacted: Array<{ id: string; value: string; isDisabled?: true }> = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const id = readTrimmedString(record.id);
    const itemValue = readTrimmedString(record.value);
    if (!id || !itemValue) continue;
    if (record.isDisabled === true) continue;
    compacted.push({ id, value: itemValue });
  }
  return compacted;
}

function compactSystemSpec(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;

  const stage = readTrimmedString(record.stage);
  const state = asRecord(record.state);
  const selectedRaw = asRecord(state?.selected);
  const selectedId = selectedRaw ? readTrimmedString(selectedRaw.id) : null;
  const selectedValue = selectedRaw ? readTrimmedString(selectedRaw.value) : null;
  const selectedListCount =
    state && Array.isArray(state.selectedList) ? state.selectedList.length : 0;
  const modification = asRecord(record.modification);
  const summary: Record<string, unknown> = {};
  const rawVisibleItems = Array.isArray(record.visibleItems) ? record.visibleItems : [];
  const visibleItems = compactVisibleItems(rawVisibleItems);

  if (stage) summary.stage = stage;
  if (visibleItems.length > 0) {
    summary.visibleItems = visibleItems;
  }
  if (rawVisibleItems.length > visibleItems.length) {
    summary.disabledItemCount = rawVisibleItems.length - visibleItems.length;
  }
  if (selectedId && selectedValue) {
    summary.selected = { id: selectedId, value: selectedValue };
  }
  if (selectedListCount > 0) {
    summary.selectedListCount = selectedListCount;
  }
  if (modification && Object.keys(modification).length > 0) {
    // Replace augment array with boolean — display values are already in visibleItems.
    const compactMod: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(modification)) {
      compactMod[key] = key === 'augment' ? true : val;
    }
    summary.modification = compactMod;
  }

  // Preserve confirm stage meta (booking summary) so the planner can see it
  if (stage === 'confirm' && record.meta && typeof record.meta === 'object') {
    summary.meta = record.meta;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function compactAnnotation(
  value: unknown,
  includeReason: boolean
): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;

  const kind = readTrimmedString(record.kind);
  const toolName = readTrimmedString(record.toolName);
  const source = readTrimmedString(record.source);
  const reason = includeReason ? readTrimmedString(record.reason) : null;

  const summary: Record<string, unknown> = {};
  if (kind) summary.kind = kind;
  if (toolName) summary.toolName = toolName;
  if (source) summary.source = source;
  if (reason) summary.reason = reason;

  return Object.keys(summary).length > 0 ? summary : null;
}

function compactAgentText(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (toHistoryType(record.type) !== 'agent') return null;
  return readTrimmedString(record.text);
}

function compactHistoryEntry(
  entry: unknown,
  linkedAgentText?: string | null
): { type: HistoryMessageType; value: Record<string, unknown> } | null {
  const record = asRecord(entry);
  if (!record) return null;

  const type = toHistoryType(record.type);
  if (!type) return null;

  const compacted: Record<string, unknown> = { type };
  const stage = readTrimmedString(record.stage);
  if (stage) compacted.stage = stage;

  if (type === 'user') {
    const action = readTrimmedString(record.action);
    const label = readTrimmedString(record.label);
    if (action) compacted.action = action;
    if (label) compacted.label = label;
    if (!action && !label) return null;
    return { type, value: compacted };
  }

  if (type === 'agent') {
    const text = readTrimmedString(record.text);
    if (!text) return null;
    compacted.text = text;
    return { type, value: compacted };
  }

  const compactedSpec = compactSystemSpec(record.spec);
  const annotation = compactAnnotation(record.annotation, !linkedAgentText);
  if (compactedSpec) compacted.spec = compactedSpec;
  if (linkedAgentText) compacted.linkedAgentText = linkedAgentText;
  if (annotation) compacted.annotation = annotation;
  if (!compactedSpec && !annotation && !stage) return null;
  return { type, value: compacted };
}

function getLatestCompactedByType(
  entries: CompactedHistoryEntry[],
  targetType: HistoryMessageType,
): CompactedHistoryEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].type === targetType) return entries[i];
  }
  return null;
}

function hasTool(toolSchema: ToolSchemaItem[], toolName: string): boolean {
  return toolSchema.some((tool) => tool.name === toolName);
}

function getPlannerToolSchema(
  toolSchema: ToolSchemaItem[],
  lastAgentToolName?: string | null,
  suppressNavigationTools?: boolean,
  keepSelectAfterGuiStep?: boolean,
  keepSelectAtStageEntry?: boolean
): ToolSchemaItem[] {
  // Treat conversational text as assistant response (agent.message), not as a UI tool.
  const plannerTools = toolSchema.filter((tool) => tool.name !== 'postMessage');
  const lastAction = (lastAgentToolName ?? '').trim();
  const restrictNavigation = (tools: ToolSchemaItem[]): ToolSchemaItem[] =>
    suppressNavigationTools === true
      ? tools.filter((tool) => tool.name !== 'prev' && tool.name !== 'next')
      : tools;
  if (!lastAction) return restrictNavigation(plannerTools);

  const guiFollowUpTools = new Set(['augment', 'filter', 'sort', 'highlight', 'clearModification']);
  // Booth demo only, and only in a chain the visitor's own utterance opened:
  // "I want the closest theater" must augment first (the visibility gate) and
  // may then select, in the same turn, the one option that leaves. Never after
  // next — stage entry stays a consent boundary, the visitor has not spoken
  // there yet — and never after highlight, which is the step that points
  // rather than commits.
  const guiThenCommitTools = keepSelectAfterGuiStep || keepSelectAtStageEntry
    ? new Set([...guiFollowUpTools, 'select', 'selectMultiple'])
    : guiFollowUpTools;
  // Booth demo only (see keepSelectAtDateEntry): the one stage entry where the
  // visitor's consent was given earlier, by naming the day.
  const stageEntryTools = keepSelectAtStageEntry
    ? new Set([...guiFollowUpTools, 'select'])
    : guiFollowUpTools;

  switch (lastAction) {
    case 'select':
    case 'selectMultiple':
      return restrictNavigation(plannerTools.filter((tool) => tool.name === 'next'));
    case 'next':
      return restrictNavigation(plannerTools.filter((tool) => stageEntryTools.has(tool.name)));
    case 'highlight':
      return restrictNavigation([]);
    case 'augment':
    case 'filter':
    case 'sort':
    case 'clearModification':
      return restrictNavigation(plannerTools.filter((tool) => guiThenCommitTools.has(tool.name)));
    default:
      return restrictNavigation(plannerTools);
  }
}

/**
 * Did the visitor's own words open the chain of planner calls now running at
 * this stage? True when, walking the host's history back from the end, the
 * first thing that is not an agent sentence or an agent tool annotation at this
 * stage is a user utterance at this stage. A stage-entry entry (a system entry
 * for this stage with no annotation) or anything from another stage means the
 * chain began with the agent's own next or prev, where the visitor has said
 * nothing yet and select stays withheld.
 */
export function chainOpenedByUserUtterance(messageHistory: unknown[], stage: string | null): boolean {
  if (!stage) return false;
  for (let i = messageHistory.length - 1; i >= 0; i -= 1) {
    const entry = asRecord(messageHistory[i]);
    if (!entry) continue;
    const type = toHistoryType(entry.type);
    const entryStage = readTrimmedString(entry.stage);
    if (type === 'agent') continue;
    if (entryStage !== stage) return false;
    if (type === 'user') return Boolean(readTrimmedString(entry.label));
    if (type === 'system') {
      if (compactAnnotation(entry.annotation, true)) continue;
      return false;
    }
  }
  return false;
}

function toStage(raw: string | null): Stage | null {
  switch (raw) {
    case 'movie':
    case 'theater':
    case 'date':
    case 'time':
    case 'seat':
    case 'confirm':
      return raw;
    default:
      return null;
  }
}

function toolCall(toolName: string, params: Record<string, unknown>, reason: string): PlannedAction {
  return {
    type: 'tool.call',
    reason,
    payload: {
      toolName,
      params,
      reason,
    },
  };
}

function containsBookingConfirmed(messages: unknown[]): boolean {
  const tail = messages.slice(-10);
  return tail.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    const label = typeof record.label === 'string' ? record.label : '';
    return type === 'user' && label.toLowerCase().includes('booking confirmed');
  });
}

function stageTransition(stage: Stage): { previousStage: Stage | null; nextStage: Stage | null } {
  const index = STAGE_ORDER.indexOf(stage);
  if (index < 0) return { previousStage: null, nextStage: null };
  return {
    previousStage: index > 0 ? STAGE_ORDER[index - 1] : null,
    nextStage: index < STAGE_ORDER.length - 1 ? STAGE_ORDER[index + 1] : null,
  };
}

function buildSeatLayoutMeta(items: unknown[]): Record<string, unknown> | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const rows = new Set<string>();
  let maxCol = 0;
  for (const rawItem of items) {
    const item = asRecord(rawItem);
    if (!item) continue;
    const row = readTrimmedString(item.row);
    const col = typeof item.number === 'number' ? item.number : 0;
    if (row) rows.add(row);
    if (col > maxCol) maxCol = col;
  }
  if (rows.size === 0 || maxCol === 0) return null;
  return {
    rows: Array.from(rows).sort(),
    seatsPerRow: maxCol,
    totalSeats: items.length,
  };
}

/**
 * The booth demo is the only mode that gets `currentView.booking` and the
 * demo prompt section. Read from the supervisor's env rather than passed
 * through the host, like the rest of the agent's mode switches: a study
 * session's planner input stays byte-identical to what C1-C4 recorded.
 */
const DEMO_SESSION = process.env.AGENT_STUDY_MODE === 'demo';

/**
 * One entry of `workflow.priorStageAlternativeCounts`. The count is taken with
 * the stage's hard-bound filters re-applied, and nothing else: a hard
 * preference that never became a filter there (Thursday, selected by name) is
 * not in it. A study session gets `{ stage, count }` exactly as before; the
 * booth also gets `uncheckedHardPreferenceIds`, so the planner can see that
 * "date: 5" means five days exist, not five the visitor would accept. That is
 * what sent card B back to change a day the visitor had named (2026-10-24).
 */
interface PriorStageAlternativeCount {
  stage: WorkflowStage;
  count: number;
  uncheckedHardPreferenceIds?: string[];
}

/**
 * The confirm stage has no items: what the visitor sees is a summary card,
 * and the host ships its content in `spec.meta` (ConfirmMeta in the frontend's
 * spec/generators.ts). `buildCurrentView` never read it, so the planner was
 * handed `{ stage: "confirm" }` and, on 2026-10-18, told a visitor it could
 * not verify a booking it had just assembled. This is that card, flattened.
 */
function buildConfirmBooking(rawSpec: Record<string, unknown>): Record<string, unknown> | null {
  const meta = asRecord(rawSpec.meta);
  if (!meta) return null;
  const movie = asRecord(meta.movie);
  const theater = asRecord(meta.theater);
  const booking: Record<string, unknown> = {};
  const title = movie ? readTrimmedString(movie.title) : null;
  const theaterName = theater ? readTrimmedString(theater.name) : null;
  const date = readTrimmedString(meta.date);
  const time = readTrimmedString(meta.time);
  if (title) booking.movie = title;
  if (theaterName) booking.theater = theaterName;
  if (date) booking.date = date;
  if (time) booking.time = time;
  const seats = normalizeStringArray(meta.seats);
  if (seats.length > 0) booking.seats = seats;
  if (typeof meta.totalPrice === 'number' && Number.isFinite(meta.totalPrice)) {
    booking.totalPrice = meta.totalPrice;
  }
  if (typeof meta.bookingId === 'string' && meta.bookingId.trim()) booking.completed = true;
  return Object.keys(booking).length > 0 ? booking : null;
}

function buildCurrentView(spec: UISpecLike): Record<string, unknown> | null {
  const rawSpec = asRecord(spec as unknown);
  if (!rawSpec) return null;

  const state = asRecord(rawSpec.state);
  const modification = asRecord(rawSpec.modification);
  const selectedId = getSelectedId(spec);
  const selectedValue = readTrimmedString(state?.selected && asRecord(state.selected)?.value);
  const selectedListIds = getSelectedListIds(spec);
  const highlightedIds = Array.from(
    new Set([
      ...normalizeStringArray(asRecord(modification?.highlight)?.itemIds),
      ...getHighlightedIds(spec),
    ])
  ).sort();
  const visibleItems = compactVisibleItems(rawSpec.visibleItems);
  const summary: Record<string, unknown> = {
    stage: spec.stage ?? null,
  };

  if (visibleItems.length > 0) {
    summary.visibleItems = visibleItems;
  }
  if (DEMO_SESSION && spec.stage === 'confirm') {
    const booking = buildConfirmBooking(rawSpec);
    if (booking) summary.booking = booking;
  }
  const rawVisibleItems = Array.isArray(rawSpec.visibleItems) ? rawSpec.visibleItems.length : 0;
  if (rawVisibleItems > visibleItems.length) {
    summary.disabledItemCount = rawVisibleItems - visibleItems.length;
  }
  // How many selectable options the active filter is holding back.
  //
  // The planner already receives both `items` (the stage inventory) and
  // `visibleItems` (what survived the filter), so it could difference them. It
  // did not: across the study 82 turns re-entered a filtered stage after a
  // backtrack, and in 26 of them the agent called the short list the only
  // options left. One integer is cheaper than expecting the model to notice.
  //
  // Differenced against the host's own visibleItems rather than re-run through
  // filterSimulation: visibleItems IS the filter's output (computeDisplayItems
  // in frontend spec/modifiers.ts filters, then sorts and augments, neither of
  // which changes the length), so this cannot drift from the screen, and it
  // needs no display.valueField — which the agent's UISpecLike does not carry.
  //
  // `items` is the wrong left-hand side at any stage whose inventory holds
  // entries that were never selectable: the date stage ships `available: false`
  // days and the seat stage ships occupied seats. So the left side is the
  // selectable inventory, the same predicate compactVisibleItems applies on the
  // right, and non-selectable entries cancel at every stage.
  if (hasActiveFilter(modification?.filter)) {
    const rawItems = Array.isArray(rawSpec.items) ? rawSpec.items : [];
    const selectableInventory = rawItems.filter((item) => {
      const record = asRecord(item);
      return record !== null && isSelectableItem(record);
    }).length;
    const hiddenByFilterCount = selectableInventory - visibleItems.length;
    // Emitted only when something is actually hidden: every prompt rule keyed
    // to this field reads its presence as "options are behind the filter", and
    // a zero would fire all of them on a filter that hides nothing.
    if (hiddenByFilterCount > 0) {
      summary.hiddenByFilterCount = hiddenByFilterCount;
    }
  }
  if (selectedId) {
    summary.selected = selectedValue ? { id: selectedId, value: selectedValue } : { id: selectedId };
  }
  if (selectedListIds.length > 0) {
    summary.selectedListIds = selectedListIds;
  }
  if (highlightedIds.length > 0) {
    summary.highlightedIds = highlightedIds;
  }
  // Keep non-highlight modifications (filter, sort, augment).
  // For augment, the display values are already in visibleItems — just note it was applied.
  if (modification) {
    const other: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(modification)) {
      if (key === 'highlight') continue;
      other[key] = key === 'augment' ? true : val;
    }
    if (Object.keys(other).length > 0) {
      summary.modification = other;
    }
  }
  // Item details for current stage
  const items = Array.isArray(rawSpec.items) ? rawSpec.items : [];
  if (items.length > 0) {
    const seatLayout = buildSeatLayoutMeta(items);
    if (seatLayout) {
      // Seat stage: layout meta + available seats only
      summary.seatLayout = seatLayout;
      summary.items = (items as Record<string, unknown>[])
        .filter((item) => item && asRecord(item)?.status === 'available')
        .map((item) => {
          const { showingId: _s, label: _l, status: _st, ...rest } = item as Record<string, unknown>;
          return rest;
        });
    } else {
      // Other stages: include all items
      summary.items = items;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}


// `seat: 'seats'` used to be here, but nothing ever wrote a `seats` key —
// `buildConflictScope` only records movie/theater/date/showing. Across the whole
// study corpus the key appeared 0 times in 2,521 dead ends, while 59.7% of dead
// ends were recorded at the seat stage. Every one of them was unmatchable.
const STAGE_SCOPE_KEY: Record<string, string> = { time: 'showing' };

/**
 * The stage at which a dead end excludes options.
 *
 * A conflict discovered at the seat stage means the SHOWING cannot be used —
 * seats are not chosen from a list that survives a backtrack, the showtime is.
 * So it is enforced one stage up, against `scope.showing`.
 *
 * Everything else is enforced where it was found.
 */
export function deadEndBlacklistStage(deadEnd: DeadEnd): string {
  return deadEnd.scope.stage === 'seat' ? 'time' : deadEnd.scope.stage;
}

const STAGE_PARENT_SCOPE_KEYS: Record<string, string[]> = Object.fromEntries(
  STAGE_ORDER.map((stage, i) =>
    [stage, STAGE_ORDER.slice(0, i).map((s) => STAGE_SCOPE_KEY[s] ?? s)],
  ),
);

function resolveStateScopeValue(
  state: Record<string, unknown>,
  scopeKey: string,
): string | null {
  const entry = asRecord(state[scopeKey]);
  if (!entry) return null;
  return (
    readTrimmedString(entry.title) ??
    readTrimmedString(entry.name) ??
    readTrimmedString(entry.date) ??
    readTrimmedString(entry.id) ??
    null
  );
}

function isDeadEndRelevant(
  deadEnd: DeadEnd,
  stage: string,
  state: Record<string, unknown> | null,
): boolean {
  if (!state) return true;
  const parentKeys = STAGE_PARENT_SCOPE_KEYS[stage] ?? [];
  const scope = deadEnd.scope as unknown as Record<string, unknown>;

  for (const key of parentKeys) {
    const scopeValue = typeof scope[key] === 'string' ? (scope[key] as string) : null;
    if (!scopeValue) continue;
    const stateValue = resolveStateScopeValue(state, key);
    if (!stateValue) continue;
    if (scopeValue !== stateValue) return false;
  }
  return true;
}

export function findDeadEndItemIds(
  items: Record<string, unknown>[],
  deadEnds: DeadEnd[],
  stage: string,
  state: Record<string, unknown> | null,
): string[] {
  const scopeKey = STAGE_SCOPE_KEY[stage] ?? stage;
  // A dead end applies only where its own choice is made. Without this gate a
  // dead end carries its whole ancestor path — movie, theater, date, showing —
  // and gets matched at every one of those stages, so a seat that did not work
  // out blacklisted the movie. In the study 574 of 960 (dead end, turn) pairs
  // projected two or more stages upward, blacklisting the movie itself in 126
  // turns across 28 sessions.
  const relevantDeadEnds = deadEnds.filter(
    (de) => deadEndBlacklistStage(de) === stage && isDeadEndRelevant(de, stage, state)
  );
  const deadEndValues = new Set<string>();
  for (const de of relevantDeadEnds) {
    const scope = de.scope as unknown as Record<string, unknown>;
    const val = typeof scope[scopeKey] === 'string' ? (scope[scopeKey] as string) : null;
    if (val) deadEndValues.add(val);
  }
  if (deadEndValues.size === 0) return [];

  const ids: string[] = [];
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id) continue;
    for (const v of Object.values(item)) {
      if (typeof v === 'string' && deadEndValues.has(v)) {
        ids.push(id);
        break;
      }
    }
  }
  return ids;
}

function buildWorkflowContext(
  context: PerceivedContext,
  stage: Stage,
  spec: UISpecLike,
  plannerTools: ToolSchemaItem[],
  cpMemoryEnabled: boolean,
  workflowState: Record<string, unknown> | null,
  deadEnds: DeadEnd[],
  priorStageAlternativeCounts: PriorStageAlternativeCount[],
  backtrackContinuation: BacktrackContinuation | null
): PlannerWorkflow {
  const selectedId = getSelectedId(spec);
  const selectedListCount = getSelectedListIds(spec).length;
  const canNext = hasTool(plannerTools, 'next');
  const { previousStage, nextStage } = stageTransition(stage);
  let proceedRule = 'Only advance stage when required selections are complete.';

  if (stage === 'seat') {
    proceedRule =
      `Use select for a single-seat toggle, or selectMultiple to replace the full selected seat set. ` +
      `Call next only if selectedListCount > 0 (current: ${selectedListCount}).`;
  } else if (stage === 'confirm') {
    const bookingConfirmed = containsBookingConfirmed(context.messageHistoryTail);
    proceedRule = bookingConfirmed
      ? 'Booking confirmation detected; end session.'
      : `Submit confirmation when ready (next available: ${String(canNext)}).`;
  } else {
    proceedRule = `Call next only when selectedId exists (current: ${selectedId ?? 'null'}).`;
  }

  const currentView = buildCurrentView(spec);

  if (cpMemoryEnabled && currentView && Array.isArray(currentView.items) && deadEnds.length > 0) {
    const deadEndIds = findDeadEndItemIds(currentView.items as Record<string, unknown>[], deadEnds, stage, workflowState ?? null);
    if (deadEndIds.length > 0) currentView.deadEndItemIds = deadEndIds;
  }

  const workflow: PlannerWorkflow = {
    currentStage: stage,
    previousStage,
    nextStage,
    proceedRule,
    availableToolNames: [...plannerTools.map((tool) => tool.name), 'respond'],
    guiAdaptationEnabled: context.guiAdaptationEnabled,
    ...(workflowState ? { state: workflowState } : {}),
    ...(currentView ? { currentView } : {}),
    ...(cpMemoryEnabled && backtrackContinuation ? { backtrackContinuation } : {}),
    ...(cpMemoryEnabled && priorStageAlternativeCounts.length > 0 ? { priorStageAlternativeCounts } : {}),
    cpMemoryEnabled,
  };

  return workflow;
}

function getSystemEntrySignature(entry: CompactedHistoryEntry): string | null {
  if (entry.type !== 'system') return null;
  const spec = asRecord(entry.value.spec);
  if (!spec) return null;
  const stage = readTrimmedString(entry.value.stage) ?? readTrimmedString(spec.stage) ?? '';
  return JSON.stringify({ stage, spec });
}

function collapseRedundantSystemEntries(entries: CompactedHistoryEntry[]): CompactedHistoryEntry[] {
  const collapsed: CompactedHistoryEntry[] = [];

  for (const entry of entries) {
    const previous = collapsed[collapsed.length - 1];
    const previousSignature = previous ? getSystemEntrySignature(previous) : null;
    const currentSignature = getSystemEntrySignature(entry);

    if (previous && previousSignature && currentSignature && previousSignature === currentSignature) {
      collapsed[collapsed.length - 1] = entry;
      continue;
    }

    collapsed.push(entry);
  }

  return collapsed;
}

/**
 * Booth demo only: may the planner select at the date stage's entry, before
 * the visitor has said anything there? Yes when memory holds a hard date
 * preference the visitor stated in this session (a `pref_` id, from the
 * extractor) — "오늘 밤에", "목요일 밤에" in the opener. Without it the stage
 * entry stays a consent boundary, and the 2026-10-24 simulation asked "목요일로
 * 할까요?" about a day the visitor had named in 10 of 10 runs. Only the date
 * stage: a day is the one thing an opener reliably names for a later stage,
 * and widening the theater or time entry would let a preference like "close
 * to downtown" pick a cinema before the visitor's own distance limit arrives.
 * A profile-seeded (`prf_`) preference never counts: it was never said, and
 * DECISIVE_SELECTION_RULES (6) asks about it instead.
 */
export function keepSelectAtDateEntry(stage: string | null, preferences: Preference[]): boolean {
  return (
    stage === 'date' &&
    preferences.some(
      (preference) =>
        preference.strength === 'hard' &&
        preference.relevantStages.includes('date') &&
        !isProfilePreferenceId(preference.id)
    )
  );
}

function buildPlannerHistory(
  context: PerceivedContext,
  cpMemoryEnabled: boolean,
  currentStage?: string,
): unknown[] {
  // CP memory OFF: full history. CP memory ON: windowed scan.
  const rawHistory = cpMemoryEnabled
    ? context.messageHistoryTail.slice(-RAW_SCAN_WINDOW)
    : context.messageHistoryTail.slice();

  const compacted: CompactedHistoryEntry[] = [];
  for (let i = 0; i < rawHistory.length; i += 1) {
    const rawEntry = rawHistory[i];
    const current = asRecord(rawEntry);
    if (!current) continue;

    const currentType = toHistoryType(current.type);
    const currentStage = readTrimmedString(current.stage);
    let linkedAgentText: string | null = null;

    if (currentType === 'system') {
      const next = asRecord(rawHistory[i + 1]);
      const nextType = next ? toHistoryType(next.type) : null;
      const nextStage = next ? readTrimmedString(next.stage) : null;
      const hasAnnotation = Boolean(compactAnnotation(current.annotation, true));
      if (hasAnnotation && nextType === 'agent' && currentStage && nextStage === currentStage) {
        linkedAgentText = compactAgentText(next);
        if (linkedAgentText) {
          i += 1;
        }
      }
    }

    const normalized = compactHistoryEntry(rawEntry, linkedAgentText);
    if (!normalized) continue;
    compacted.push({
      index: i,
      type: normalized.type,
      value: normalized.value,
    });
  }

  const collapsed = collapseRedundantSystemEntries(compacted);

  if (collapsed.length === 0) return [];

  // Strip spec from current-stage system entries — currentView is authoritative.
  // Keep annotation + linkedAgentText so the planner knows what tools were applied.
  if (currentStage) {
    for (const entry of collapsed) {
      if (entry.type === 'system') {
        const stage = readTrimmedString(entry.value.stage);
        if (stage === currentStage && entry.value.spec) {
          delete entry.value.spec;
        }
      }
    }
  }

  if (!cpMemoryEnabled) {
    return collapsed.map((entry) => entry.value);
  }

  const selectedByIndex = new Map<number, CompactedHistoryEntry>();
  for (const entry of collapsed.slice(-RECENT_WINDOW)) {
    selectedByIndex.set(entry.index, entry);
  }
  for (const type of ['system', 'user', 'agent'] as const) {
    const latest = getLatestCompactedByType(collapsed, type);
    if (latest) selectedByIndex.set(latest.index, latest);
  }
  const ordered = Array.from(selectedByIndex.values()).sort((a, b) => a.index - b.index);
  return ordered.slice(-MAX_HISTORY_ENTRIES).map((entry) => entry.value);
}

function sliceRecent<T>(list: T[], maxItems: number): T[] {
  if (!Number.isFinite(maxItems) || maxItems <= 0) return [];
  const limit = Math.floor(maxItems);
  if (limit <= 0) return [];
  return list.slice(-limit);
}

function findItemIdByValue(
  items: Record<string, unknown>[],
  value: string | null,
): string | null {
  if (!value) return null;
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id) continue;
    for (const v of Object.values(item)) {
      if (typeof v === 'string' && v === value) return id;
    }
  }
  return null;
}

function buildPlannerMemory(
  preferences: Preference[],
  deadEnds: DeadEnd[],
  plannerCpMemoryLimit: number
): PlannerWorkflowMemory | null {
  if (!Number.isFinite(plannerCpMemoryLimit) || plannerCpMemoryLimit <= 0) {
    return null;
  }

  const limitedDeadEnds = plannerCpMemoryLimit > 0 ? sliceRecent(deadEnds, plannerCpMemoryLimit) : [];
  if (preferences.length === 0 && limitedDeadEnds.length === 0) {
    return null;
  }

  const compactDeadEnds = limitedDeadEnds.map(({ preferenceIds, scope, reason }) => ({
    preferenceIds,
    scope,
    reason,
  }));

  return {
    preferences,
    deadEnds: compactDeadEnds,
  };
}

function validateLlmAction(
  spec: UISpecLike,
  allowedTools: ToolSchemaItem[],
  decision: {
    assistantMessage: string;
    conflictMemory?: ConflictMemory | null;
    backtrackContinuation?: BacktrackContinuation | null;
    action: {
      type: 'tool.call' | 'none';
      toolName: string;
      params: Record<string, unknown>;
      reason?: string;
      preferenceIds?: string[];
      coverage?: import('../types').HighlightCoverage;
    };
  }
): PlanDecision | null {
  const explainText = decision.assistantMessage.trim() || undefined;
  if (decision.action.type === 'none') {
    return {
      action: null,
      explainText,
      conflictMemory: decision.conflictMemory ?? null,
      backtrackContinuation: null,
      actionPreferenceIds: null,
      actionHighlightCoverage: null,
      source: 'llm',
    };
  }

  const toolName = decision.action.toolName;

  if (toolName === 'postMessage') {
    const text = typeof decision.action.params.text === 'string' ? decision.action.params.text.trim() : '';
    return {
      action: {
        type: 'agent.message',
        reason: decision.action.reason ?? '',
        payload: {
          text: text || explainText || (decision.action.reason ?? ''),
          category: 'respond',
        },
      },
      explainText,
      backtrackContinuation: null,
      actionPreferenceIds: null,
      actionHighlightCoverage: null,
      source: 'llm',
    };
  }

  if (!toolName || !hasTool(allowedTools, toolName)) return null;

  const params = decision.action.params ?? {};

  if (toolName === 'select') {
    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    if (!itemId) return null;
    const selectable = new Set(getEnabledVisibleItems(spec).map((item) => item.id));
    if (!selectable.has(itemId)) return null;
    return {
      action: toolCall(toolName, { itemId }, decision.action.reason ?? ''),
      explainText,
      backtrackContinuation: null,
      actionPreferenceIds: null,
      actionHighlightCoverage: null,
      source: 'llm',
    };
  }

  if (toolName === 'selectMultiple') {
    if (spec.stage !== 'seat') return null;
    const itemIds = normalizeStringArray(params.itemIds);
    if (itemIds.length === 0) return null;
    const selectable = new Set(getEnabledVisibleItems(spec).map((item) => item.id));
    if (itemIds.some((itemId) => !selectable.has(itemId))) return null;
    return {
      action: toolCall(toolName, { itemIds }, decision.action.reason ?? ''),
      explainText,
      backtrackContinuation: null,
      actionPreferenceIds: null,
      actionHighlightCoverage: null,
      source: 'llm',
    };
  }

  return {
    action: toolCall(toolName, params, decision.action.reason ?? ''),
    explainText,
    backtrackContinuation: toolName === 'prev' ? decision.backtrackContinuation ?? null : null,
    actionPreferenceIds:
      (toolName === 'filter' || toolName === 'highlight') && Array.isArray(decision.action.preferenceIds)
        ? decision.action.preferenceIds.slice()
        : null,
    actionHighlightCoverage:
      toolName === 'highlight' && (decision.action.coverage === 'full' || decision.action.coverage === 'partial')
        ? decision.action.coverage
        : null,
    source: 'llm',
  };
}

export async function planNextAction(
  context: PerceivedContext,
  memory: AgentMemory,
  lastAgentToolName?: string | null,
  backtrackContinuation?: BacktrackContinuation | null,
  suppressNavigationTools?: boolean,
  /** Host-reported conversation language. Undefined and 'en' behave identically. */
  language?: string
): Promise<PlanDecision> {
  if (!context.sessionId) {
    return { action: null, source: 'rule', fallbackReason: 'NO_SESSION' };
  }

  const stage = toStage(context.stage);
  const spec = toUISpecLike(context.uiSpec);
  if (!stage || !spec) {
    return { action: null, source: 'rule', fallbackReason: 'INVALID_STAGE_OR_SPEC' };
  }

  const workflowState = buildWorkflowSelectionState({
    currentStage: stage,
    messageHistory: context.messageHistoryTail,
    uiSpec: context.uiSpec,
    committedState: memory.getCommittedWorkflowState(),
  });
  const deadEnds = memory.getDeadEnds();
  const currentStageIndex = STAGE_ORDER.indexOf(stage);
  const priorStageAlternativeCounts =
    currentStageIndex <= 0
      ? []
      : STAGE_ORDER.slice(0, currentStageIndex)
          .reverse()
          .map((priorStage) => {
            const parentContextKey = getWorkflowParentContextKey(priorStage, workflowState);
            if (!parentContextKey) return null;

            const stageItems = memory.getStageAlternativeItems(priorStage, parentContextKey);
            if (!stageItems) return null;

            const deadEndIds = deadEnds.length > 0
              ? findDeadEndItemIds(stageItems, deadEnds, priorStage, workflowState)
              : [];
            const selectedItemId = findItemIdByValue(stageItems, getWorkflowSelectionId(workflowState, priorStage));
            const excludeIds = new Set(deadEndIds);
            if (selectedItemId) excludeIds.add(selectedItemId);

            const count = memory.getStageAlternativeCount(priorStage, parentContextKey, excludeIds);
            if (count === null) return null;
            // Booth only (see uncheckedHardPreferenceIds in the demo conflict
            // section): name the hard requirements the count could not apply.
            if (DEMO_SESSION) {
              const applied = new Set(memory.getStageHardFilterPreferenceIds(priorStage, parentContextKey));
              const unchecked = memory
                .getPreferences()
                .filter(
                  (preference) =>
                    preference.strength === 'hard' &&
                    preference.relevantStages.includes(priorStage) &&
                    !applied.has(preference.id)
                )
                .map((preference) => preference.id);
              if (unchecked.length > 0) {
                return { stage: priorStage, count, uncheckedHardPreferenceIds: unchecked };
              }
            }
            return { stage: priorStage, count };
          })
          .filter((entry): entry is PriorStageAlternativeCount => entry !== null);

  const userRequest = context.lastUserMessage?.text ?? '';
  const hasUserRequest = Boolean(userRequest.trim());

  refreshModelEnvVars();

  const openaiEnabled =
    process.env.AGENT_ENABLE_OPENAI !== 'false' && Boolean(resolveOpenAiApiKey());

  if (!openaiEnabled) {
    return {
      action: null,
      explainText: hasUserRequest
        ? agentNotice('plannerUnavailable', language)
        : undefined,
      source: 'rule',
      fallbackReason: 'LLM_DISABLED_NO_PROVIDER',
    };
  }

  try {
    const plannerTools = getPlannerToolSchema(
      context.toolSchema,
      lastAgentToolName,
      suppressNavigationTools,
      DEMO_SESSION && chainOpenedByUserUtterance(context.messageHistoryTail, stage),
      DEMO_SESSION && keepSelectAtDateEntry(stage, memory.getPreferences())
    );
    const plannerCpMemoryLimit = Math.max(0, Math.floor(context.plannerCpMemoryLimit ?? 0));
    const cpMemoryEnabled = plannerCpMemoryLimit > 0;
    const plannerMemory = buildPlannerMemory(
      memory.getPreferences(),
      deadEnds,
      plannerCpMemoryLimit
    );
    const plannerHistory = buildPlannerHistory(context, cpMemoryEnabled, stage);
    const plannerInput = {
      ...(plannerMemory ? { memory: plannerMemory } : {}),
      history: plannerHistory,
      availableTools: plannerTools,
      workflow: buildWorkflowContext(
        context,
        stage,
        spec,
        plannerTools,
        cpMemoryEnabled,
        workflowState,
        deadEnds,
        priorStageAlternativeCounts,
        backtrackContinuation ?? null
      ),
      stageMeta: context.stageMeta,
      ...(language && language !== 'en' ? { language } : {}),
      // Spread the same way as `language`: absent unless it is actually on, so
      // a study session's planner input is byte-identical to what it was.
      ...(context.narrateAdaptations ? { narrateAdaptations: true } : {}),
      ...(context.spokenBrevity ? { spokenBrevity: true } : {}),
      // Profile-seeded preferences exist only in the demo; see
      // PRELOADED_MEMORY_RULES for why the planner is told about them.
      ...(memory.hasProfilePreferences() ? { preloadedMemory: true } : {}),
      ...(DEMO_SESSION
        ? {
            demoSession: true,
            decisiveSelection: true,
            requirementConflicts: true,
            openingQuestions: true,
            seatChoices: true,
            hiddenCountOnce: true,
          }
        : {}),
    };

    const llm = await planActionWithOpenAI(plannerInput);

    if (!llm) {
      return {
        action: null,
        explainText: hasUserRequest
          ? agentNotice('plannerUnparseable', language)
          : undefined,
        source: 'rule',
        fallbackReason: 'LLM_EMPTY_OR_UNPARSEABLE_OUTPUT',
      };
    }

    const validated = validateLlmAction(
      spec,
      plannerTools,
      llm
    );
    if (!validated) {
      return {
        action: null,
        explainText: hasUserRequest
          ? agentNotice('plannerInvalid', language)
          : undefined,
        source: 'rule',
        fallbackReason: 'LLM_VALIDATION_REJECTED',
      };
    }

    return validated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isOpenAiAuthError(error)) {
      // Always speak up here, even without a pending user request: an invalid
      // key blocks every turn, so silence would leave the UI waiting forever.
      console.error(
        `[tuning-agent] planner aborted: OpenAI authentication failed (${error.status}). Check the provided API key.`
      );
      return {
        action: null,
        explainText: agentNotice('apiKeyRejected', language),
        source: 'rule',
        fallbackReason: `LLM_AUTH_FAILED:${error.status}`,
      };
    }
    return {
      action: null,
      explainText: hasUserRequest
        ? agentNotice('plannerRequestFailed', language)
        : undefined,
      source: 'rule',
      fallbackReason: `LLM_REQUEST_FAILED:${message}`,
    };
  }
}
