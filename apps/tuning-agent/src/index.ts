import { createSpeechBarrier } from './core/speechBarrier';
import { resolveOpenAIModel, setSessionPlannerModel } from './llm/modelSelection';
import { executePlannedAction } from './core/executor';
import { AgentMemory } from './core/memory';
import { applyStateUpdated, applyUserMessage, fromSnapshot } from './core/perception';
import { planNextAction } from './core/planner';
import { agentNotice } from './core/agentNotices';
import { planWithEmptyRespondGuard } from './core/emptyRespond';
import {
  buildViewFingerprint,
  createTurnRepeatGuard,
  MAX_ACTIONS_PER_TURN,
} from './core/repeatGuard';
import {
  getPlannerSystemPrompt,
  isSupportedConversationLanguage,
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
import { createStudyAgentRuntimeLogWriterFromEnv } from './runtime/studyAgentRuntimeLog';
import { AgentMonitorServer } from './monitor/server';
import { CONFLICT_STAGES } from './types';
import type {
  BacktrackContinuation,
  ConflictMemory,
  ConflictScope,
  ConflictStage,
  AttemptedBranch,
  FilterExpression,
  PlanDecision,
  PerceivedContext,
  AgentMemorySnapshot,
  Preference,
  PreferenceProfilePayload,
  RelayEnvelope,
  RevokedAdaptation,
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
// Minted per session by the backend that spawns this process. Without it the
// relay refuses the agent role outright — see RelayClientOptions.agentToken.
const agentToken = process.env.AGENT_RELAY_TOKEN || '';
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
const relay = new RelayClient({
  relayUrl,
  sessionId,
  agentToken,
  agentName,
  requestTimeoutMs: 12000,
});
const studyLlmTraceLog = createStudyLlmTraceLogWriterFromEnv();
// Whether the live monitor gets a copy of each LLM request/response. Only the
// monitor: the study trace file is the research record and is decided by the
// visitor's consent (AGENT_LLM_TRACE_FILE), never by this flag. The two used to
// share one gate inside the emitters, so a backend started from a .env with
// this false produced consented sessions with no trace file at all.
const monitorLlmTraceEnabled = parseBooleanEnv(process.env.AGENT_MONITOR_LLM_TRACE) ?? true;
const studyAgentRuntimeLog = createStudyAgentRuntimeLogWriterFromEnv();
const monitor = new AgentMonitorServer({
  enabled: monitorEnabled,
  // Durable even when the live monitor is off, which it is in production.
  sink: studyAgentRuntimeLog.enabled ? studyAgentRuntimeLog.append : undefined,
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
  if (monitorLlmTraceEnabled) {
    const systemPrompt = extractSystemPromptFromTracePayload(event.payload);
    if (event.type === 'request' && systemPrompt && (component === 'planner' || component === 'extractor')) {
      monitor.updateLlmSystemPrompt(component, systemPrompt);
    }
    monitor.pushEvent(monitorEventType, event.payload);
  }
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
// The language the visitor is conversing in, as the host reports it. English
// until told otherwise, which is what every study session was.
let conversationLanguage = 'en';
/**
 * How long the last LLM-sourced planning call took, and on which model. Set
 * after each `planNextAction` that went to the model, attached to the next
 * `agent.message` the host receives, then cleared -- so the number the visitor
 * sees beside a sentence is the time it took to decide that sentence, not a
 * stale one from an earlier turn. Rule-sourced decisions leave it null.
 */
let lastPlannerTiming: { model: string; plannerMs: number } | null = null;
/**
 * The visitor spoke and nothing has been said to them since. Set by
 * `user.message`, cleared by the first `agent.message` the host accepts. The
 * booth's empty-respond guard (core/emptyRespond.ts) reads it: an empty respond
 * while this is true would end the visitor's turn in silence.
 */
let userTurnAwaitingAnswer = false;
let ensureSessionReadyInFlight: Promise<void> | null = null;
let sessionReady = false;
let hostConnectionAvailable = false;
let connectedOnce = false;
let planningInFlight = false;
let deferredReplanRequested = false;
let deferredReplanTrigger: string | null = null;
let userTurnAwaitingStateUpdate = false;
/**
 * Set when a hand removal revoked something on screen, so the replan waits for
 * the host to actually un-apply it.
 *
 * Replanning inside the removal handler would plan against the screen the
 * visitor just un-filtered, and the corrected `state.updated` that follows
 * carries no user turn and no stage change — which the handler below drops.
 */
let userEditAwaitingStateUpdate = false;
let userEditReplanTimer: ReturnType<typeof setTimeout> | null = null;
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

/**
 * Everything the planner has already done since the last user message. A turn
 * fans out into several planner calls (see repeatGuard.ts), and nothing else in
 * this loop remembers across them — `lastActionFingerprint` only covers a 700ms
 * window, which five LLM round-trips comfortably outlast.
 */
const turnRepeatGuard = createTurnRepeatGuard();

/**
 * Opens a new turn. Called from every trigger that means the ledger no longer
 * describes what the agent is answering: a user message, a stage change, and a
 * hand edit to memory (each of which changes the screen or the goal).
 */
function resetTurnRepeatGuard(reason: string): void {
  // Only worth an event when there was actually a turn to close; the common
  // case is a fresh guard being reset again by the next trigger in the chain.
  const hadTurn = turnRepeatGuard.executedCount() > 0 || turnRepeatGuard.isSettled();
  turnRepeatGuard.reset(reason);
  if (hadTurn) {
    monitor.pushEvent('planner.turn_reset', { reason });
  }
}

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

let lastPublishedMemoryFingerprint = '';

function buildMemorySnapshot(
  reason: string,
  revokedAdaptations: RevokedAdaptation[] = []
): AgentMemorySnapshot {
  return {
    updatedAt: new Date().toISOString(),
    reason,
    forgottenPreferences: memory.getForgottenPreferences(),
    revokedAdaptations,
    stage: memory.getContext()?.stage ?? null,
    preferences: memory.getPreferences(),
    deadEnds: memory.getDeadEnds(),
    attemptedBranches: memory.getAttemptedBranches(),
    committedWorkflow: memory.getCommittedWorkflowState(),
    pendingConflict: pendingBacktrackConflict
      ? {
          preferenceIds: pendingBacktrackConflict.preferenceIds.slice(),
          description: pendingBacktrackConflict.description,
          scope: { ...pendingBacktrackConflict.scope },
          createdAt: pendingBacktrackConflict.createdAt,
        }
      : null,
    backtrackContinuation: activeBacktrackContinuation
      ? { ...activeBacktrackContinuation }
      : null,
    stageBindings: memory.getStageBindings(),
  };
}

/**
 * Publishes agent memory to both consumers: the researcher monitor, and — this
 * is the part the demo needs — the host UI, which renders preference memory and
 * workflow navigation as panels instead of leaving them buried in the planner.
 *
 * Content-deduped, so the call sites below can be liberal: publishing on every
 * planner cycle costs nothing when nothing changed.
 */
function syncMonitorMemoryState(
  reason = 'memory-changed',
  revokedAdaptations: RevokedAdaptation[] = []
): void {
  monitor.updateMemory(memory.getPreferences(), memory.getDeadEnds());

  const snapshot = buildMemorySnapshot(reason, revokedAdaptations);
  const { updatedAt: _updatedAt, reason: _reason, ...comparable } = snapshot;
  const fingerprint = JSON.stringify(comparable);
  if (fingerprint === lastPublishedMemoryFingerprint) return;
  lastPublishedMemoryFingerprint = fingerprint;

  try {
    relay.send('agent.memory', snapshot as unknown as Record<string, unknown>);
  } catch {
    // Host disconnections should not fail the planner loop.
  }
}

/**
 * Publishes memory even when nothing the fingerprint covers has moved.
 *
 * A removal the store had already rejected — the visitor clicking twice, or a
 * duplicate envelope — leaves the comparable snapshot byte-identical, and the
 * content dedupe above would withhold the publish. The panel is waiting on that
 * echo to clear its pending state, so it would sit spinning on a removal that
 * had in fact already happened.
 */
function publishMemoryNow(reason: string, revokedAdaptations: RevokedAdaptation[] = []): void {
  lastPublishedMemoryFingerprint = '';
  syncMonitorMemoryState(reason, revokedAdaptations);
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
  syncMonitorMemoryState(`pending-conflict:${reason}`);
}

const USER_EDIT_REPLAN_FALLBACK_MS = 2000;

function clearUserEditReplanTimer(): void {
  if (userEditReplanTimer === null) return;
  clearTimeout(userEditReplanTimer);
  userEditReplanTimer = null;
}

/**
 * Waits for the host to un-apply what the removal revoked, then replans.
 *
 * The fallback timer is not belt-and-braces: the host prunes only the filters
 * it can match, so a revocation naming a filter that is no longer on the spec
 * produces no state change and therefore no `state.updated` at all. Without the
 * timer the agent would sit holding a replan that never fires.
 */
function awaitHostUnapplyThenReplan(reason: string): void {
  userEditAwaitingStateUpdate = true;
  clearUserEditReplanTimer();
  userEditReplanTimer = setTimeout(() => {
    userEditReplanTimer = null;
    if (!userEditAwaitingStateUpdate) return;
    userEditAwaitingStateUpdate = false;
    monitor.pushEvent('planner.user_edit_replan_fallback', { reason });
    void maybePlanAndExecute(`${reason}:fallback`);
  }, USER_EDIT_REPLAN_FALLBACK_MS);
}

/**
 * Drops navigation state that pointed at a preference which no longer exists.
 *
 * These two live in module state rather than in the store, so `setPreferences`
 * cannot reach them — a conflict banner naming a removed preference would
 * otherwise stay on the rail after the chip it refers to is gone.
 */
function prunePreferenceReferences(preferenceId: string): void {
  if (pendingBacktrackConflict) {
    const remaining = pendingBacktrackConflict.preferenceIds.filter((id) => id !== preferenceId);
    if (remaining.length === 0) {
      setPendingBacktrackConflict(null, 'preference-removed', { preferenceId });
    } else if (remaining.length !== pendingBacktrackConflict.preferenceIds.length) {
      setPendingBacktrackConflict(
        { ...pendingBacktrackConflict, preferenceIds: remaining },
        'preference-removed',
        { preferenceId }
      );
    }
  }
  if (activeBacktrackContinuation && !pendingBacktrackConflict) {
    setActiveBacktrackContinuation(null, 'preference-removed', { preferenceId });
  }
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
  syncMonitorMemoryState(`backtrack-continuation:${reason}`);
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
    narrateAdaptations:
      typeof payload.narrateAdaptations === 'boolean' ? payload.narrateAdaptations : undefined,
    spokenBrevity:
      typeof payload.spokenBrevity === 'boolean' ? payload.spokenBrevity : undefined,
    stageMeta: parseStageMeta(payload.stageMeta),
    preferenceProfile: parsePreferenceProfile(payload.preferenceProfile),
  };
}

/**
 * Coerces a host-supplied preference profile, refusing anything the store would
 * otherwise swallow without a word.
 *
 * An entry with no recognised stage is dropped rather than passed on: an empty
 * `relevantStages` does not scope a preference to nothing, it WIDENS it to all
 * six stages, so a typo would silently turn a seat requirement into one the
 * planner applies while picking the movie.
 */
function parsePreferenceProfile(value: unknown): PreferenceProfilePayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const revision =
    typeof record.revision === 'number' && Number.isFinite(record.revision)
      ? Math.floor(record.revision)
      : 0;
  if (revision <= 0) return null;

  const preferences: Preference[] = [];
  for (const entry of Array.isArray(record.preferences) ? record.preferences : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    if (!id || !description) continue;
    const relevantStages = (Array.isArray(item.relevantStages) ? item.relevantStages : []).filter(
      (stage): stage is ConflictStage =>
        typeof stage === 'string' && (CONFLICT_STAGES as readonly string[]).includes(stage)
    );
    if (relevantStages.length === 0) continue;
    preferences.push({
      id,
      description,
      strength: item.strength === 'soft' ? 'soft' : 'hard',
      relevantStages,
    });
  }
  return { revision, preferences };
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
    narrateAdaptations:
      typeof payload.narrateAdaptations === 'boolean' ? payload.narrateAdaptations : undefined,
    spokenBrevity:
      typeof payload.spokenBrevity === 'boolean' ? payload.spokenBrevity : undefined,
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
    language: conversationLanguage,
    // Absent outside the booth, so a study session's extractor prompt is the
    // one the study ran (see boothStageFieldGuides).
    ...(isDemoMode ? { demoSession: true } : {}),
  };

  try {
    const updatedPreferences = await extractStructuredPreferences(extractionCtx);
    memory.setPreferences(updatedPreferences);

    syncMonitorMemoryState('preference-extraction');
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

/**
 * `category` names what the message is narrating — the tool it accompanies, or
 * `respond`/`system`. The protocol documents it as optional and the host falls
 * back to classifying the text, but that classifier is English regex tuned on
 * the English study corpus; there is no Korean corpus to tune against, so for a
 * Korean session the tag is the only accurate routing there is.
 */
function buildAgentMessageAction(
  text: string,
  category: string
): import('./types').PlannedAction {
  // Additive and optional, like `category`: a host that does not know the
  // field ignores it. Consumed here so the next message cannot reuse it.
  const timing = lastPlannerTiming;
  lastPlannerTiming = null;
  return {
    type: 'agent.message',
    reason: 'Provide a concise assistant response to the user.',
    payload: {
      text,
      category,
      ...(timing ? { timing } : {}),
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

/**
 * Kana and Han. Japanese and Chinese have no spaces, so a whitespace word count
 * reads a whole sentence as one word and the delay collapses to the floor.
 */
const NO_SPACE_SCRIPT = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
/** Characters per English word, for speech: about 310 characters a minute against 155 words. */
const NO_SPACE_CHARS_PER_WORD = 2;

function computeReadingDelay(text: string): number {
  // Text with no kana or Han counts exactly as it always did; Japanese or
  // Chinese counts its characters, plus any Latin words (titles) between them.
  const noSpaceChars = text.match(NO_SPACE_SCRIPT)?.length ?? 0;
  const wordCount =
    noSpaceChars === 0
      ? text.trim().split(/\s+/).filter(Boolean).length
      : noSpaceChars / NO_SPACE_CHARS_PER_WORD +
        text.replace(NO_SPACE_SCRIPT, ' ').trim().split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
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

async function maybeSendAssistantMessage(
  context: PerceivedContext,
  text: string,
  category: string
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const action = buildAgentMessageAction(trimmed, category);
  if (!isActionSafe(context, action)) return;
  const outcome = await executePlannedAction(relay, action);
  if (outcome.ok) {
    noteAgentSpeechSent();
    userTurnAwaitingAnswer = false;
  }
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

  /*
    The turn was settled by a repeat suppression or the per-turn budget. Every
    trigger that can still arrive for it — the resync snapshot, a deferred
    replan queued before the suppression — would plan against the same screen
    and reach the same conclusion. Only a reset (user message, stage change,
    hand edit, session reset) opens the next turn.
  */
  if (turnRepeatGuard.isSettled()) {
    monitor.pushEvent('planner.turn_settled_skip', {
      trigger,
      stage: context.stage ?? null,
    });
    return;
  }
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
    const plannerStartedAt = Date.now();
    /*
      Booth only: an empty respond is never how the visitor's turn ends (KSEA
      run C1v, 90 s of silence). Planned once more with a note, and if that is
      empty too, the stage's question in the session language stands in for
      it. A study session plans exactly once, as before.
    */
    const guarded = await planWithEmptyRespondGuard(
      planningContext,
      (context) =>
        planNextAction(
          context,
          memory,
          lastAgentToolName,
          activeBacktrackContinuation,
          suppressNavigationTools,
          conversationLanguage
        ),
      {
        enabled: isDemoMode,
        userTurnAwaitingAnswer,
        language: conversationLanguage,
        onStep: (step, stepDecision, replanned) => {
          if (step.kind === 'accept') return;
          monitor.pushEvent(step.kind === 'replan' ? 'planner.empty_respond_replan' : 'planner.empty_respond_fallback', {
            trigger,
            stage: planningContext.stage ?? null,
            replanned,
            reason: stepDecision.action?.reason ?? null,
            ...(step.kind === 'fallback' ? { text: step.text } : {}),
          });
        },
      }
    );
    const decision: PlanDecision = guarded.decision;
    lastPlannerTiming =
      decision.source === 'llm'
        ? { model: resolveOpenAIModel(), plannerMs: Date.now() - plannerStartedAt }
        : null;
    const action = decision.action;
    // Non-empty only for a respond that came back empty twice: see above.
    const decisionExplainText = (decision.explainText ?? '').trim()
      ? (decision.explainText ?? '')
      : guarded.fallbackText;
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
      /*
        Booth only: the closing respond often repeats, word for word, the
        sentence the visitor just heard on the GUI step before it (quick card
        1, 2026-10-24: "3개는 PG 조건 때문에 숨겨져 있어요. 둘 중 어떤 영화를
        볼까요?" on the highlight, then again as the respond). The tool path
        already drops an exact repeat within a turn; this is the same rule for
        the respond. A study session speaks it as before.
      */
      if (isDemoMode && decisionExplainText.trim() && turnRepeatGuard.hasSpoken(decisionExplainText)) {
        monitor.pushEvent('assistant_message.repeat_suppressed', {
          trigger,
          text: decisionExplainText.trim(),
        });
      } else if (decisionExplainText.trim()) {
        await maybeSendAssistantMessage(planningContext, decisionExplainText, 'respond');
        if (isDemoMode) turnRepeatGuard.noteSpoken(decisionExplainText);
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

    /*
      The per-turn guard. It sits after the 700ms debounce because that one
      catches a double-send of the same envelope; this one catches a planner
      that keeps re-deciding the same thing across whole LLM round-trips.
    */
    const viewFingerprint = buildViewFingerprint(planningContext.uiSpec);
    const guardVerdict =
      action.type === 'tool.call'
        ? turnRepeatGuard.evaluate({
            toolName: plannedToolName,
            params: action.payload.params,
            viewFingerprint,
            assistantMessage: decisionExplainText,
          })
        : null;

    if (guardVerdict && guardVerdict.kind !== 'execute') {
      /*
        A suppressed action may still carry something worth saying — but only if
        it is not the sentence the visitor already heard this turn. "Applying
        your 10:00 PM start and 3D requirements", spoken five times, is what
        this dedupe is for.
      */
      if (guardVerdict.speak && decisionExplainText.trim()) {
        if (readingDelayPromise) await readingDelayPromise;
        await maybeSendAssistantMessage(planningContext, decisionExplainText, 'respond');
        turnRepeatGuard.noteSpoken(decisionExplainText);
      }
      monitor.pushEvent(
        guardVerdict.kind === 'repeat' ? 'planner.repeat_suppressed' : 'planner.turn_budget_exhausted',
        {
          trigger,
          stage: planningContext.stage ?? null,
          signature: guardVerdict.signature,
          ...(guardVerdict.kind === 'repeat'
            ? { repeatCount: guardVerdict.repeatCount }
            : { executedCount: guardVerdict.executedCount, limit: MAX_ACTIONS_PER_TURN }),
          spoke: guardVerdict.speak && decisionExplainText.trim().length > 0,
        }
      );
      // Settling here is what actually stops the cycle: the deferred replan the
      // previous action queued would otherwise re-enter with the same view.
      turnRepeatGuard.settle();
      deferredReplanRequested = false;
      deferredReplanTrigger = null;
      monitor.updateState({ pendingUserMessages: 0 });
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
      /*
        The fallback sentence exists so a planner that writes nothing cannot act
        in total silence with no account of why. Under the spoken-brevity rules
        writing nothing is a DECISION the prompt explicitly asks for — the
        screen carries the whole story and there is nothing to ask — so keeping
        the fallback there would turn every deliberate silence into "I will run
        filter next."

        Empty text stops at `maybeSendAssistantMessage`'s own guard, before the
        envelope is built, so no `agent.message` is sent and no speech-barrier
        credit is issued. That is the one thing the frontend gate cannot do: its
        silent path has to hand a credit back.
      */
      const missingMessageFallback = planningContext.spokenBrevity
        ? ''
        : `I will run ${getToolName(action)} next. Reason: ${action.reason}`;
      const spokenText = decisionExplainText || missingMessageFallback;
      // Same dedupe as the suppression path, for the actions that DO run: two
      // different tool calls narrated with one identical sentence are one
      // sentence, not two.
      if (spokenText.trim() && turnRepeatGuard.hasSpoken(spokenText)) {
        monitor.pushEvent('assistant_message.repeat_suppressed', {
          trigger,
          text: spokenText.trim(),
        });
      } else {
        await maybeSendAssistantMessage(planningContext, spokenText, toolName || 'respond');
        turnRepeatGuard.noteSpoken(spokenText);
      }
    }

    if (guardVerdict) {
      // The fingerprint the action ran AGAINST — a later identical signature is
      // a repeat only if the screen still looks like this.
      turnRepeatGuard.noteExecuted(guardVerdict.signature, viewFingerprint);
    }

    /*
      Which memory this GUI change is acting on, named on the envelope itself.

      The planner already reports the ids behind a preference-driven filter or
      highlight, and the memory snapshot records them after the fact — but
      the snapshot is keyed by the agent's own context key and lands a beat
      after the screen moves. The host wants to mark the very card the tool
      produced, so the ids ride the tool call. Only ids that resolve to a live
      preference, and only when there are any: a study session's envelope is
      unchanged whenever the planner named nothing.
    */
    const actionPreferenceIds =
      action.type === 'tool.call' && decision.actionPreferenceIds && decision.actionPreferenceIds.length > 0
        ? memory.getPreferenceBindings(decision.actionPreferenceIds).map((item) => item.id)
        : [];
    const actionToExecute =
      actionPreferenceIds.length > 0
        ? { ...action, payload: { ...action.payload, preferenceIds: actionPreferenceIds } }
        : action;

    const outcome = await executePlannedAction(relay, actionToExecute);
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
        agentNotice('hostNotReady', conversationLanguage),
        'system'
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
        syncMonitorMemoryState('dead-end-recorded');
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
          return agentNotice('filterEmpty', conversationLanguage);
        }
        return agentNotice('genericFailure', conversationLanguage);
      })();
      await maybeSendAssistantMessage(planningContext, friendly, 'system');
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
    // Attempted branches, stage filters/highlights and committed selections all
    // mutate inside the cycle above without publishing individually.
    syncMonitorMemoryState('action-cycle');
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
  actionInFlight = false;
  planningInFlight = false;
  currentAgentStatusPhase = 'idle';
  sendAgentStatus('idle', { trigger: 'session-reset' });
  deferredReplanRequested = false;
  deferredReplanTrigger = null;
  userTurnAwaitingStateUpdate = false;
  clearUserEditReplanTimer();
  userEditAwaitingStateUpdate = false;
  userPreferenceExtractionInFlight = null;
  userConversationStarted = false;
  fatalErrorMessage = null;
  perceptionVersion = 0;
  lastUiFingerprint = null;
  isFirstSnapshotSeen = false;
  pendingBacktrackConflict = null;
  activeBacktrackContinuation = null;
  suppressNavigationToolsOnce = false;
  // Published only after the navigation flags above are cleared, or the host
  // would keep showing a conflict from the previous trial.
  lastPublishedMemoryFingerprint = '';
  syncMonitorMemoryState('session-reset');
  lastActionFingerprint = '';
  lastAgentToolName = null;
  lastActionAt = 0;
  userTurnAwaitingAnswer = false;
  turnRepeatGuard.reset('session-reset');
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
      if (hostActive) {
        // A host that just (re)joined has no memory snapshot yet, and the
        // content dedupe would otherwise withhold one until something changes.
        lastPublishedMemoryFingerprint = '';
        syncMonitorMemoryState('host-presence');
      }
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
      // Seeded BEFORE the first planner call, so a preloaded memory is already
      // in place for the opening plan rather than arriving a turn late. This is
      // also what re-seeds after a reset: `memory.reset()` clears the applied
      // revision, so the next snapshot's profile counts as new again.
      if (snapshot.preferenceProfile) {
        const { applied } = memory.applyPreferenceProfile(snapshot.preferenceProfile);
        if (applied) {
          monitor.pushEvent('memory.profile_applied', {
            source: 'snapshot',
            revision: snapshot.preferenceProfile.revision,
            preferences: memory.getPreferences(),
          });
        }
      }
      syncMonitorMemoryState('state-updated');
      await maybePlanAndExecute('snapshot.state');
      return;
    }
    /*
      Removing a preference by hand.

      Applied synchronously, before any await, so it lands in the same microtask
      as the envelope: inbound handling is fire-and-forget on the relay client,
      and a removal that yielded first could interleave with an extraction
      writing back the list it captured before the visitor ever clicked.
    */
    case 'memory.preference.delete': {
      const payload = asRecord(envelope.payload);
      const preferenceId =
        typeof payload.preferenceId === 'string' ? payload.preferenceId.trim() : '';
      if (!preferenceId) return;

      const { removed, revoked } = memory.forgetPreference(preferenceId, new Date().toISOString());
      if (!removed) {
        // Already gone. Still publish, so a panel waiting on the echo settles.
        publishMemoryNow('preference-delete-noop');
        monitor.pushEvent('memory.preference_delete_ignored', { preferenceId });
        return;
      }

      prunePreferenceReferences(removed.id);
      monitor.pushEvent('memory.preference_deleted', {
        preferenceId: removed.id,
        description: removed.description,
        strength: removed.strength,
        relevantStages: removed.relevantStages,
        revokedAdaptations: revoked,
      });
      publishMemoryNow('preference-deleted', revoked);

      if (revoked.length === 0) {
        // Nothing on screen is about to change, so there is no host echo to
        // wait for and the replan can run straight away.
        resetTurnRepeatGuard('user-edit');
        await maybePlanAndExecute('memory.preference.delete');
      } else {
        awaitHostUnapplyThenReplan('memory.preference.delete');
      }
      return;
    }
    /*
      Loading a preference profile mid-session.

      The same payload the snapshot carries, pushed instead of ridden, so the
      operator can re-arm the demo for the next visitor without walking back to
      the setup screen. The revision guard still applies, so this is a no-op
      unless the profile actually changed.
    */
    case 'memory.profile.load': {
      const profile = parsePreferenceProfile(envelope.payload?.preferenceProfile);
      if (!profile) {
        monitor.pushEvent('memory.profile_load_rejected', { payload: envelope.payload ?? null });
        return;
      }
      const { applied, revoked } = memory.applyPreferenceProfile(profile);
      publishMemoryNow(applied ? 'profile-loaded' : 'profile-load-noop', revoked);
      if (!applied) return;
      monitor.pushEvent('memory.profile_applied', {
        source: 'host-push',
        revision: profile.revision,
        preferences: memory.getPreferences(),
        revokedAdaptations: revoked,
      });
      // Switching presets REPLACES the previous one's preferences, so a load can
      // strand a filter exactly the way a removal does. Same treatment: wait for
      // the host to un-apply before planning against the screen.
      if (revoked.length === 0) {
        resetTurnRepeatGuard('user-edit');
        await maybePlanAndExecute('memory.profile.load');
      } else {
        awaitHostUnapplyThenReplan('memory.profile.load');
      }
      return;
    }
    case 'memory.preference.clear': {
      const { removed, revoked } = memory.forgetAllPreferences(new Date().toISOString());
      if (removed.length === 0) {
        publishMemoryNow('preference-clear-noop');
        return;
      }
      for (const item of removed) prunePreferenceReferences(item.id);
      monitor.pushEvent('memory.preferences_cleared', {
        count: removed.length,
        preferences: removed,
        revokedAdaptations: revoked,
      });
      publishMemoryNow('preferences-cleared', revoked);
      if (revoked.length === 0) {
        resetTurnRepeatGuard('user-edit');
        await maybePlanAndExecute('memory.preference.clear');
      } else {
        awaitHostUnapplyThenReplan('memory.preference.clear');
      }
      return;
    }
    case 'memory.preference.restore': {
      const payload = asRecord(envelope.payload);
      const preferenceId =
        typeof payload.preferenceId === 'string' ? payload.preferenceId.trim() : '';
      if (!preferenceId) return;

      const restored = memory.restorePreference(preferenceId);
      publishMemoryNow(restored ? 'preference-restored' : 'preference-restore-noop');
      if (!restored) {
        monitor.pushEvent('memory.preference_restore_ignored', { preferenceId });
        return;
      }
      monitor.pushEvent('memory.preference_restored', {
        preferenceId: restored.id,
        description: restored.description,
      });
      // Nothing to un-apply — a restored preference has to earn its filter back
      // through the planner, exactly as it did the first time.
      resetTurnRepeatGuard('user-edit');
      await maybePlanAndExecute('memory.preference.restore');
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

      // The host finished un-applying what a hand removal revoked. This is the
      // first moment the screen agrees with memory, so it is the first moment
      // worth planning from.
      if (userEditAwaitingStateUpdate) {
        userEditAwaitingStateUpdate = false;
        clearUserEditReplanTimer();
        resetTurnRepeatGuard('user-edit');
        await maybePlanAndExecute('state.updated:preference-removed');
        return;
      }

      if (stageChanged) {
        // A new stage is a new screen: nothing in the ledger describes it any
        // more, and a tool that repeats here is repeating against new options.
        resetTurnRepeatGuard('stage-change');
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
          // The user moving BACKWARD after we disclosed a conflict is the user
          // carrying out the backtrack we just proposed — it confirms the
          // conflict rather than cancelling it. Discarding it here was the
          // single largest source of lost dead ends in the study: of 402
          // conflict episodes only 131 were ever recorded, and user-driven
          // backward stage changes accounted for 84 of the discards. Worse, the
          // agent would then re-propose the same dead-ended option later,
          // because nothing remembered why the user had left it.
          const nextStageIndex = WORKFLOW_STAGE_ORDER.indexOf(
            toWorkflowStage(next.stage) as (typeof WORKFLOW_STAGE_ORDER)[number]
          );
          const currentStageIndex = WORKFLOW_STAGE_ORDER.indexOf(
            toWorkflowStage(current.stage) as (typeof WORKFLOW_STAGE_ORDER)[number]
          );
          const wentBackwards =
            nextStageIndex >= 0 && currentStageIndex >= 0 && nextStageIndex < currentStageIndex;
          if (wentBackwards) {
            const deadEnd = materializeDeadEndFromPendingConflict(
              pendingBacktrackConflict,
              new Date().toISOString()
            );
            memory.upsertDeadEnds([deadEnd]);
            syncMonitorMemoryState('dead-end-recorded');
            monitor.pushEvent('memory.dead_ends_updated', {
              reason: 'user-backtracked',
              deadEnd,
            });
          }
          setPendingBacktrackConflict(
            null,
            wentBackwards ? 'user-backtracked' : 'stage-changed',
            { stage: next.stage, recorded: wentBackwards }
          );
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
      userTurnAwaitingAnswer = true;
      lastAgentToolName = null;
      resetTurnRepeatGuard('user-message');
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
    case 'conversation.language': {
      const payload = asRecord(envelope.payload);
      const next = typeof payload?.language === 'string' ? payload.language.trim() : '';
      // Unknown values fall back to English rather than reaching the planner:
      // an unrecognised language yields no prompt section, so the agent would
      // silently keep speaking English anyway. Better that it be explicit.
      conversationLanguage = isSupportedConversationLanguage(next) ? next : 'en';
      monitor.pushEvent('conversation.language', { language: conversationLanguage });
      return;
    }
    case 'planner.model': {
      // Host-owned, like the language: the visitor picked a planner model in
      // the settings sheet. An empty model clears the override and returns to
      // the environment's choice; an id off the allow-list is refused and the
      // current model stays, which the monitor event makes visible.
      const payload = asRecord(envelope.payload);
      const requested = typeof payload?.model === 'string' ? payload.model.trim() : '';
      const result = setSessionPlannerModel(requested || null);
      monitor.pushEvent('planner.model', {
        requested: requested || null,
        model: result.model,
        accepted: result.accepted,
      });
      if (!result.accepted) {
        console.warn(`[tuning-agent] planner.model refused: "${requested}" is not an allowed model.`);
      }
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
  syncMonitorMemoryState('runtime-start');
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
  relay.lifecycle.subscribe((event) => {
    monitor.pushEvent(`relay.${event.type}`, event);
    if (event.type === 'reconnected') {
      // The socket is new, so the host's view and ours may have diverged while
      // we were away. Re-establish the session rather than resuming blind.
      sessionReady = false;
      resetTurnRepeatGuard('relay-reconnected');
      monitor.updateState({ relayConnected: true, sessionReady: false, phase: 'relay-connected' });
      void ensureSessionReady('relay-reconnected').catch((error) => {
        monitor.pushEvent('relay.resync_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (event.type === 'disconnected') {
      monitor.updateState({ relayConnected: false });
      // Nothing will report playback over a dead socket.
      speechBarrier.release('relay-disconnected');
      return;
    }
    if (event.type === 'reconnect-failed') {
      enterFatalState('relay-reconnect-failed', new Error(event.message));
    }
  });
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
