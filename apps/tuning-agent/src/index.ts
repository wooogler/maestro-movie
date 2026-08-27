import { createSpeechBarrier } from './core/speechBarrier';
import { executePlannedAction } from './core/executor';
import { AgentMemory } from './core/memory';
import { applyStateUpdated, applyUserMessage, fromSnapshot } from './core/perception';
import { planNextAction } from './core/planner';
import {
  getPlannerSystemPrompt,
  subscribeLlmTrace as subscribePlannerLlmTrace,
} from './llm/llmPlanner';
import {
  extractStructuredPreferences,
  getExtractorSystemPrompt,
  subscribeLlmTrace as subscribeExtractorLlmTrace,
  type PreferenceExtractionContext,
} from './llm/llmExtractor';
import { buildConflictScope, buildDeadEndId } from './core/cpMemory';

import {
  buildWorkflowSelectionState,
  getWorkflowParentContextKey,
  getWorkflowSelectionId,
  resolveCommittedSelectionFromContext,
  toWorkflowStage,
  WORKFLOW_STAGE_ORDER,
} from './core/workflowState';
import { shouldResync } from './core/verifier';
import { isActionSafe } from './policies/safetyPolicy';
import { RelayClient } from './runtime/relayClient';
import { createStudyLlmTraceLogWriterFromEnv } from './runtime/studyLlmTraceLog';
import { AgentMonitorServer } from './monitor/server';
import type {
  BacktrackContinuation,
  ConflictMemory,
  ConflictScope,
  AttemptedBranch,
  FilterExpression,
  PlanDecision,
  PerceivedContext,
  RelayEnvelope,
  SnapshotStatePayload,
  StateUpdatedPayload,
  UserMessagePayload,
} from './types';

interface PendingBacktrackConflict {
  preferenceIds: string[];
  description: string;
  scope: ConflictScope;
  createdAt: string;
}

function buildAttemptedBranchForBacktrack(
  context: PerceivedContext,
  reason: string
): AttemptedBranch | null {
  const currentStage = toWorkflowStage(context.stage ?? null);
  if (!currentStage) return null;

  const branchStage = (() => {
    switch (currentStage) {
      case 'theater':
        return 'movie';
      case 'date':
        return 'theater';
      case 'time':
        return 'date';
      case 'seat':
      case 'confirm':
        return 'time';
      default:
        return null;
    }
  })();

  if (!branchStage) return null;

  const workflowState = buildWorkflowSelectionState({
    currentStage,
    messageHistory: context.messageHistoryTail,
    uiSpec: context.uiSpec,
    committedState: memory.getCommittedWorkflowState(),
  });
  const parentContextKey = getWorkflowParentContextKey(branchStage, workflowState);
  const itemId = getWorkflowSelectionId(workflowState, branchStage);
  if (!parentContextKey || !itemId) return null;

  return {
    stage: branchStage,
    parentContextKey,
    itemId,
    createdAt: new Date().toISOString(),
    reason,
  };
}

const relayUrl = process.env.AGENT_RELAY_URL || 'ws://localhost:3000/agent/ws';
const sessionId = process.env.AGENT_SESSION_ID || 'default';
const agentName = process.env.AGENT_NAME || 'tuning-agent';
const studyId = process.env.AGENT_STUDY_ID || 'pilot-01';
const participantId = process.env.AGENT_PARTICIPANT_ID || 'P01';
const studyMode = process.env.AGENT_STUDY_MODE || 'basic-tuning-voice-off';
const monitorPort = Number(process.env.AGENT_MONITOR_PORT || 3500);
const monitorWebPort = Number(process.env.AGENT_MONITOR_WEB_PORT || 3501);
const isProduction = process.env.NODE_ENV === 'production';

function parseBooleanEnv(value: string | undefined): boolean | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

// The monitor keeps the full conversation and every LLM request/response in
// memory and serves it unauthenticated, so it is an event log in all but name:
// demo sessions ("no logging of any kind") never get one.
const isDemoMode = studyMode === 'demo';
const monitorEnabled = isDemoMode
  ? false
  : parseBooleanEnv(process.env.AGENT_MONITOR_ENABLED) ?? !isProduction;
const memory = new AgentMemory();
const relay = new RelayClient({ relayUrl, sessionId, agentName, requestTimeoutMs: 12000 });
const studyLlmTraceLog = createStudyLlmTraceLogWriterFromEnv();
const monitor = new AgentMonitorServer({
  enabled: monitorEnabled,
  port: monitorPort,
  relayUrl,
  sessionId,
  agentName,
  routingMode: 'planner',
  llmSystemPrompts: {
    planner: getPlannerSystemPrompt(),
    extractor: getExtractorSystemPrompt(),
  },
});

function extractSystemPromptFromTracePayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;

  const direct = typeof record.systemPrompt === 'string' && record.systemPrompt.trim()
    ? record.systemPrompt.trim()
    : null;
  if (direct) return direct;

  const body =
    record.body && typeof record.body === 'object' && !Array.isArray(record.body)
      ? (record.body as Record<string, unknown>)
      : null;
  const input = body && Array.isArray(body.input) ? body.input : [];
  if (input.length === 0) return null;
  const firstMessage =
    input[0] && typeof input[0] === 'object' && !Array.isArray(input[0])
      ? (input[0] as Record<string, unknown>)
      : null;
  const content =
    firstMessage && typeof firstMessage.content === 'string' && firstMessage.content.trim()
      ? firstMessage.content.trim()
      : null;
  return content;
}

const llmTraceHandler = (event: { component?: string; type: string; payload: unknown }) => {
  const component =
    typeof event.component === 'string' && event.component.trim() ? event.component.trim() : 'unknown';
  const monitorEventType = `llm.${component}.${event.type}`;
  const systemPrompt = extractSystemPromptFromTracePayload(event.payload);
  if (event.type === 'request' && systemPrompt && (component === 'planner' || component === 'extractor')) {
    monitor.updateLlmSystemPrompt(component, systemPrompt);
  }
  monitor.pushEvent(monitorEventType, event.payload);
  studyLlmTraceLog.append({
    type: monitorEventType,
    payload: event.payload,
  });
};
const unsubscribePlannerLlmTrace = subscribePlannerLlmTrace(llmTraceHandler);
const unsubscribeExtractorLlmTrace = subscribeExtractorLlmTrace(llmTraceHandler);

function unsubscribeAllLlmTraces(): void {
  unsubscribePlannerLlmTrace();
  unsubscribeExtractorLlmTrace();
}

let actionInFlight = false;
let lastActionFingerprint = '';
let lastActionAt = 0;
let lastAgentToolName: string | null = null;
let pendingReadingDelayUntil = 0;
let voiceModeEnabled = false;
let ensureSessionReadyInFlight: Promise<void> | null = null;
let sessionReady = false;
let hostConnectionAvailable = false;
let connectedOnce = false;
let planningInFlight = false;
let deferredReplanRequested = false;
let deferredReplanTrigger: string | null = null;
let userTurnAwaitingStateUpdate = false;
let userPreferenceExtractionInFlight: Promise<void> | null = null;
let userConversationStarted = false;
let fatalErrorMessage: string | null = null;
let perceptionVersion = 0;
let lastUiFingerprint: string | null = null;
let isFirstSnapshotSeen = false;
let pendingBacktrackConflict: PendingBacktrackConflict | null = null;
let activeBacktrackContinuation: BacktrackContinuation | null = null;
let suppressNavigationToolsOnce = false;
type AgentStatusPhase = 'idle' | 'planning' | 'executing';
let currentAgentStatusPhase: AgentStatusPhase = 'idle';

interface PerceptionWaiter {
  afterVersion: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

const perceptionWaiters = new Set<PerceptionWaiter>();

const RETRY_DELAY_MS = 1200;
const DEFAULT_CP_MEMORY_LIMIT = Math.max(
  0,
  Number.parseInt(process.env.AGENT_DEFAULT_CP_MEMORY_LIMIT || '10', 10) || 10
);
const EXTRACTION_STAGE_ORDER = WORKFLOW_STAGE_ORDER;
const EXTRACTION_HISTORY_WINDOW = 10;

function getMonitorApiPort(): number {
  if (!monitor.isEnabled()) return monitorPort;
  return monitor.getListeningPort() ?? monitorPort;
}

function sendAgentStatus(
  phase: AgentStatusPhase,
  options: {
    stage?: string | null;
    trigger?: string;
  } = {}
): void {
  const stage =
    typeof options.stage === 'string' && options.stage.trim() ? options.stage.trim() : undefined;
  const trigger =
    typeof options.trigger === 'string' && options.trigger.trim()
      ? options.trigger.trim()
      : undefined;

  if (
    currentAgentStatusPhase === phase &&
    stage === undefined &&
    trigger === undefined
  ) {
    return;
  }

  currentAgentStatusPhase = phase;

  try {
    relay.send('agent.status', {
      agentName,
      phase,
      ...(stage ? { stage } : {}),
      ...(trigger ? { trigger } : {}),
    });
  } catch {
    // Host disconnections should not fail the planner loop.
  }
}

function syncMonitorMemoryState(): void {
  monitor.updateMemory(memory.getPreferences(), memory.getDeadEnds());
}

function buildPendingBacktrackConflict(
  context: PerceivedContext,
  conflictMemory: ConflictMemory
): PendingBacktrackConflict | null {
  const currentStage = toWorkflowStage(context.stage ?? null);
  if (!currentStage) return null;

  const description = conflictMemory.description.trim();
  const preferenceIds = Array.from(
    new Set(conflictMemory.preferenceIds.map((item) => item.trim()).filter(Boolean))
  );
  if (!description || preferenceIds.length === 0) return null;

  const scope = buildConflictScope(
    currentStage,
    buildWorkflowSelectionState({
      currentStage,
      messageHistory: context.messageHistoryTail,
      uiSpec: context.uiSpec,
      committedState: memory.getCommittedWorkflowState(),
    })
  );

  return {
    preferenceIds,
    description,
    scope,
    createdAt: new Date().toISOString(),
  };
}

function setPendingBacktrackConflict(
  conflict: PendingBacktrackConflict | null,
  reason: string,
  details?: Record<string, unknown>
): void {
  pendingBacktrackConflict = conflict;
  monitor.pushEvent(conflict ? 'memory.pending_conflict_updated' : 'memory.pending_conflict_cleared', {
    reason,
    pendingConflict: conflict,
    ...(details ?? {}),
  });
}

function setActiveBacktrackContinuation(
  continuation: BacktrackContinuation | null,
  reason: string,
  details?: Record<string, unknown>
): void {
  activeBacktrackContinuation = continuation;
  monitor.pushEvent(
    continuation ? 'planner.backtrack_continuation_updated' : 'planner.backtrack_continuation_cleared',
    {
      reason,
      backtrackContinuation: continuation,
      ...(details ?? {}),
    }
  );
}

function setSuppressNavigationToolsOnce(
  suppressed: boolean,
  reason: string,
  details?: Record<string, unknown>
): void {
  suppressNavigationToolsOnce = suppressed;
  monitor.pushEvent(
    suppressed ? 'planner.navigation_tools_suppressed' : 'planner.navigation_tools_unsuppressed',
    {
      reason,
      suppressNavigationToolsOnce: suppressed,
      ...(details ?? {}),
    }
  );
}

function materializeDeadEndFromPendingConflict(
  pendingConflict: PendingBacktrackConflict,
  timestamp: string
): import('./types').DeadEnd {
  const payload = {
    preferenceIds: pendingConflict.preferenceIds,
    scope: pendingConflict.scope,
    reason: pendingConflict.description,
  };

  return {
    id: buildDeadEndId(payload),
    ...payload,
    createdAt: timestamp,
    lastSeenAt: timestamp,
    count: 1,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getLatestUserActionEntry(messageHistory: unknown[]): { stage: string | null; action: string | null } | null {
  for (let i = messageHistory.length - 1; i >= 0; i -= 1) {
    const entry = asRecord(messageHistory[i]);
    if (readNonEmptyString(entry.type) !== 'user') continue;
    return {
      stage: readNonEmptyString(entry.stage),
      action: readNonEmptyString(entry.action),
    };
  }
  return null;
}

function isUserDrivenSelectionTransition(
  previousStage: string | null,
  messageHistory: unknown[]
): boolean {
  const latest = getLatestUserActionEntry(messageHistory);
  if (!latest || latest.stage !== previousStage) return false;
  return latest.action === 'select' || latest.action === 'selectMultiple';
}

function isUserDrivenNavigationTransition(
  previousStage: string | null,
  nextStage: string | null,
  lastToolName: string | null
): boolean {
  const previousWorkflowStage = toWorkflowStage(previousStage);
  const nextWorkflowStage = toWorkflowStage(nextStage);
  if (!previousWorkflowStage || !nextWorkflowStage) return false;

  const previousIndex = WORKFLOW_STAGE_ORDER.indexOf(previousWorkflowStage);
  const nextIndex = WORKFLOW_STAGE_ORDER.indexOf(nextWorkflowStage);
  if (nextIndex >= previousIndex) return false;

  return lastToolName !== 'prev';
}

function buildFilterTrackingSnapshot(
  context: PerceivedContext
): {
  stage: import('./types').ConflictStage;
  parentContextKey: string;
  valueField: string;
  items: Record<string, unknown>[];
} | null {
  const currentStage = toWorkflowStage(context.stage ?? null);
  if (!currentStage) return null;

  const rawSpec = asRecord(context.uiSpec);
  const display = asRecord(rawSpec.display);
  const valueField = readNonEmptyString(display.valueField);
  if (!valueField) return null;

  const items = Array.isArray(rawSpec.items)
    ? rawSpec.items
        .map((item) => asRecord(item))
        .filter((item) => Object.keys(item).length > 0)
        .map((item) => ({ ...item }))
    : [];
  if (items.length === 0) return null;

  const workflowState = buildWorkflowSelectionState({
    currentStage,
    messageHistory: context.messageHistoryTail,
    uiSpec: context.uiSpec,
    committedState: memory.getCommittedWorkflowState(),
  });
  const parentContextKey = getWorkflowParentContextKey(currentStage, workflowState);
  if (!parentContextKey) return null;

  return {
    stage: currentStage,
    parentContextKey,
    valueField,
    items,
  };
}

function toFilterExpression(params: Record<string, unknown>): FilterExpression | null {
  const field = readNonEmptyString(params.field);
  const operator = readNonEmptyString(params.operator);
  if (!field || !operator) return null;
  if (!['eq', 'neq', 'contains', 'gt', 'lt', 'gte', 'lte', 'in'].includes(operator)) {
    return null;
  }
  return {
    field,
    operator: operator as FilterExpression['operator'],
    value: Object.prototype.hasOwnProperty.call(params, 'value') ? params.value : null,
  };
}

function toHighlightItemIds(params: Record<string, unknown>): string[] {
  const raw = params.itemIds;
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function compactExtractionVisibleItems(
  value: unknown
): Array<{ id: string; value: string }> {
  if (!Array.isArray(value)) return [];

  const compacted: Array<{ id: string; value: string }> = [];
  for (const rawItem of value) {
    const item = asRecord(rawItem);
    if (!item) continue;
    const id = readNonEmptyString(item.id);
    const itemValue = readNonEmptyString(item.value);
    if (!id || !itemValue) continue;
    if (item.isDisabled === true) continue;
    compacted.push({ id, value: itemValue });
  }

  return compacted;
}

function compactExtractionSystemSpec(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;

  const summary: Record<string, unknown> = {};
  const stage = readNonEmptyString(record.stage);
  if (stage) summary.stage = stage;

  const state = asRecord(record.state);
  const selected = state ? asRecord(state.selected) : null;
  const selectedId = selected ? readNonEmptyString(selected.id) : null;
  const selectedValue = selected ? readNonEmptyString(selected.value) : null;
  if (selectedId && selectedValue) {
    summary.selected = { id: selectedId, value: selectedValue };
  }

  const selectedList =
    state && Array.isArray(state.selectedList) ? state.selectedList : [];
  if (selectedList.length > 0) {
    summary.selectedListCount = selectedList.length;
  }

  const visibleItems = compactExtractionVisibleItems(record.visibleItems);
  if (visibleItems.length > 0) {
    summary.visibleItems = visibleItems;
  }
  if (Array.isArray(record.visibleItems) && record.visibleItems.length > visibleItems.length) {
    summary.disabledItemCount = record.visibleItems.length - visibleItems.length;
  }

  const modification = asRecord(record.modification);
  if (modification && Object.keys(modification).length > 0) {
    summary.modification = modification;
  }

  if (stage === 'confirm' && record.meta && typeof record.meta === 'object') {
    summary.meta = record.meta;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function compactExtractionDialogueTurn(value: unknown): { type: 'user' | 'agent'; text: string } | null {
  const record = asRecord(value);
  if (!record) return null;

  const type = readNonEmptyString(record.type);
  if (type !== 'user' && type !== 'agent') return null;

  if (type === 'user') {
    const action = readNonEmptyString(record.action);
    if (action !== 'input') return null;
    const text = readNonEmptyString(record.label);
    return text ? { type, text } : null;
  }

  const text = readNonEmptyString(record.text);
  return text ? { type, text } : null;
}

function buildExtractionRecentDialogue(
  context: PerceivedContext
): Array<{ type: 'user' | 'agent'; text: string }> {
  const raw = context.messageHistoryTail;
  const result: Array<{ type: 'user' | 'agent'; text: string }> = [];
  let lastAgentText: string | null = null;

  for (const rawEntry of raw) {
    const entry = compactExtractionDialogueTurn(rawEntry);
    if (!entry) continue;

    if (entry.type === 'agent') {
      // Keep overwriting — only the last agent message before a user input matters
      lastAgentText = entry.text;
      continue;
    }

    // entry.type === 'user': pair with the preceding agent question
    if (lastAgentText) {
      result.push({ type: 'agent', text: lastAgentText });
      lastAgentText = null;
    }
    result.push(entry);
  }

  // Include trailing agent message (the question that prompted the current user input)
  if (lastAgentText) {
    result.push({ type: 'agent', text: lastAgentText });
  }

  return result.slice(-EXTRACTION_HISTORY_WINDOW);
}

function buildExtractionUiFlow(context: PerceivedContext): Record<string, unknown> {
  const currentStage = context.stage ?? '';
  const stageIndex = EXTRACTION_STAGE_ORDER.indexOf(currentStage as (typeof EXTRACTION_STAGE_ORDER)[number]);
  const previousStage = stageIndex > 0 ? EXTRACTION_STAGE_ORDER[stageIndex - 1] : null;
  const nextStage =
    stageIndex >= 0 && stageIndex < EXTRACTION_STAGE_ORDER.length - 1
      ? EXTRACTION_STAGE_ORDER[stageIndex + 1]
      : null;

  const uiSpecRecord = asRecord(context.uiSpec);
  const state = asRecord(uiSpecRecord.state);
  const workflow =
    (typeof state.workflow === 'object' && state.workflow !== null && !Array.isArray(state.workflow)
      ? (state.workflow as Record<string, unknown>)
      : null) ??
    (typeof state.booking === 'object' && state.booking !== null && !Array.isArray(state.booking)
      ? (state.booking as Record<string, unknown>)
      : null) ??
    {};
  const workflowSummary: Record<string, unknown> = {};

  const movie = asRecord(workflow?.movie);
  const movieId = readNonEmptyString(movie.id);
  const movieTitle = readNonEmptyString(movie.title);
  if (movieId || movieTitle) {
    workflowSummary.movie = {
      ...(movieId ? { id: movieId } : {}),
      ...(movieTitle ? { title: movieTitle } : {}),
    };
  }

  const theater = asRecord(workflow?.theater);
  const theaterId = readNonEmptyString(theater.id);
  const theaterName = readNonEmptyString(theater.name);
  if (theaterId || theaterName) {
    workflowSummary.theater = {
      ...(theaterId ? { id: theaterId } : {}),
      ...(theaterName ? { name: theaterName } : {}),
    };
  }

  const dateRecord = asRecord(workflow?.date);
  const date = readNonEmptyString(dateRecord?.date) ?? readNonEmptyString(dateRecord?.id);
  if (date) workflowSummary.date = date;

  const showing = asRecord(workflow?.showing);
  const showingId = readNonEmptyString(showing.id);
  const showingTime = readNonEmptyString(showing.time);
  if (showingId || showingTime) {
    workflowSummary.showing = {
      ...(showingId ? { id: showingId } : {}),
      ...(showingTime ? { time: showingTime } : {}),
    };
  }

  const selectedSeats = Array.isArray(workflow?.seats)
    ? workflow.seats
    : Array.isArray(workflow?.selectedSeats)
    ? workflow.selectedSeats
    : [];
  if (selectedSeats.length > 0) {
    workflowSummary.seatsCount = selectedSeats.length;
  }

  return {
    stageOrder: EXTRACTION_STAGE_ORDER,
    currentStage,
    previousStage,
    nextStage,
    ...(Object.keys(workflowSummary).length > 0 ? { workflow: workflowSummary } : {}),
  };
}

function resolvePlannerCpMemoryLimit(payload: Record<string, unknown>, fallback: number): number {
  const rawLimit = payload.plannerCpMemoryLimit;
  if (typeof rawLimit === 'number' && Number.isFinite(rawLimit)) {
    return Math.max(0, Math.floor(rawLimit));
  }
  const parsed = Number.parseInt(String(rawLimit ?? ''), 10);
  if (Number.isFinite(parsed)) {
    return Math.max(0, parsed);
  }
  const legacyToggle = payload.plannerCpEnabled;
  if (typeof legacyToggle === 'boolean') {
    return legacyToggle ? fallback : 0;
  }
  return fallback;
}

function isPlannerCpMemoryEnabled(plannerCpMemoryLimit: number | null | undefined): boolean {
  if (!Number.isFinite(plannerCpMemoryLimit)) return false;
  return Math.floor(plannerCpMemoryLimit ?? 0) > 0;
}

function parseStageMeta(value: unknown): Array<{ stage: string; goal: string; fieldGuide: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Array<{ stage: string; goal: string; fieldGuide: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.stage === 'string' && typeof rec.goal === 'string' && typeof rec.fieldGuide === 'string') {
      result.push({ stage: rec.stage, goal: rec.goal, fieldGuide: rec.fieldGuide });
    }
  }
  return result.length > 0 ? result : undefined;
}

function toSnapshotPayload(value: unknown): SnapshotStatePayload {
  const payload = asRecord(value);
  return {
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : '',
    uiSpec: payload.uiSpec ?? null,
    messageHistory: Array.isArray(payload.messageHistory) ? payload.messageHistory : [],
    toolSchema: Array.isArray(payload.toolSchema) ? payload.toolSchema : [],
    plannerCpMemoryLimit: resolvePlannerCpMemoryLimit(payload, DEFAULT_CP_MEMORY_LIMIT),
    plannerCpEnabled:
      typeof payload.plannerCpEnabled === 'boolean' ? payload.plannerCpEnabled : undefined,
    guiAdaptationEnabled:
      typeof payload.guiAdaptationEnabled === 'boolean' ? payload.guiAdaptationEnabled : undefined,
    stageMeta: parseStageMeta(payload.stageMeta),
  };
}

function toStateUpdatedPayload(value: unknown): StateUpdatedPayload {
  const payload = asRecord(value);
  return {
    source: typeof payload.source === 'string' ? payload.source : undefined,
    uiSpec: payload.uiSpec ?? null,
    messageHistory: Array.isArray(payload.messageHistory) ? payload.messageHistory : [],
    toolSchema: Array.isArray(payload.toolSchema) ? payload.toolSchema : [],
    plannerCpMemoryLimit: resolvePlannerCpMemoryLimit(payload, DEFAULT_CP_MEMORY_LIMIT),
    plannerCpEnabled:
      typeof payload.plannerCpEnabled === 'boolean' ? payload.plannerCpEnabled : undefined,
    guiAdaptationEnabled:
      typeof payload.guiAdaptationEnabled === 'boolean' ? payload.guiAdaptationEnabled : undefined,
  };
}

function toUserMessagePayload(value: unknown): UserMessagePayload {
  const payload = asRecord(value);
  return {
    text: typeof payload.text === 'string' ? payload.text : '',
    stage: typeof payload.stage === 'string' ? payload.stage : undefined,
  };
}

function pickStageFromUiSpec(uiSpec: unknown): string | null {
  const record = asRecord(uiSpec);
  const stage = record.currentStage ?? record.stage;
  return typeof stage === 'string' ? stage : null;
}

function applyImmediateUiSpec(context: PerceivedContext, uiSpec: unknown): PerceivedContext {
  const nextStage = pickStageFromUiSpec(uiSpec) ?? context.stage;
  return {
    ...context,
    stage: nextStage,
    uiSpec: uiSpec ?? null,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function buildUiFingerprint(uiSpec: unknown): string {
  if (uiSpec === null || uiSpec === undefined) return 'null';
  try {
    return JSON.stringify(uiSpec);
  } catch {
    return JSON.stringify({ stage: pickStageFromUiSpec(uiSpec) ?? null });
  }
}

function buildExtractionState(context: PerceivedContext): Record<string, unknown> | null {
  const currentStage = toWorkflowStage(context.stage ?? null);
  return currentStage
    ? buildWorkflowSelectionState({
        currentStage,
        messageHistory: context.messageHistoryTail,
        uiSpec: context.uiSpec,
        committedState: memory.getCommittedWorkflowState(),
      })
    : null;
}

function buildPreferenceExtractionViewContext(
  context: PerceivedContext
): Pick<PreferenceExtractionContext, 'currentStage' | 'state' | 'compactUi' | 'recentDialogue'> {
  return {
    currentStage: context.stage ?? '',
    compactUi: compactExtractionSystemSpec(context.uiSpec),
    state: buildExtractionState(context),
    recentDialogue: buildExtractionRecentDialogue(context),
  };
}

async function runPreferenceExtractionFromUserMessage(
  context: PerceivedContext,
  userMessageText: string
): Promise<void> {
  const userMessage = userMessageText.trim();
  if (!userMessage) return;

  const extractionView = buildPreferenceExtractionViewContext(context);
  const existingPreferences = memory.getPreferences();
  const uiFingerprint = buildUiFingerprint(context.uiSpec);

  const extractionCtx: PreferenceExtractionContext = {
    userMessage,
    ...extractionView,
    existingPreferences,
    stageMeta: context.stageMeta,
  };

  try {
    const updatedPreferences = await extractStructuredPreferences(extractionCtx);
    memory.setPreferences(updatedPreferences);

    syncMonitorMemoryState();
    monitor.pushEvent('extraction.completed', {
      trigger: 'user.message',
      mode: 'preferences',
      uiFingerprint,
      updatedPreferences,
      preferences: memory.getPreferences(),
      deadEnds: memory.getDeadEnds(),
    });
  } catch (extractionError) {
    monitor.pushEvent('extraction.failed', {
      trigger: 'user.message',
      mode: 'preferences',
      uiFingerprint,
      message: extractionError instanceof Error ? extractionError.message : String(extractionError),
    });
  }
}

function hasInputUserMessage(history: unknown[]): boolean {
  return history.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    const action = typeof record.action === 'string' ? record.action : '';
    const label = typeof record.label === 'string' ? record.label : '';
    return type === 'user' && action === 'input' && label.trim().length > 0;
  });
}

function syncUserConversationStarted(context: PerceivedContext): void {
  if (userConversationStarted) return;
  if (context.lastUserMessage?.text?.trim()) {
    userConversationStarted = true;
    return;
  }
  if (hasInputUserMessage(context.messageHistoryTail)) {
    userConversationStarted = true;
  }
}

function getToolName(action: import('./types').PlannedAction): string {
  if (action.type !== 'tool.call') return action.type;
  return typeof action.payload.toolName === 'string' ? action.payload.toolName : 'tool.call';
}

function buildActionFingerprint(action: import('./types').PlannedAction, stage: string | null): string {
  if (action.type === 'tool.call') {
    const toolName = typeof action.payload.toolName === 'string' ? action.payload.toolName : '';
    const params =
      action.payload.params && typeof action.payload.params === 'object' && !Array.isArray(action.payload.params)
        ? action.payload.params
        : {};
    return JSON.stringify({
      stage,
      type: action.type,
      toolName,
      params,
    });
  }

  return JSON.stringify({
    stage,
    type: action.type,
    payload: action.payload,
  });
}

function requestDeferredReplan(trigger: string): void {
  deferredReplanRequested = true;
  deferredReplanTrigger = trigger;
  monitor.updateState({ pendingUserMessages: 1 });
  monitor.pushEvent('planner.deferred_replan', { trigger });
}

function markPerceptionUpdated(): void {
  perceptionVersion += 1;
  for (const waiter of Array.from(perceptionWaiters)) {
    if (perceptionVersion > waiter.afterVersion) {
      perceptionWaiters.delete(waiter);
      waiter.resolve();
    }
  }
}

function waitForPerceptionAdvance(afterVersion: number): Promise<void> {
  if (perceptionVersion > afterVersion) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: PerceptionWaiter = { afterVersion, resolve, reject };
    perceptionWaiters.add(waiter);
  });
}

function rejectPerceptionWaiters(message: string): void {
  const error = new Error(message);
  for (const waiter of Array.from(perceptionWaiters)) {
    perceptionWaiters.delete(waiter);
    waiter.reject(error);
  }
}

function enterFatalState(reason: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  fatalErrorMessage = `${reason}: ${message}`;
  monitor.updateState({
    phase: 'error',
    actionInFlight: false,
    pendingUserMessages: 0,
  });
  monitor.pushEvent('runtime.fatal', {
    reason,
    message,
  });
  console.error(`[tuning-agent] fatal ${reason}: ${message}`);
}

function isControlFlowCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === 'session-reset' || message === 'terminated-by-signal';
}

function buildAgentMessageAction(text: string): import('./types').PlannedAction {
  return {
    type: 'agent.message',
    reason: 'Provide a concise assistant response to the user.',
    payload: {
      text,
    },
  };
}

const BASE_WPM = 155;
const TTS_SPEED = (() => {
  const parsed = Number.parseFloat(process.env.OPENAI_TTS_SPEED || '1.5');
  if (!Number.isFinite(parsed)) return 1.5;
  return Math.min(4, Math.max(0.25, parsed));
})();
const MIN_READING_DELAY_MS = 600;
const TTS_PLAYBACK_TIMEOUT_MS = 15_000;

function computeReadingDelay(text: string): number {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const durationMs = (wordCount / (BASE_WPM * TTS_SPEED)) * 60_000;
  return Math.max(durationMs, MIN_READING_DELAY_MS);
}

const speechBarrier = createSpeechBarrier({
  timeoutMs: TTS_PLAYBACK_TIMEOUT_MS,
  onEvent: (event) => {
    monitor.pushEvent(`tts.playback.${event.type}`, event);
  },
});

/** Called after an `agent.message` has been accepted by the host. */
function noteAgentSpeechSent(): void {
  if (!voiceModeEnabled) return;
  speechBarrier.noteSpeechSent();
}

async function maybeSendAssistantMessage(context: PerceivedContext, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const action = buildAgentMessageAction(trimmed);
  if (!isActionSafe(context, action)) return;
  const outcome = await executePlannedAction(relay, action);
  if (outcome.ok) noteAgentSpeechSent();
  monitor.pushEvent('assistant_message.outcome', { text: trimmed, outcome });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSessionNotActiveError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('SESSION_NOT_ACTIVE');
}

async function ensureRelayConnected(): Promise<void> {
  monitor.updateState({ phase: 'connecting-relay', relayConnected: false });
  while (true) {
    try {
      await relay.connect();
      monitor.updateState({ relayConnected: true, phase: 'relay-connected' });
      monitor.pushEvent('relay.connected', { relayUrl, sessionId });
      return;
    } catch (error) {
      monitor.pushEvent('relay.connect_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      console.warn(
        `[tuning-agent] relay connect failed, retrying in ${RETRY_DELAY_MS}ms: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function ensureSessionReady(reason: string): Promise<void> {
  if (ensureSessionReadyInFlight) {
    await ensureSessionReadyInFlight;
    return;
  }

  ensureSessionReadyInFlight = (async () => {
    while (true) {
      await ensureRelayConnected();

      try {
        monitor.updateState({ phase: 'starting-session', waitingForHost: false });
        await relay.request('session.start', { studyId, participantId });
        await relay.request('snapshot.get', {});
        sessionReady = true;
        monitor.updateState({
          waitingForHost: false,
          sessionReady: true,
          phase: 'ready',
        });
        monitor.pushEvent('session.ready', { reason });

        if (!connectedOnce) {
          connectedOnce = true;
          console.log(`[tuning-agent] connected to ${relayUrl} (sessionId=${sessionId})`);
          if (monitor.isEnabled()) {
            const activeMonitorPort = getMonitorApiPort();
            console.log(
              `[tuning-agent] monitor API available at http://localhost:${activeMonitorPort}`
            );
            console.log(`[tuning-agent] monitor UI available at http://localhost:${monitorWebPort}`);
          } else {
            console.log('[tuning-agent] monitor disabled');
          }
        }
        return;
      } catch (error) {
        if (isSessionNotActiveError(error)) {
          sessionReady = false;
          hostConnectionAvailable = false;
          monitor.updateState({
            waitingForHost: true,
            sessionReady: false,
            phase: 'waiting-host',
          });
          monitor.pushEvent('session.waiting_host', { reason });
          console.log(
            `[tuning-agent] waiting for host connection (${reason}); retrying in ${RETRY_DELAY_MS}ms`
          );
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        console.warn(
          `[tuning-agent] session bootstrap failed, retrying in ${RETRY_DELAY_MS}ms: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        monitor.pushEvent('session.bootstrap_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        await sleep(RETRY_DELAY_MS);
      }
    }
  })();

  try {
    await ensureSessionReadyInFlight;
  } finally {
    ensureSessionReadyInFlight = null;
  }
}

async function maybePlanAndExecute(trigger: string): Promise<void> {
  if (fatalErrorMessage) {
    monitor.pushEvent('planner.blocked_fatal', {
      trigger,
      fatalError: fatalErrorMessage,
    });
    return;
  }

  if (actionInFlight || planningInFlight) {
    if (trigger === 'state.updated') {
      monitor.pushEvent('planner.skip_replan_while_busy', { trigger });
      return;
    }
    requestDeferredReplan(trigger);
    return;
  }

  const context = memory.getContext();
  if (!context) return;
  // NOTE: userConversationStarted gate removed to allow llmPlanner
  // to act proactively from the first stage (e.g. greeting on snapshot).

  let readingDelayPromise: Promise<void> | null = null;
  if (voiceModeEnabled) {
    // Gate on what was actually sent, not on pendingReadingDelayUntil. The
    // fallback utterance at the tool-call path speaks without ever setting a
    // reading delay, so keying the barrier off that flag let the agent talk
    // over its own previous sentence.
    readingDelayPromise = speechBarrier.wait();
    pendingReadingDelayUntil = 0;
  } else if (pendingReadingDelayUntil > 0) {
    const remaining = pendingReadingDelayUntil - Date.now();
    if (remaining > 0) {
      readingDelayPromise = sleep(remaining);
    }
    pendingReadingDelayUntil = 0;
  }

  planningInFlight = true;
  monitor.updateContext(context);
  monitor.updateState({ pendingUserMessages: deferredReplanRequested ? 1 : 0 });
  sendAgentStatus('planning', { stage: context.stage, trigger });

  try {
    const planningContext = memory.getContext() ?? context;
    const suppressNavigationTools = suppressNavigationToolsOnce;
    if (suppressNavigationToolsOnce) {
      setSuppressNavigationToolsOnce(false, 'consumed-by-planning', {
        trigger,
        stage: planningContext.stage,
      });
    }
    const decision: PlanDecision = await planNextAction(
      planningContext,
      memory,
      lastAgentToolName,
      activeBacktrackContinuation,
      suppressNavigationTools
    );
    const action = decision.action;
    const decisionExplainText = decision.explainText ?? '';
    const plannedToolName =
      action?.type === 'tool.call' && typeof action.payload.toolName === 'string'
        ? action.payload.toolName
        : '';

    if (!action) {
      // Do NOT clear activeBacktrackContinuation here.
      // A respond during a multi-stage backtrack (e.g. explaining a dead-end or conflict)
      // should not kill the continuation. It is cleared by:
      // - non-prev tool action (line ~1201)
      // - user message handler
      // - user-driven stage change handler
      if (decision.conflictMemory) {
        const nextPendingConflict = buildPendingBacktrackConflict(planningContext, decision.conflictMemory);
        if (nextPendingConflict) {
          setPendingBacktrackConflict(nextPendingConflict, 'planner-respond-conflict', {
            trigger,
            stage: planningContext.stage,
          });
        } else if (pendingBacktrackConflict) {
          setPendingBacktrackConflict(null, 'planner-conflict-invalid', {
            trigger,
            stage: planningContext.stage,
          });
        }
      } else if (pendingBacktrackConflict) {
        setPendingBacktrackConflict(null, 'planner-no-action-without-conflict', {
          trigger,
          stage: planningContext.stage,
        });
      }

      if (readingDelayPromise) await readingDelayPromise;
      if (decisionExplainText.trim()) {
        await maybeSendAssistantMessage(planningContext, decisionExplainText);
      }
      monitor.pushEvent('planner.no_action', {
        source: decision.source,
        explainText: decision.explainText ?? null,
        fallbackReason: decision.fallbackReason ?? null,
      });
      return;
    }

    if (plannedToolName !== 'prev' && activeBacktrackContinuation) {
      setActiveBacktrackContinuation(null, 'planner-action-replaces-backtrack-continuation', {
        trigger,
        stage: planningContext.stage,
        plannedToolName,
      });
    }

    if (plannedToolName !== 'prev' && pendingBacktrackConflict) {
      setPendingBacktrackConflict(null, 'planner-action-replaces-pending-conflict', {
        trigger,
        stage: planningContext.stage,
        plannedToolName,
      });
    }

    monitor.setLastPlan(action, trigger);
    monitor.pushEvent('planner.decision', {
      source: decision.source,
      explainText: decision.explainText ?? null,
      fallbackReason: decision.fallbackReason ?? null,
      action,
    });

    const actionFingerprint = buildActionFingerprint(action, planningContext.stage);
    const now = Date.now();
    if (actionFingerprint === lastActionFingerprint && now - lastActionAt < 700) {
      return;
    }

    if (!isActionSafe(planningContext, action)) {
      memory.addRecord({
        timestamp: new Date().toISOString(),
        stage: planningContext.stage,
        actionType: action.type,
        ok: false,
        code: 'SAFETY_BLOCKED',
        reason: action.reason,
      });
      monitor.pushEvent('action.blocked', { trigger, action });
      console.warn(`[tuning-agent] action blocked by safety policy (${trigger})`);
      return;
    }

    if (readingDelayPromise) await readingDelayPromise;

    actionInFlight = true;
    monitor.updateState({ actionInFlight: true, phase: 'executing-action' });
    sendAgentStatus('executing', { stage: planningContext.stage, trigger });
    lastActionFingerprint = actionFingerprint;
    lastActionAt = now;

    // Update lastAgentToolName BEFORE any await that triggers state.updated from the
    // frontend (maybeSendAssistantMessage, executePlannedAction). Otherwise the
    // state.updated handler sees a stale value and misidentifies agent-driven
    // navigation (prev) as user-driven, which incorrectly clears
    // backtrackContinuation and suppresses navigation tools.
    const toolName = plannedToolName;
    const previousLastAgentToolName = lastAgentToolName;
    lastAgentToolName = toolName || null;

    if (action.type !== 'agent.message') {
      await maybeSendAssistantMessage(
        planningContext,
        decisionExplainText || `I will run ${getToolName(action)} next. Reason: ${action.reason}`
      );
    }

    const outcome = await executePlannedAction(relay, action);
    if (action.type === 'agent.message' && outcome.ok) noteAgentSpeechSent();
    if (outcome.uiSpec !== undefined) {
      const current = memory.getContext();
      if (current) {
        const next = applyImmediateUiSpec(current, outcome.uiSpec);
        upsertContext(next);
        monitor.updateContext(next);
      }
    }
    monitor.setLastOutcome(outcome);
    monitor.pushEvent('action.outcome', { action, outcome });

    if (!outcome.ok && outcome.code === 'SESSION_NOT_ACTIVE') {
      sessionReady = false;
      hostConnectionAvailable = false;
      monitor.updateState({ sessionReady: false, waitingForHost: true, phase: 'waiting-host' });
      await maybeSendAssistantMessage(
        planningContext,
        'The host connection is not ready yet. I will retry once the host is available.'
      );
      await ensureSessionReady('runtime-action');
      requestDeferredReplan('runtime-action');
      return;
    }

    if (outcome.ok && action.type === 'tool.call' && plannedToolName === 'prev') {
      if (decision.backtrackContinuation) {
        setActiveBacktrackContinuation(decision.backtrackContinuation, 'prev-action-committed', {
          trigger,
          stage: planningContext.stage,
        });
      }
      // If the planner called prev without an explicit continuation but one was already active,
      // preserve it — the prev is continuing the same backtrack. The continuation is cleared
      // elsewhere when the planner takes a non-prev action, the user sends a message, or a
      // user-driven stage change occurs.
    }

    memory.addRecord({
      timestamp: new Date().toISOString(),
      stage: planningContext.stage,
      actionType: action.type,
      ok: outcome.ok,
      code: outcome.code,
      reason: action.reason,
    });

    if (outcome.ok && action.type === 'tool.call' && toolName === 'filter') {
      const params =
        action.payload.params && typeof action.payload.params === 'object' && !Array.isArray(action.payload.params)
          ? (action.payload.params as Record<string, unknown>)
          : {};
      const filterExpression = toFilterExpression(params);
      const snapshot = buildFilterTrackingSnapshot(planningContext);
      const preferenceBindings = memory.getPreferenceBindings(decision.actionPreferenceIds ?? []);
      if (filterExpression && snapshot && preferenceBindings.length > 0) {
        const timestamp = new Date().toISOString();
        memory.recordStageFilter(
          snapshot,
          {
            filter: filterExpression,
            preferenceBindings,
          },
          timestamp
        );
        monitor.pushEvent('memory.stage_alternatives_updated', {
          trigger,
          toolName,
          stage: snapshot.stage,
          parentContextKey: snapshot.parentContextKey,
          preferenceIds: preferenceBindings.map((item) => item.id),
        });
      }
    }

    if (outcome.ok && action.type === 'tool.call' && toolName === 'highlight') {
      const params =
        action.payload.params && typeof action.payload.params === 'object' && !Array.isArray(action.payload.params)
          ? (action.payload.params as Record<string, unknown>)
          : {};
      const snapshot = buildFilterTrackingSnapshot(planningContext);
      const itemIds = toHighlightItemIds(params);
      const preferenceBindings = memory.getPreferenceBindings(decision.actionPreferenceIds ?? []);
      const coverage = decision.actionHighlightCoverage;
      if (snapshot && itemIds.length > 0 && coverage && (preferenceBindings.length > 0 || coverage === 'full')) {
        const timestamp = new Date().toISOString();
        memory.recordStageHighlight(
          snapshot,
          {
            itemIds,
            coverage,
            preferenceBindings,
          },
          timestamp
        );
        monitor.pushEvent('memory.stage_alternatives_updated', {
          trigger,
          toolName,
          stage: snapshot.stage,
          parentContextKey: snapshot.parentContextKey,
          preferenceIds: preferenceBindings.map((item) => item.id),
          coverage,
        });
      }
    }

    if (outcome.ok && action.type === 'tool.call' && toolName === 'clearModification') {
      const params =
        action.payload.params && typeof action.payload.params === 'object' && !Array.isArray(action.payload.params)
          ? (action.payload.params as Record<string, unknown>)
          : {};
      const clearType = readNonEmptyString(params.type);
      if (!clearType || clearType === 'filter' || clearType === 'all') {
        const snapshot = buildFilterTrackingSnapshot(planningContext);
        if (snapshot) {
          memory.clearStageFilters(snapshot.stage, snapshot.parentContextKey);
          monitor.pushEvent('memory.stage_alternatives_cleared', {
            trigger,
            toolName,
            stage: snapshot.stage,
            parentContextKey: snapshot.parentContextKey,
            clearType: clearType ?? 'all',
          });
        }
      }
      if (!clearType || clearType === 'highlight' || clearType === 'all' || clearType === 'filter') {
        const snapshot = buildFilterTrackingSnapshot(planningContext);
        if (snapshot) {
          memory.clearStageHighlight(snapshot.stage, snapshot.parentContextKey);
        }
      }
    }

    if (
      outcome.ok &&
      action.type === 'tool.call' &&
      toolName === 'prev'
    ) {
      if (previousLastAgentToolName !== 'prev') {
        const attemptedBranch = buildAttemptedBranchForBacktrack(
          planningContext,
          action.reason ?? ''
        );
        if (attemptedBranch) {
          memory.recordAttemptedBranch(attemptedBranch);
          monitor.pushEvent('memory.attempted_branches_updated', {
            trigger,
            toolName,
            attemptedBranches: memory.getAttemptedBranches(),
          });
        }
      }
      if (pendingBacktrackConflict) {
        const timestamp = new Date().toISOString();
        const deadEnd = materializeDeadEndFromPendingConflict(pendingBacktrackConflict, timestamp);
        memory.upsertDeadEnds([deadEnd]);
        syncMonitorMemoryState();
        monitor.pushEvent('memory.dead_ends_updated', {
          trigger,
          toolName,
          source: 'pending-conflict',
          deadEnds: memory.getDeadEnds(),
          consumedPendingConflict: pendingBacktrackConflict,
        });
        setPendingBacktrackConflict(null, 'consumed-by-backtrack', {
          trigger,
          toolName,
          stage: planningContext.stage,
        });
      }
    }

    if (!outcome.ok) {
      const friendly = (() => {
        const msg = outcome.message ?? '';
        if (msg.includes('filter would leave no visible items')) {
          return "None of the options match that filter. Let me try a different approach.";
        }
        return `Something went wrong — let me try again.`;
      })();
      await maybeSendAssistantMessage(planningContext, friendly);
    }
    const shouldResyncAfterSuccess =
      outcome.ok && action.type === 'tool.call' && toolName !== 'next' && toolName !== 'prev';
    const shouldResyncNow = shouldResync(action, outcome) || shouldResyncAfterSuccess;
    if (shouldResyncNow) {
      monitor.pushEvent('state.resync_requested', {
        reason: outcome.ok ? 'post-action' : 'error',
        code: outcome.code,
      });
      await relay.request('snapshot.get', {});
    }

    if (decisionExplainText.trim()) {
      pendingReadingDelayUntil = Date.now() + computeReadingDelay(decisionExplainText);
    }

    if (action.type === 'session.end' && outcome.ok) {
      monitor.updateState({ phase: 'ended' });
      relay.close();
      monitor.close();
      process.exit(0);
    }
  } catch (error) {
    monitor.pushEvent('action.exception', {
      message: error instanceof Error ? error.message : String(error),
    });
    if (isControlFlowCancellation(error)) {
      monitor.pushEvent('planner.cancelled', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!fatalErrorMessage) {
      enterFatalState('plan-or-action-cycle', error);
    }
  } finally {
    actionInFlight = false;
    planningInFlight = false;
    monitor.updateState({ actionInFlight: false, phase: 'ready' });
    if (fatalErrorMessage) {
      sendAgentStatus('idle', {
        stage: (memory.getContext() ?? context)?.stage ?? null,
        trigger,
      });
      deferredReplanRequested = false;
      deferredReplanTrigger = null;
      monitor.updateState({ pendingUserMessages: 0, phase: 'error' });
      return;
    }
    if (deferredReplanRequested) {
      const deferredTrigger = deferredReplanTrigger ?? trigger;
      deferredReplanRequested = false;
      deferredReplanTrigger = null;
      monitor.updateState({ pendingUserMessages: 0 });
      queueMicrotask(() => {
        void maybePlanAndExecute(`deferred:${deferredTrigger}`);
      });
      return;
    }
    sendAgentStatus('idle', {
      stage: (memory.getContext() ?? context)?.stage ?? null,
      trigger,
    });
  }
}

function upsertContext(next: PerceivedContext): void {
  memory.setContext(next);
  const snapshot = buildFilterTrackingSnapshot(next);
  if (snapshot) {
    memory.upsertStageAlternativeSnapshot(snapshot, new Date().toISOString());
  }
}

function resetRuntimeState(): void {
  rejectPerceptionWaiters('session-reset');
  memory.reset();
  syncMonitorMemoryState();
  actionInFlight = false;
  planningInFlight = false;
  currentAgentStatusPhase = 'idle';
  sendAgentStatus('idle', { trigger: 'session-reset' });
  deferredReplanRequested = false;
  deferredReplanTrigger = null;
  userTurnAwaitingStateUpdate = false;
  userPreferenceExtractionInFlight = null;
  userConversationStarted = false;
  fatalErrorMessage = null;
  perceptionVersion = 0;
  lastUiFingerprint = null;
  isFirstSnapshotSeen = false;
  pendingBacktrackConflict = null;
  activeBacktrackContinuation = null;
  suppressNavigationToolsOnce = false;
  lastActionFingerprint = '';
  lastAgentToolName = null;
  lastActionAt = 0;
  // A barrier or reading delay left armed from the previous trial would
  // otherwise leak into the next one — the study resets between trials.
  pendingReadingDelayUntil = 0;
  speechBarrier.release('session-reset');
  monitor.updateState({
    phase: 'ready',
    actionInFlight: false,
    contextStage: null,
    lastUserMessage: null,
    lastTrigger: null,
    lastPlan: null,
    lastOutcome: null,
    pendingUserMessages: 0,
  });
}

async function handleInbound(envelope: RelayEnvelope): Promise<void> {
  monitor.pushEvent('relay.inbound', {
    type: envelope.type,
    replyTo: envelope.replyTo,
  });

  switch (envelope.type) {
    case 'relay.presence': {
      const payload = asRecord(envelope.payload);
      const hostActive = payload.hostActive === true;
      hostConnectionAvailable = hostActive;
      monitor.pushEvent('session.presence', {
        hostActive,
        agentCount: typeof payload.agentCount === 'number' ? payload.agentCount : null,
      });
      if (!sessionReady && hostActive) {
        monitor.updateState({ waitingForHost: false, phase: 'starting-session' });
        void ensureSessionReady('host-presence').catch((error) => {
          monitor.pushEvent('session.presence_start_failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return;
    }
    case 'snapshot.state': {
      const previous = memory.getContext();
      const snapshot = toSnapshotPayload(envelope.payload);
      const next = fromSnapshot(snapshot);
      if (previous?.lastUserMessage) {
        next.lastUserMessage = previous.lastUserMessage;
      }
      upsertContext(next);
      lastUiFingerprint = buildUiFingerprint(next.uiSpec);
      isFirstSnapshotSeen = true;
      syncUserConversationStarted(next);
      markPerceptionUpdated();
      monitor.updateContext(memory.getContext());
      await maybePlanAndExecute('snapshot.state');
      return;
    }
    case 'state.updated': {
      const current = memory.getContext();
      if (!current) return;
      const next = applyStateUpdated(current, toStateUpdatedPayload(envelope.payload));
      const cpMemoryEnabled = isPlannerCpMemoryEnabled(next.plannerCpMemoryLimit);
      const stageChanged = next.stage !== current.stage;
      const userDrivenSelectionTransition = isUserDrivenSelectionTransition(
        current.stage,
        next.messageHistoryTail
      );
      // When an agent action is in flight (e.g. prev executing), the resulting
      // backward stage change is agent-driven, not user-driven. Checking actionInFlight
      // prevents a race where lastAgentToolName has not yet been updated to 'prev' when
      // the state.updated arrives during the executePlannedAction await.
      const userDrivenNavigationTransition = !actionInFlight && isUserDrivenNavigationTransition(
        current.stage,
        next.stage,
        lastAgentToolName
      );
      const currentWorkflowStage = toWorkflowStage(current.stage ?? null);
      const nextWorkflowStage = toWorkflowStage(next.stage ?? null);
      if (stageChanged && currentWorkflowStage && nextWorkflowStage) {
        const currentIndex = WORKFLOW_STAGE_ORDER.indexOf(currentWorkflowStage);
        const nextIndex = WORKFLOW_STAGE_ORDER.indexOf(nextWorkflowStage);
        if (nextIndex > currentIndex) {
          const committedSelection = resolveCommittedSelectionFromContext({
            stage: currentWorkflowStage,
            uiSpec: current.uiSpec,
          });
          if (committedSelection !== null) {
            memory.commitWorkflowSelection(currentWorkflowStage, committedSelection);
          }
          memory.clearCommittedWorkflowAfter(currentWorkflowStage);
        } else if (nextIndex < currentIndex) {
          if (nextWorkflowStage === 'movie') {
            memory.clearCommittedWorkflow();
          } else {
            memory.clearCommittedWorkflowAfter(nextWorkflowStage);
          }
        }
      }
      const nextUiFingerprint = buildUiFingerprint(next.uiSpec);
      lastUiFingerprint = nextUiFingerprint;
      upsertContext(next);
      syncUserConversationStarted(next);
      markPerceptionUpdated();
      monitor.updateContext(memory.getContext());

      if (userTurnAwaitingStateUpdate) {
        userTurnAwaitingStateUpdate = false;
        if (cpMemoryEnabled && userPreferenceExtractionInFlight) {
          monitor.pushEvent('planner.waiting_preference_extraction', {
            trigger: 'state.updated:user-message',
          });
          await userPreferenceExtractionInFlight;
        }
        await maybePlanAndExecute('state.updated:user-message');
        return;
      }

      if (stageChanged) {
        const stageChangeOriginTool = lastAgentToolName;
        if (userDrivenSelectionTransition || userDrivenNavigationTransition) {
          lastAgentToolName = null;
          if (activeBacktrackContinuation) {
            setActiveBacktrackContinuation(null, 'user-driven-stage-change', {
              fromStage: current.stage,
              toStage: next.stage,
            });
          }
          if (userDrivenNavigationTransition) {
            setSuppressNavigationToolsOnce(true, 'user-driven-navigation-stage-change', {
              fromStage: current.stage,
              toStage: next.stage,
            });
          }
        }
        if (pendingBacktrackConflict) {
          setPendingBacktrackConflict(null, 'stage-changed', {
            stage: next.stage,
          });
        }
        await maybePlanAndExecute('state.updated:stage-change');
        // Reset lastAgentToolName if it wasn't changed during the await.
        // Exception: prev can chain across multiple stages (multi-stage
        // backtrack), so keep the value alive — otherwise the next state.updated
        // misidentifies the agent-driven navigation as user-driven.
        if (
          lastAgentToolName === stageChangeOriginTool &&
          stageChangeOriginTool !== 'prev'
        ) {
          lastAgentToolName = null;
        }
        return;
      }

      monitor.pushEvent('planner.ignored_state_updated', {
        stage: next.stage,
        reason: 'no-user-turn-and-no-stage-change',
      });
      return;
    }
    case 'user.message': {
      const current = memory.getContext();
      if (!current) return;
      const userMessage = toUserMessagePayload(envelope.payload);
      if (!userMessage.text.trim()) return;
      userConversationStarted = true;
      lastAgentToolName = null;
      if (activeBacktrackContinuation) {
        setActiveBacktrackContinuation(null, 'user-message', {
          stage: current.stage,
        });
      }
      if (suppressNavigationToolsOnce) {
        setSuppressNavigationToolsOnce(false, 'user-message', {
          stage: current.stage,
        });
      }
      const next = applyUserMessage(current, userMessage);
      const cpMemoryEnabled = isPlannerCpMemoryEnabled(next.plannerCpMemoryLimit);
      upsertContext(next);
      monitor.updateContext(memory.getContext());
      monitor.updateState({ pendingUserMessages: 0 });
      // Set this before async extraction so fast state.updated events cannot bypass planning.
      // Planning still waits for state.updated to keep timeline-consistent history.
      userTurnAwaitingStateUpdate = true;
      monitor.pushEvent('planner.waiting_state_updated_after_user_message', {
        stage: userMessage.stage ?? null,
      });
      if (!cpMemoryEnabled) {
        return;
      }
      const extractionPromise = runPreferenceExtractionFromUserMessage(next, userMessage.text);
      userPreferenceExtractionInFlight = extractionPromise.finally(() => {
        if (userPreferenceExtractionInFlight === extractionPromise) {
          userPreferenceExtractionInFlight = null;
        }
      });
      await userPreferenceExtractionInFlight;
      return;
    }
    case 'voice.mode': {
      const payload = asRecord(envelope.payload);
      const wasEnabled = voiceModeEnabled;
      voiceModeEnabled = payload?.enabled === true;
      if (wasEnabled && !voiceModeEnabled) {
        // Voice was switched off (including the by-design auto-disable at the
        // confirm step). Nothing will report playback any more, so waiting out
        // the 15s timeout would just freeze the agent.
        speechBarrier.release('voice-mode-disabled');
      }
      monitor.pushEvent('voice.mode', { enabled: voiceModeEnabled });
      return;
    }
    case 'tts.playback.complete': {
      const payload = asRecord(envelope.payload);
      speechBarrier.noteCompletion({
        messageId: typeof payload?.messageId === 'string' ? payload.messageId : null,
        interrupted: payload?.interrupted === true,
      });
      return;
    }
    case 'session.reset': {
      resetRuntimeState();
      monitor.pushEvent('session.reset', {
        source: 'host',
        payload: envelope.payload ?? null,
      });
      try {
        await relay.request('snapshot.get', {});
      } catch (error) {
        monitor.pushEvent('session.reset_snapshot_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    case 'session.ended': {
      monitor.updateState({ phase: 'ended' });
      relay.close();
      monitor.close();
      process.exit(0);
    }
    default:
      return;
  }
}

async function main(): Promise<void> {
  await monitor.start();
  monitor.updateState({ phase: 'monitor-ready' });
  syncMonitorMemoryState();
  const activeMonitorPort = getMonitorApiPort();
  monitor.pushEvent('runtime.start', {
    relayUrl,
    sessionId,
    studyMode,
    routingMode: 'planner',
    monitorEnabled: monitor.isEnabled(),
    monitorPort: activeMonitorPort,
  });

  relay.messages.subscribe(handleInbound);
  await ensureRelayConnected();
  monitor.updateState({
    waitingForHost: !hostConnectionAvailable,
    sessionReady: false,
    phase: hostConnectionAvailable ? 'starting-session' : 'idle-waiting-host',
  });
  if (hostConnectionAvailable) {
    await ensureSessionReady('startup');
  }
}

process.on('SIGINT', () => {
  monitor.pushEvent('runtime.signal', { signal: 'SIGINT' });
  rejectPerceptionWaiters('terminated-by-signal');
  unsubscribeAllLlmTraces();

  relay.close();
  monitor.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  monitor.pushEvent('runtime.signal', { signal: 'SIGTERM' });
  rejectPerceptionWaiters('terminated-by-signal');
  unsubscribeAllLlmTraces();

  relay.close();
  monitor.close();
  process.exit(0);
});

void main().catch((error) => {
  monitor.pushEvent('runtime.fatal', {
    message: error instanceof Error ? error.message : String(error),
  });
  unsubscribeAllLlmTraces();
  monitor.close();
  console.error(`[tuning-agent] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
