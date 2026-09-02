import { resolveOpenAiApiKey } from "./openaiKey";
import { fetchOpenAiWithRetry } from "./resilientFetch";
import type {
  BacktrackContinuation,
  ConflictMemory,
  DeadEnd,
  HighlightCoverage,
  Preference,
  ToolSchemaItem,
} from "../types";

export interface PlannerWorkflowMemory {
  preferences: Preference[];
  deadEnds: Array<Pick<DeadEnd, "preferenceIds" | "scope" | "reason">>;
}

export interface PlannerWorkflow {
  currentStage: string;
  previousStage: string | null;
  priorStageAlternativeCounts?: Array<{ stage: string; count: number }>;
  nextStage: string | null;
  proceedRule: string;
  availableToolNames: string[];
  guiAdaptationEnabled?: boolean;
  state?: Record<string, unknown>;
  currentView?: Record<string, unknown>;
  backtrackContinuation?: BacktrackContinuation | null;
  cpMemoryEnabled?: boolean;
}

interface PlannerInput {
  memory?: PlannerWorkflowMemory;
  history: unknown[];
  availableTools: ToolSchemaItem[];
  workflow: PlannerWorkflow;
  stageMeta?: Array<{ stage: string; goal: string; fieldGuide: string }>;
  /**
   * The language the visitor is conversing in, as the host reported it.
   * Absent or "en" leaves the prompt exactly as it was before this existed.
   */
  language?: string;
  /**
   * A quick-demo card is running: describe each GUI adaptation out loud.
   * Absent or false leaves the prompt exactly as it was before this existed.
   *
   * A sibling of `workflow` rather than a field on it, like `language`: the
   * workflow object is serialized into the user message the model reads, and
   * this is an instruction about the prompt, not a fact about the booking.
   */
  narrateAdaptations?: boolean;
  /**
   * Write for the ear: one sentence, only what the screen does not show, and an
   * empty string when there is nothing worth saying. Voice-mode demo sessions
   * only — absent or false leaves the prompt exactly as it was.
   *
   * Mutually exclusive with `narrateAdaptations`, which asks for the opposite;
   * `buildSystemPrompt` resolves that rather than trusting the caller.
   */
  spokenBrevity?: boolean;
}

interface PlannerAction {
  type: "tool.call" | "none";
  toolName: string;
  params: Record<string, unknown>;
  reason: string;
  preferenceIds?: string[];
  coverage?: HighlightCoverage;
}

export interface PlannerOutput {
  action: PlannerAction;
  assistantMessage: string;
  conflictMemory?: ConflictMemory | null;
  backtrackContinuation?: BacktrackContinuation | null;
}

interface LlmTraceEvent {
  component: "planner";
  type: "request" | "response.raw" | "response.parsed" | "error";
  payload: unknown;
}

type LlmTraceListener = (event: LlmTraceEvent) => void;

const DEBUG_LLM = process.env.AGENT_LLM_DEBUG === "true";

function parseBooleanEnv(value: string | undefined): boolean | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

const monitorLlmTraceOverride = parseBooleanEnv(
  process.env.AGENT_MONITOR_LLM_TRACE,
);
const MONITOR_LLM_TRACE_ENABLED = monitorLlmTraceOverride ?? true;
const llmTraceListeners = new Set<LlmTraceListener>();
let llmTraceRequestSequence = 0;

function emitLlmTrace(type: LlmTraceEvent["type"], payload: unknown): void {
  if (!MONITOR_LLM_TRACE_ENABLED) return;
  const event: LlmTraceEvent = { component: "planner", type, payload };
  for (const listener of llmTraceListeners) {
    listener(event);
  }
}

export function subscribeLlmTrace(listener: LlmTraceListener): () => void {
  llmTraceListeners.add(listener);
  return () => {
    llmTraceListeners.delete(listener);
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeHighlightCoverage(value: unknown): HighlightCoverage | null {
  return value === "full" || value === "partial" ? value : null;
}

function createLlmTraceRequestId(): string {
  llmTraceRequestSequence += 1;
  return `planner-${llmTraceRequestSequence}`;
}

function formatTraceError(error: unknown): { errorMessage: string; errorName?: string } {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      ...(error.name ? { errorName: error.name } : {}),
    };
  }
  return { errorMessage: String(error) };
}

function createPlannerOutput(
  action: PlannerAction,
  assistantMessage: string,
  conflictMemory: ConflictMemory | null = null,
  backtrackContinuation: BacktrackContinuation | null = null,
): PlannerOutput {
  const output: PlannerOutput = {
    action,
    assistantMessage,
    conflictMemory,
  };
  if (backtrackContinuation) {
    output.backtrackContinuation = backtrackContinuation;
  }
  return output;
}

function normalizeConflictMemory(value: unknown): ConflictMemory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const description = readTrimmedString(record.description);
  const preferenceIds = Array.isArray(record.preferenceIds)
    ? Array.from(
        new Set(
          record.preferenceIds
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      )
    : [];
  if (!description || preferenceIds.length === 0) return null;
  return {
    preferenceIds,
    description,
  };
}

function normalizeBacktrackContinuation(
  value: unknown,
): BacktrackContinuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const targetStage =
    typeof record.targetStage === "string" ? record.targetStage.trim() : "";
  if (!targetStage) return null;
  return { targetStage };
}

function toPlannerOutput(value: Record<string, unknown>): PlannerOutput | null {
  const actionRaw =
    value.action &&
    typeof value.action === "object" &&
    !Array.isArray(value.action)
      ? (value.action as Record<string, unknown>)
      : null;
  if (!actionRaw) return null;

  const type =
    actionRaw.type === "tool.call" || actionRaw.type === "none"
      ? actionRaw.type
      : null;
  if (!type) return null;

  const toolName =
    typeof actionRaw.toolName === "string" ? actionRaw.toolName.trim() : "";
  const reason =
    typeof actionRaw.reason === "string" ? actionRaw.reason.trim() : "";
  const preferenceIds = normalizeStringArray(actionRaw.preferenceIds);
  const coverage = normalizeHighlightCoverage(actionRaw.coverage);
  const params =
    actionRaw.params &&
    typeof actionRaw.params === "object" &&
    !Array.isArray(actionRaw.params)
      ? (actionRaw.params as Record<string, unknown>)
      : {};
  const assistantMessage =
    typeof value.assistantMessage === "string"
      ? value.assistantMessage.trim()
      : "";
  const conflictMemory = normalizeConflictMemory(value.conflictMemory);
  const backtrackContinuation = normalizeBacktrackContinuation(
    value.backtrackContinuation,
  );

  if (!reason) return null;

  return createPlannerOutput(
    {
      type,
      toolName,
      params,
      reason,
      ...(type === "tool.call" && preferenceIds.length > 0
        ? { preferenceIds }
        : {}),
      ...(type === "tool.call" && toolName === "highlight" && coverage
        ? { coverage }
        : {}),
    },
    assistantMessage,
    type === "none" ? conflictMemory : null,
    type === "tool.call" && toolName === "prev" ? backtrackContinuation : null,
  );
}

// ── Prompt constants ────────────────────────────────────────────────────────
// CORE: role + boundaries + decision framework (always included)
// CP_MEMORY_PROMPT_RULES: memory semantics + behavioral rules (when cpMemory enabled)
// GUI_ADAPTATION_ENABLED_RULES / GUI_ADAPTATION_DISABLED_RULES: GUI-specific guardrails
// BACKTRACK_CONTINUATION: prev-to-workflow carry signal for multi-stage backtracking
// OPENAI_TOOL_CALLING_RULES: output format (always appended)

const CORE_SYSTEM_PROMPT =
  "You are a movie-booking assistant helping a user complete their reservation.\n" +
  "\n" +
  "Decision framework:\n" +
  '- ACT when intent is clear: direct instruction, explicit "choose for me", confirmation of a suggestion, or agreeing to backtrack (call prev).\n' +
  "- SUGGEST when a preference points to a best match but the user hasn't explicitly chosen it. Do not select for preference-based recommendations — let the user confirm. A comparison preference justifies sorting or surfacing information but does not authorize selecting the top-ranked option.\n" +
  "- ASK when multiple viable options remain and no user statement distinguishes them. Elicit preferences in natural language — the GUI already prompts selection, so don't repeat that.\n" +
  "\n" +
  "Context:\n" +
  "- Use history and workflow together to infer intent, prioritizing unresolved recent preferences.\n" +
  "- Treat workflow.currentStage, available tools, and proceedRule as hard boundaries.\n" +
  "- Treat workflow.currentView as the authoritative screen state for the current stage. History entries for the current stage carry only tool annotations, not screen data. Authoritative about the screen is not the same as complete about the stage.\n" +
  "- currentView.items is what this stage holds. currentView.visibleItems is only what the screen is showing of it, and currentView.hiddenByFilterCount, when present, is how many selectable options an active filter is holding back. Judge what the stage still offers from items; judge what the user can click right now from visibleItems.\n" +
  "- Use workflow.state for earlier-stage context. Do not assume later-stage information.\n" +
  "\n" +
  "Guardrails:\n" +
  "- Use only the tools provided for this turn. If a tool is unavailable, treat that as a hard boundary rather than inferring hidden follow-up behavior.\n" +
  "- Keep criteria stage-appropriate — earlier-stage rationale does not create new objectives for the current stage.\n" +
  "- Use commitment actions (select, next) only when the user indicates a specific choice — by naming an option or its value, confirming a suggestion, or agreeing (e.g., 'yes', 'friday', 'that one', 'can I go with X?'). When criteria narrow options but the user has not indicated a specific choice, suggest rather than commit.\n" +
  "- Treat prev as navigation rather than commitment.\n" +
  "- Do not infer unstated optimization goals or tie-breakers such as highest-rated, cheapest, nearest, earliest, latest, shortest, or best default.";

const CP_MEMORY_PROMPT_RULES =
  "Workflow context (CP-memory-specific fields):\n" +
  "- workflow.priorStageAlternativeCounts (when present): earlier-stage alternative counts in nearest-first order, taken over each stage's full inventory with its hard-preference filters re-applied and dead-ended or already-chosen items removed. They are not what that stage's screen was showing when you left it — when a count is larger than the screen was, the count is right. Use them to judge flexibility when suggesting backtracking.\n" +
  "- workflow.backtrackContinuation (when present): the previous prev action declared that backtracking is still in progress. Its targetStage field names the destination stage.\n" +
  "\n" +
  "Memory (top-level 'memory' field):\n" +
  "\n" +
  "Field definitions:\n" +
  "- preferences: active decision criteria. Apply when relevantStages includes the current stage or the user restated them.\n" +
  "- deadEnds: branches tried and failed. Treat dead-ended scopes as unavailable.\n" +
  "\n" +
  "Preference handling:\n" +
  "- Apply hard preferences first, then soft preferences.\n" +
  "  1. Hard pass: identify all items satisfying every hard preference. Surface this full set — never narrow it by a soft preference. Surfacing means leaving every one of them visible and selectable; it does not mean marking them.\n" +
  "  2. Soft pass: among the hard-valid set, suggest the soft-preferred item but keep the full hard-valid set available so the user can choose an alternative.\n" +
  "  3. If exactly one hard-valid item exists, suggest it. Count hard-valid items over currentView.items, not over visibleItems — a filter changes what you can see, not what exists. If zero exist, see dead-end rules below.\n" +
  "- If hard-valid items exist but none satisfy the soft preference, suggest the closest match — do not suggest backtracking for a soft failure alone.\n" +
  "\n" +
  "Dead-end handling:\n" +
  "- workflow.currentView.deadEndItemIds (when present): item IDs that are dead-ended downstream. Never select or recommend these.\n" +
  "- Apply preferences after excluding dead-ended items, over currentView.items rather than visibleItems — deadEndItemIds can name an item a filter is currently hiding. If exactly one option is viable in that set, suggest it and ask the user to confirm. This is not a conflict, so do not emit conflictMemory. If multiple remain, ask the user to choose. One option left on screen is not one option left: when currentView.hiddenByFilterCount is present, name the requirement doing the hiding before you treat the choice as forced.\n" +
  "- If no option at this stage satisfies a hard preference — judged against the stage inventory, not against what a filter has left on screen — emit conflictMemory, briefly explain why, and suggest going back to the nearest earlier stage that has remaining alternatives (based on priorStageAlternativeCounts). Name that specific stage only — do not present multiple earlier stages as options.\n" +
  "- If prev is unavailable this turn but priorStageAlternativeCounts shows an earlier stage with count > 0, still mention going back as an option the user can request.\n" +
  "- If EVERY entry in priorStageAlternativeCounts is 0, do not conclude the user is out of options and do not offer relaxing a hard requirement as the only path. Say plainly which requirement is blocking, and ask which one they would like to revisit.\n" +
  "\n" +
  "Confirm stage:\n" +
  "- Before offering to finalize, re-check EVERY hard preference against the assembled booking shown in the confirm summary, not against what you remember deciding earlier.\n" +
  "- If any hard preference is violated, do NOT ask 'shall I confirm?'. Name the specific violation and ask the user to choose: proceed anyway, or go back to the stage that would fix it. Emit conflictMemory for the violated preference.\n" +
  "- Only treat a hard preference as relaxed after the user has been told it is violated and has said to proceed anyway. Reaching the confirm stage is not consent.\n" +
  "\n" +
  "Backtracking:\n" +
  "- Call prev immediately when EITHER condition is met (each is independently sufficient):\n" +
  "  (a) The user consents to backtrack — answers 'yes' to a backtrack suggestion, says 'go back', or gives any explicit backtrack request.\n" +
  "  (b) workflow.backtrackContinuation is present and currentStage !== backtrackContinuation.targetStage.\n" +
  "  In either case, do not re-explain or re-ask — act.\n" +
  "  For condition (b) intermediate hops, use a single short distinct phrase indicating progress toward the destination. Never repeat the same wording across consecutive hops.\n" +
  "- When initiating a multi-stage backtrack, attach backtrackContinuation with targetStage set to the nearest earlier stage with a positive count in priorStageAlternativeCounts. Intermediate stages will auto-continue via condition (b).\n" +
  "- When currentStage === backtrackContinuation.targetStage, you have arrived — stop calling prev, and before evaluating anything, re-decide any filter still applied at this stage instead of inheriting it: it is the filter that produced the choice which failed downstream. Then resume normal dead-end and preference evaluation.\n" +
  "- If a hard requirement cannot be verified from the current GUI state and no tool can surface it, treat as a dead end.";

const CP_MEMORY_DISABLED_PROMPT_RULES =
  "Backtracking:\n" +
  "- If the user wants to go back and prev is available, call prev immediately.\n" +
  "- If no option in currentView.items satisfies the user's stated requirement and prev is available, briefly explain why and ask whether they'd like to go back. A requirement that only the hidden options fail is not a reason to leave the stage — say what is hidden instead.\n" +
  "- When the most recent history entries name a stage later in the fixed order than workflow.currentStage, you have come back from a dead end. A filter still applied here produced the choice that failed, so do not inherit it: unless a requirement the user stated and has not withdrawn still needs it, treat it as lifted, and never describe what it leaves on screen as everything this stage has.";

const GUI_ADAPTATION_ENABLED_RULES =
  "GUI adaptation rules:\n" +
  "\n" +
  "Turn sequencing for GUI tools:\n" +
  "- If the provided tools are limited to GUI adaptation tools, continue applying pending preference-based GUI actions before responding — unless the only remaining action would be a highlight the Highlight economy rules below forbid, in which case respond with the narrowing question instead.\n" +
  "- After a GUI action, do not restate or reference what the previous turn already conveyed (e.g., avoid 'already highlighted', 'I've filtered'). If no further GUI action is needed, ask a brief confirmation question.\n" +
  "\n" +
  "assistantMessage style:\n" +
  "- Treat assistantMessage as a brief spoken cue. Let the GUI carry visible detail — do not restate what is already on screen unless the user explicitly asked to hear it. Saying that the whole visible set satisfies a preference is a judgement about the set, not a restatement of it, and is allowed; naming the items one by one is not.\n" +
  "- Do not mention item metadata in assistantMessage if it is not already visible in the UI; surface it through a GUI tool first.\n" +
  "\n" +
  "How tools stack:\n" +
  "- All GUI tools accumulate — filter + sort means filtered first, then sorted within the remaining set.\n" +
  "- When a preference changes (e.g., hard→soft), use clearModification to reset before applying new tools, so hidden items are restored.\n" +
  "\n" +
  "Filtered stages:\n" +
  "- currentView.hiddenByFilterCount, when present, is how many selectable options an active filter is holding back. currentView.items is the stage inventory; currentView.visibleItems is what the filter left of it. Hidden is not gone.\n" +
  "- Whenever hiddenByFilterCount is present, say it: how many options are hidden, and which requirement is hiding them. The user cannot see why the screen is short, and what they told you is a rough account of what they actually want — saying this is how they find their way back to the rest. It is not item metadata you must surface with a tool first; the count and the requirement are things you already know.\n" +
  "\n" +
  "Tool selection by preference strength:\n" +
  "Step 1 — visibility gate (MANDATORY, always first): for each active criterion, does its field appear in visibleItems[].value?\n" +
  "  visibleItems[].value is the text the user sees. If ANY criterion maps to a field not in those strings, call augment to surface ALL missing criteria in one call before proceeding to filter/highlight/sort.\n" +
  "  Never treat item IDs or ID substrings as visible fields.\n" +
  "Step 2 — if the field IS visible, apply by strength:\n" +
  "  Hard (user can accept ONLY matching options):\n" +
  "  - filter to hide non-matching items.\n" +
  "  - If filter is not available, do not substitute a whole-set highlight. Every matching item is already visible and selectable; name the constraint in assistantMessage, and mark only when the Highlight economy rules below allow it — never narrowing the set by a soft preference.\n" +
  "  - If no option matches, do not filter — respond explaining why.\n" +
  "  Soft (user prefers but would accept alternatives):\n" +
  "  - Ordinal field (rating, time, distance, price …): sort.\n" +
  "  - Categorical field (genre, format, type …): highlight.\n" +
  "  - When highlighting for a soft preference, do not mark only your top pick. If all the user-stated acceptable options pass the Highlight economy tests below, mark them and suggest the preferred one in assistantMessage. If they do not, mark none of them: name the preferred one and ask one question that narrows the set.\n" +
  "  - If a hard preference already highlighted multiple items, do not re-highlight a smaller subset on your own initiative; mention the soft-preferred item in assistantMessage instead. A narrower highlight is correct when the user's own answer selected it.\n" +
  "  - Exception: when more choices match than the Highlight economy ceiling allows and filter is available at this stage, filter is acceptable — but only on a criterion the user actually stated, and say in assistantMessage what was hidden so they can ask for it back.\n" +
  "\n" +
  "Highlight economy:\n" +
  "- A highlight is read by contrast: it says these and not those. Its value is exactly what it leaves unmarked, and falls to nothing when nothing is left unmarked. Mark the fewest choices that answer the user.\n" +
  "- Count choices, not item ids. A choice is one complete answer to what this stage asks — one thing the user could accept and be finished here. At the movie, theater, date and time stages each item is one choice, so choices and ids are the same number. At the seat stage a choice is a whole seating arrangement for the party the user described: if they need four together, D1-D4 is one choice and E5-E8 is a second — two choices, eight ids. One unbroken run of adjacent seats counts once however long it is; if the user needs a single seat, every free seat is its own choice. Party size comes from what the user said, never from the seat layout.\n" +
  "- Mark a choice whole. Marking part of a seat block is not a smaller highlight, it is a wrong one.\n" +
  "- Before every highlight call, BOTH tests must pass:\n" +
  "  - Contrast test: at least one option the user could still pick must be left unmarked. If marking would cover every option still available on this screen, the mark distinguishes nothing — do not call highlight. Say in assistantMessage that they all qualify, and ask one question that narrows them.\n" +
  "  - Ceiling test: mark at most 3 choices. One or two is the normal case; past three the marks stop narrowing anything.\n" +
  "- Exemption: a highlight of exactly one choice is a pointer, not a filter gesture. It passes both tests automatically and stays correct even when it is the only choice on screen.\n" +
  "- The ceiling is a gate on acting, not a quota to trim to. Mark the qualifying choices only if ALL of them fit inside it. If they do not, you may not pick which of them to mark — that is an unstated tie-breaker, which is forbidden. Narrowing comes from the user. In order:\n" +
  "  - filter, if it is available this turn and the user stated the criterion.\n" +
  "  - sort, if the field is ordinal and sort is available this turn.\n" +
  "  - otherwise do not highlight. Say what the qualifying options have in common and ask one question whose answer narrows them, then mark what that answer selects. Not every stage offers filter or sort; when this turn's tool list lacks them, this branch is the only one.\n" +
  "- The same holds when the contrast test fails: never rescue a highlight by marking an arbitrary subset. Either the user's own answer selects what gets marked, or nothing is marked.\n" +
  "- Never call highlight with an empty item list. Deciding not to mark anything is a respond turn, or a clearModification turn if stale marks need removing.\n" +
  "- workflow.currentView.highlightedIds is what is already marked on screen. If it would fail either test, or no longer reflects the active preferences, call clearModification with type \"highlight\" rather than leaving stale marks standing.\n" +
  "\n" +
  "augment notes:\n" +
  "- Surface only the missing criterion or criteria needed for the user's current request or the immediate next GUI action. Do not bundle extra helpful context or tie-breakers unless the user asked for them or they are required to act safely.\n" +
  "- augment replaces visibleItems display text only — raw item data is unchanged, so filter (which operates on raw fields) is independent of augment.\n" +
  "- filter operates only on native item fields present in items[].\n" +
  "- If a criterion is not visible and remains relevant after another GUI action, augment is still required on the next turn before asking a tie-break question — when augment is available at this stage. When it is not, ask the question in plain language instead.\n" +
  "\n" +
  "Pre-select confirmation:\n" +
  "- When preference evaluation narrows to a single viable option, highlight it first — a single-choice highlight is exempt from the Highlight economy tests, including when it is the only option on screen. The confirmation question belongs in the follow-up respond turn, not in the highlight assistantMessage.\n" +
  "\n" +
  "Guardrails:\n" +
  "- Do not highlight, sort, filter, or augment without a user criterion or stage-relevant preference. Without one, prefer respond.";

const GUI_ADAPTATION_DISABLED_RULES =
  "Response rules:\n" +
  "- assistantMessage is the user's primary information source. The GUI shows only item labels, not detailed attributes.\n" +
  "- When the user has NOT asked a question or stated a criterion, ask one brief follow-up question to elicit preferences. Do not proactively list item attributes or comparisons — let the user guide what details matter.\n" +
  "- When the user asks a question or states a criterion, include only the option names and attribute values relevant to that request so the user can decide. Do not read back the whole visible set unless the user explicitly asks.\n" +
  "- Keep responses concise even when multiple options match. Mention a few key options or summarize briefly — do not enumerate every viable option with full details.\n" +
  "- Do not introduce unsolicited comparison dimensions or turn a tie into an unrequested recommendation.";

const OPENAI_TOOL_CALLING_RULES =
  "Tool-calling rules:\n" +
  "- Use exactly one provided function on every turn.\n" +
  '- If no GUI tool should be used now, call "respond".\n' +
  '- Fill "reason" FIRST: assess user intent and current state, then justify the chosen action. Then write "assistantMessage" consistent with that reasoning.\n' +
  '- If calling filter or highlight to apply current user preferences, include "preferenceIds" with the existing memory IDs that justify that action. Omit preferenceIds when the action is not preference-driven.\n' +
  '- For highlight, also include "coverage": use "full" when the highlighted items are every item satisfying the relevant preference(s), and "partial" when they are only a suggested subset. Coverage describes the preference match, not the stage inventory. Before writing "full", check the Highlight economy ceiling: a "full" highlight over more choices than the ceiling allows narrows nothing, so do not make the call at all. Relabelling it "partial" is not the way out.\n' +
  "- For GUI tool calls, assistantMessage should briefly state what criterion or preference is being applied, not just that an action is happening. Do not ask for permission.\n" +
  "- Base assistantMessage only on visible information and known context. Do not invent facts or claim later-stage knowledge.\n" +
  "- Never include internal item IDs in assistantMessage; use human-readable labels.\n" +
  "- Do not use internal terms (path, branch, dead-end, blocked, scope) in assistantMessage. Frame explanations around the user's choices.\n" +
  "- Do not output plain text without a function call.";

export function getPlannerSystemPrompt(): string {
  return [CORE_SYSTEM_PROMPT, OPENAI_TOOL_CALLING_RULES].join("\n");
}

function hasCpMemoryContext(workflow: PlannerWorkflow): boolean {
  return workflow.cpMemoryEnabled === true;
}

function buildStageMetaSection(
  stageMeta:
    | Array<{ stage: string; goal: string; fieldGuide: string }>
    | undefined,
): string | null {
  if (!stageMeta || stageMeta.length === 0) return null;
  const order = stageMeta.map((s) => s.stage).join(" → ");
  const goals = stageMeta.map((s) => `  ${s.stage}: ${s.goal}`).join("\n");
  return `Stage workflow (fixed order):\n  ${order}\nStage goals:\n${goals}`;
}

/**
 * Appended only for a non-English session, so the English prompt this study was
 * run against stays byte-identical.
 *
 * It governs the spoken channel and nothing else. Tool names, parameter values
 * and item ids are the host's vocabulary — the screen still shows "Street
 * Fighter" and seat "C1" — so translating them would break selection outright.
 * The decision framework above is untouched: which tool to call, and when, does
 * not depend on the language it is narrated in.
 */
const LANGUAGE_PROMPTS: Record<string, string> = {
  ko:
    "Language:\n" +
    "- The user speaks Korean. Write assistantMessage in Korean, in a polite conversational register (해요체).\n" +
    '- Keep film titles, cinema names, formats (IMAX, 3D), seat ids ("C1") and times exactly as they appear on screen, in their original script. Do not translate or transliterate them.\n' +
    '- Everything else in assistantMessage — verbs, questions, comparisons, counts — is Korean.\n' +
    '- "reason" stays in English. It is a trace field, not something the user hears.\n' +
    "- Tool names and every tool parameter value stay exactly as the schema and the screen define them. They are identifiers, not prose.",
};

/**
 * Appended for a scanned quick-demo card, and nothing else.
 *
 * The GUI adaptation rules tell the planner to "treat assistantMessage as a
 * brief spoken cue" and "not restate what is already on screen". That is right
 * for a booking someone is ten minutes into: the screen is in front of them and
 * narration is noise.
 *
 * It is exactly wrong for a quick card. There the visitor has ninety seconds,
 * has never seen this system, and the adaptation IS the demonstration — so a
 * cue written to avoid describing the screen leaves them watching a list twitch
 * with no account of why. Turning the frontend's verbosity gate up does not fix
 * that; it only says the same stripped sentence louder. The sentence has to be
 * written differently, which means here.
 *
 * Appended as its own section rather than by editing the rules above, so the
 * study prompt stays byte-identical when this is off. `plannerPrompt.check.ts`
 * asserts that.
 */
const ADAPTATION_NARRATION_RULES =
  "Narrating the adaptation (demonstration session):\n" +
  "- This session is a short demonstration of GUI adaptation itself, and the spoken channel is how the visitor knows an adaptation happened. Where this section conflicts with the assistantMessage style rules above, this section wins.\n" +
  "- Whenever you call a GUI tool, say what you just did to the screen and what made you do it: the operation (hid, sorted, highlighted, added a field), its scale (\"four of the six\", \"everything over fifteen miles\"), and the requirement behind it. Restating a change the visitor can see is the point here, not a fault.\n" +
  "- One sentence still. Name the CHANGE, never the survivors — no item-by-item recital, because the screen already lists them and reading it out is what the rule above exists to prevent.\n" +
  "- Everything else is unchanged: the decision framework, tool selection, the highlight economy, and the rule against mentioning metadata you have not surfaced yet.";

/**
 * Appended for a voice-mode demo session, and nothing else.
 *
 * The rules above are written for a channel that can be skimmed. Speech cannot:
 * the user hears it at the speed it is spoken, in the order it is spoken,
 * while looking at the screen rather than at the transcript. The frontend gate
 * (`apps/frontend/src/voice`) has been cutting these sentences down after the
 * fact with regexes, which is the wrong layer — it produces fragments, it
 * cannot read Korean it has no corpus for, and it never had the one thing the
 * planner has, which is knowing what the sentence was FOR.
 *
 * So this asks for the short sentence to be written rather than cut. The gate
 * stays as a backstop for the things a prompt genuinely cannot know: what the
 * user actually heard, and how quiet they asked for it to be.
 *
 * Not appended for a study session — `plannerPrompt.check.ts` pins that — and
 * not for a quick card, whose whole point is to narrate MORE.
 *
 * KNOWN AND ACCEPTED: this is not purely a wording change, despite the rule
 * below saying so in as many words. Replaying 38 real turns with the flag on
 * moved the chosen tool 3 times; the same turns with the same configuration on
 * both sides moved it 0 times (`spokenBrevity.regress.ts --control`), so the
 * excess is the flag's doing and not planner variance. Both inspected cases
 * were defensible — one noticed a dead end the baseline filtered into — but
 * they are decisions, not sentences.
 *
 * That ~8% was accepted on 2026-09-01 for the demo path, which is the only path
 * this can reach. Zeroing it would mean choosing the tool in a call that cannot
 * see this section at all, which is a planner restructure and a separate
 * decision. Re-measure before a booth deploy:
 *
 *   OPENAI_API_KEY=... npm run regress:brevity -- --wide 24
 *   OPENAI_API_KEY=... npm run regress:brevity -- --wide 24 --control
 */
const SPOKEN_BREVITY_RULES =
  "Writing for the ear (voice session):\n" +
  "- assistantMessage is spoken aloud and it is the only thing that is. The user is watching the screen, not reading you, and cannot skim past a word.\n" +
  "- This section governs WORDING ONLY. It never changes which tool you call, and it never converts a question the rules above require into an action taken silently instead — you may not backtrack, select, filter or proceed without the consent those rules ask for, and being brief is never a reason to skip asking. If applying this section would change what you DO rather than what you SAY, you have misread it.\n" +
  "- Shorter is better at every step: prefer one sentence to two, a clause to a sentence, and nothing at all to a clause.\n" +
  "- The empty string is for a step on the way to something else: you are about to act again, the user is not being asked for anything, and they just watched the change happen. In that case assistantMessage MUST be empty rather than narrating what they saw.\n" +
  "- But when your turn ENDS and the next move is the user\u2019s, say something. Silence is never how you hand the turn back: ask the question the rules above call for, with nothing in front of it.\n" +
  "- Do not attach a question to a GUI action merely to give the sentence something to do. Where the rules above call for a confirmation, tie-break or narrowing question, still ask it — and let the question be the entire message, with nothing in front of it.\n" +
  "- Never read back what is now on screen, never name the items one by one, and never explain a change whose result the user is looking at.\n" +
  "- Never drop a question you do need answered in order to be brief, and always speak an error or a failure in full.\n" +
  "- Never say again, in any wording, something you already said that still stands. A rephrasing of it is a repetition.\n" +
  "- Where this section conflicts with the assistantMessage style rules or the tool-calling rules, this section wins.";

export function buildLanguageSection(language: string | undefined): string | null {
  if (!language || language === "en") return null;
  return LANGUAGE_PROMPTS[language] ?? null;
}

// ── System prompt cache ─────────────────────────────────────────────────────
// cpMemoryEnabled + guiAdaptationEnabled + stageMeta are fixed for a session,
// so we memoize by the combination key to avoid rebuilding on every turn.

let cachedSystemPromptKey = "";
let cachedSystemPrompt = "";

/**
 * Exported for `plannerPrompt.check.ts`, which has one claim to defend: that a
 * study session's prompt is byte-identical with the narration flag off. Same
 * reason `buildLanguageSection` is exported.
 */
export function buildSystemPrompt(
  workflow: PlannerWorkflow,
  stageMeta?: Array<{ stage: string; goal: string; fieldGuide: string }>,
  language?: string,
  narrateAdaptations?: boolean,
  spokenBrevity?: boolean,
): string {
  const cpMemory = hasCpMemoryContext(workflow);
  const guiAdaptation = workflow.guiAdaptationEnabled !== false;
  const narrate = narrateAdaptations === true && guiAdaptation;
  // The two are contradictory by construction — a card wants the adaptation
  // described, a voice session wants it left to the screen. Resolved here so a
  // caller that sets both cannot produce a prompt arguing with itself.
  const brevity = spokenBrevity === true && !narrate;
  // Language belongs in the key: a visitor may switch mid-session, and the
  // cached prompt would otherwise keep the language they started in.
  const key = `cp:${cpMemory}|gui:${guiAdaptation}|meta:${stageMeta ? stageMeta.length : 0}|lang:${language ?? "en"}|narrate:${narrate}|brief:${brevity}`;

  if (key === cachedSystemPromptKey && cachedSystemPrompt) {
    return cachedSystemPrompt;
  }

  const sections = [CORE_SYSTEM_PROMPT];
  const stageSection = buildStageMetaSection(stageMeta);
  if (stageSection) {
    sections.push(stageSection);
  }
  if (cpMemory) {
    sections.push(CP_MEMORY_PROMPT_RULES);
  } else {
    sections.push(CP_MEMORY_DISABLED_PROMPT_RULES);
  }
  if (guiAdaptation) {
    sections.push(GUI_ADAPTATION_ENABLED_RULES);
  } else {
    sections.push(GUI_ADAPTATION_DISABLED_RULES);
  }
  // Straight after the rules it overrides, and only when there are adaptations
  // to narrate — with GUI adaptation off there is nothing for it to describe.
  if (narrate) {
    sections.push(ADAPTATION_NARRATION_RULES);
  }
  // Same placement, same reason: after the style rules it overrides, and before
  // the language section so "write it in Korean" applies to what it asks for.
  if (brevity) {
    sections.push(SPOKEN_BREVITY_RULES);
  }
  const languageSection = buildLanguageSection(language);
  if (languageSection) {
    sections.push(languageSection);
  }

  cachedSystemPrompt = sections.join("\n");
  cachedSystemPromptKey = key;
  return cachedSystemPrompt;
}

type OpenAiJsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array";

interface OpenAiFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
}

interface ChatCompletionFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties: boolean;
    };
  };
}

interface NativeToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

const TOOL_META_ASSISTANT_MESSAGE_KEY = "assistantMessage";
const TOOL_META_REASON_KEY = "reason";
const TOOL_META_CONFLICT_MEMORY_KEY = "conflictMemory";
const TOOL_META_BACKTRACK_CONTINUATION_KEY = "backtrackContinuation";
const TOOL_META_PREFERENCE_IDS_KEY = "preferenceIds";
const TOOL_META_COVERAGE_KEY = "coverage";
const NATIVE_NONE_TOOL_NAME = "respond";

function normalizeJsonSchemaType(
  raw: string | null,
): OpenAiJsonSchemaType | null {
  if (!raw) return null;
  switch (raw.toLowerCase()) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "array":
      return "array";
    default:
      return null;
  }
}

function toOpenAiParamSchema(paramValue: unknown): Record<string, unknown> {
  const paramRecord = isRecord(paramValue) ? paramValue : {};
  const schema: Record<string, unknown> = {};

  const description = readTrimmedString(paramRecord.description);
  if (description) schema.description = description;

  const normalizedType = normalizeJsonSchemaType(
    readTrimmedString(paramRecord.type),
  );
  if (normalizedType) {
    schema.type = normalizedType;
    if (normalizedType === "array") {
      schema.items = {};
    }
    if (normalizedType === "object") {
      schema.additionalProperties = true;
    }
  }

  if (Array.isArray(paramRecord.enum)) {
    const enumValues = paramRecord.enum.filter(
      (item): item is string =>
        typeof item === "string" && Boolean(item.trim()),
    );
    if (enumValues.length > 0) {
      schema.enum = enumValues;
      if (!normalizedType) {
        schema.type = "string";
      }
    }
  }

  return schema;
}

function getToolParametersRecord(
  tool: ToolSchemaItem,
): Record<string, unknown> {
  if (isRecord(tool.parameters)) return tool.parameters;
  if (isRecord(tool.params)) return tool.params;
  return {};
}

function getToolAssistantMessageDescription(): string {
  return "Brief user-facing message describing the GUI action or stage transition. Assume it may be spoken aloud.";
}

function getRespondToolDescription(): string {
  return "Respond to the user without executing any GUI tool. Use this for a brief clarification, confirmation, or direct answer. Never offer to choose or pick for the user. assistantMessage must end with a brief question so the user knows what is expected next.";
}

function getRespondAssistantMessageDescription(): string {
  return "User-facing message spoken aloud via TTS. Must end with a brief question for the user's next choice. Do not end with a declarative statement.";
}

function toOpenAiTools(
  availableTools: ToolSchemaItem[],
  cpMemoryEnabled: boolean,
): OpenAiFunctionTool[] {
  const tools: OpenAiFunctionTool[] = [];

  for (const tool of availableTools) {
    const name = readTrimmedString(tool.name);
    if (!name) continue;
    const description = readTrimmedString(tool.description);
    const parameterDefs = getToolParametersRecord(tool);
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [paramName, paramValue] of Object.entries(parameterDefs)) {
      properties[paramName] = toOpenAiParamSchema(paramValue);
      const optional = isRecord(paramValue) && paramValue.optional === true;
      if (!optional) {
        required.push(paramName);
      }
    }

    properties[TOOL_META_REASON_KEY] = {
      type: "string",
      description:
        "Decide first: assess user intent and current state, identify viable options, then justify why this tool and params are the correct next action.",
    };
    properties[TOOL_META_ASSISTANT_MESSAGE_KEY] = {
      type: "string",
      description: getToolAssistantMessageDescription(),
    };
    if (name === "filter" || name === "highlight") {
      properties[TOOL_META_PREFERENCE_IDS_KEY] = {
        type: "array",
        description:
          "Optional. Existing preference IDs that justify this action. Include them when the action is applying stage-relevant user preferences.",
        items: { type: "string" },
      };
    }
    if (name === "highlight") {
      properties[TOOL_META_COVERAGE_KEY] = {
        type: "string",
        description:
          'Use "full" when the highlighted items are every item satisfying the linked preference(s); use "partial" when the highlight is only a suggested subset. This describes the preference match only — it says nothing about how many options the stage still has. It is not a completeness badge: if the marked set exceeds the Highlight economy ceiling, do not call highlight at all.',
        enum: ["full", "partial"],
      };
    }
    if (name === "prev" && cpMemoryEnabled) {
      properties[TOOL_META_BACKTRACK_CONTINUATION_KEY] = {
        type: "object",
        description:
          "Optional. Attach when this prev initiates or continues a multi-stage backtrack.",
        properties: {
          targetStage: {
            type: "string",
            description:
              "The earliest stage with remaining alternatives. At intermediate stages, if currentStage !== targetStage, call prev immediately.",
          },
        },
        required: ["targetStage"],
        additionalProperties: false,
      };
    }
    required.push(TOOL_META_REASON_KEY);
    required.push(TOOL_META_ASSISTANT_MESSAGE_KEY);

    tools.push({
      type: "function",
      name,
      ...(description ? { description } : {}),
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      },
    });
  }

  tools.push({
    type: "function",
    name: NATIVE_NONE_TOOL_NAME,
    description: getRespondToolDescription(),
    parameters: {
      type: "object",
      properties: {
        [TOOL_META_REASON_KEY]: {
          type: "string",
          description:
            "Decide first: assess user intent and current state, then explain why no GUI action is needed.",
        },
        [TOOL_META_ASSISTANT_MESSAGE_KEY]: {
          type: "string",
          description:
            getRespondAssistantMessageDescription(),
        },
        ...(cpMemoryEnabled
          ? {
              [TOOL_META_CONFLICT_MEMORY_KEY]: {
                type: "object",
                description:
                  "Optional. Include existing hard-preference IDs that block progress at this stage.",
                properties: {
                  preferenceIds: {
                    type: "array",
                    items: { type: "string" },
                  },
                  description: {
                    type: "string",
                    description:
                      "Short conflict summary describing which hard preference is blocking progress and why.",
                  },
                },
                required: ["preferenceIds", "description"],
                additionalProperties: false,
              },
            }
          : {}),
      },
      required: [TOOL_META_REASON_KEY, TOOL_META_ASSISTANT_MESSAGE_KEY],
      additionalProperties: false,
    },
  });

  return tools;
}

function toChatCompletionTools(
  tools: OpenAiFunctionTool[],
): ChatCompletionFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  }));
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = parseJsonObject(raw);
    return parsed ?? {};
  }
  return {};
}

function extractNativeToolCall(body: unknown): NativeToolCall | null {
  if (!isRecord(body)) return null;
  const output = Array.isArray(body.output) ? body.output : [];

  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type !== "function_call") continue;
    const toolName = readTrimmedString(item.name);
    if (!toolName) continue;
    return {
      toolName,
      arguments: parseToolArguments(item.arguments),
    };
  }

  return null;
}

function plannerOutputFromNativeToolCall(
  toolCall: NativeToolCall,
  outputText: string | null,
): PlannerOutput {
  const params = { ...toolCall.arguments };
  const assistantMessageFromToolArg = readTrimmedString(
    params[TOOL_META_ASSISTANT_MESSAGE_KEY],
  );
  const reasonFromToolArg = readTrimmedString(params[TOOL_META_REASON_KEY]);
  const conflictMemoryFromToolArg = normalizeConflictMemory(
    params[TOOL_META_CONFLICT_MEMORY_KEY],
  );
  const backtrackContinuationFromToolArg = normalizeBacktrackContinuation(
    params[TOOL_META_BACKTRACK_CONTINUATION_KEY],
  );
  const preferenceIdsFromToolArg = normalizeStringArray(
    params[TOOL_META_PREFERENCE_IDS_KEY],
  );
  const coverageFromToolArg = normalizeHighlightCoverage(
    params[TOOL_META_COVERAGE_KEY],
  );
  delete params[TOOL_META_ASSISTANT_MESSAGE_KEY];
  delete params[TOOL_META_REASON_KEY];
  delete params[TOOL_META_CONFLICT_MEMORY_KEY];
  delete params[TOOL_META_BACKTRACK_CONTINUATION_KEY];
  delete params[TOOL_META_PREFERENCE_IDS_KEY];
  delete params[TOOL_META_COVERAGE_KEY];

  const assistantMessage =
    assistantMessageFromToolArg ?? readTrimmedString(outputText) ?? "";
  const reason =
    reasonFromToolArg ??
    assistantMessageFromToolArg ??
    readTrimmedString(outputText) ??
    `Use ${toolCall.toolName} as the best next action based on user intent and current workflow state.`;

  if (toolCall.toolName === NATIVE_NONE_TOOL_NAME) {
    return createPlannerOutput(
      {
        type: "none",
        toolName: "",
        params: {},
        reason,
      },
      assistantMessage,
      conflictMemoryFromToolArg,
    );
  }

  return createPlannerOutput(
    {
      type: "tool.call",
      toolName: toolCall.toolName,
      params,
      reason,
      ...((toolCall.toolName === "filter" ||
        toolCall.toolName === "highlight") &&
      preferenceIdsFromToolArg.length > 0
        ? { preferenceIds: preferenceIdsFromToolArg }
        : {}),
      ...(toolCall.toolName === "highlight" && coverageFromToolArg
        ? { coverage: coverageFromToolArg }
        : {}),
    },
    assistantMessage,
    null,
    toolCall.toolName === "prev" ? backtrackContinuationFromToolArg : null,
  );
}

function plannerOutputFromNoToolCall(
  outputText: string | null,
): PlannerOutput | null {
  const assistantMessage = readTrimmedString(outputText) ?? "";
  if (!assistantMessage) return null;
  return createPlannerOutput(
    {
      type: "none",
      toolName: "",
      params: {},
      reason: assistantMessage,
    },
    assistantMessage,
  );
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_CHAT_COMPLETIONS_API_URL =
  "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_TEMPERATURE = 0;
/**
 * Sent explicitly on every call, and that is the whole point.
 *
 * gpt-5.4 defaulted to `none` when the field was omitted; the GPT-5.6 family
 * defaults to `medium`. Omitting it while moving the default model would have
 * silently turned reasoning on for every planner turn -- slower, dearer, and
 * measurably worse at picking the right tool (replayed against the study's own
 * traces: 40/46 at medium vs 42/46 at none, with p95 latency 4.5s vs 2.9s).
 *
 * It also keeps `temperature` legal: GPT-5.6 rejects the parameter outright
 * once reasoning is active, and the retry guard below would have quietly
 * dropped temperature 0 rather than surfacing that.
 */
const DEFAULT_OPENAI_REASONING_EFFORT = "none";
type OpenAiApiMode = "responses" | "chat";

/**
 * Raised when OpenAI rejects the credentials (401/403). Callers surface this to
 * the user instead of silently falling back, so an invalid session-supplied key
 * does not leave the UI waiting for an agent response forever.
 */
export class OpenAiAuthError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`OPENAI_AUTH_FAILED (${status}): ${detail}`);
    this.name = "OpenAiAuthError";
    this.status = status;
  }
}

export function isOpenAiAuthError(error: unknown): error is OpenAiAuthError {
  return error instanceof OpenAiAuthError;
}

function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

// OpenAI auth errors echo a partially masked key back in the error body; strip
// anything key-shaped before it reaches a log or trace.
function redactApiKeys(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_*\-]{6,}/g, "sk-[redacted]");
}

function getOpenAIModel(): string {
  return process.env.AGENT_OPENAI_MODEL || "gpt-5.6-terra";
}

function getOpenAIApiMode(): OpenAiApiMode {
  return process.env.AGENT_OPENAI_API_MODE === "chat" ? "chat" : "responses";
}

function resolveOpenAITemperature(): number | undefined {
  return DEFAULT_OPENAI_TEMPERATURE;
}

function resolveOpenAIReasoningEffort(): string | undefined {
  return DEFAULT_OPENAI_REASONING_EFFORT;
}

function isUnsupportedTemperatureError(
  status: number,
  errorText: string,
): boolean {
  if (status !== 400) return false;
  const lowered = errorText.toLowerCase();
  return (
    lowered.includes("temperature") &&
    (lowered.includes("not supported") ||
      lowered.includes("unsupported") ||
      lowered.includes("only support") ||
      lowered.includes("invalid"))
  );
}

function parseOpenAIOutputText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;

  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }

  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const itemRecord = item as Record<string, unknown>;
    const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partRecord = part as Record<string, unknown>;
      if (typeof partRecord.text === "string" && partRecord.text.trim()) {
        return partRecord.text.trim();
      }
    }
  }
  return null;
}

function parseChatCompletionOutputText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) return null;
  const message = isRecord(firstChoice.message) ? firstChoice.message : null;
  if (!message) return null;

  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }

  const content = Array.isArray(message.content) ? message.content : [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type !== "text") continue;
    const text = readTrimmedString(item.text);
    if (text) return text;
  }
  return null;
}

function extractChatCompletionToolCall(body: unknown): NativeToolCall | null {
  if (!isRecord(body)) return null;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) return null;
  const message = isRecord(firstChoice.message) ? firstChoice.message : null;
  if (!message) return null;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) continue;
    const fn = isRecord(toolCall.function) ? toolCall.function : null;
    if (!fn) continue;
    const toolName = readTrimmedString(fn.name);
    if (!toolName) continue;
    return {
      toolName,
      arguments: parseToolArguments(fn.arguments),
    };
  }

  return null;
}

export async function planActionWithOpenAI(
  input: PlannerInput,
): Promise<PlannerOutput | null> {
  if (process.env.AGENT_ENABLE_OPENAI === "false") return null;
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) return null;
  const temperature = resolveOpenAITemperature();
  const reasoningEffort = resolveOpenAIReasoningEffort();
  const apiMode = getOpenAIApiMode();
  const cpMemoryEnabled = hasCpMemoryContext(input.workflow);
  const openAiTools = toOpenAiTools(
    input.availableTools,
    cpMemoryEnabled,
  );
  const nativePlannerInput = {
    ...(input.memory ? { memory: input.memory } : {}),
    history: input.history,
    workflow: input.workflow,
  };
  const openAiSystemPrompt =
    buildSystemPrompt(
      input.workflow,
      input.stageMeta,
      input.language,
      input.narrateAdaptations,
      input.spokenBrevity,
    ) +
    "\n" +
    OPENAI_TOOL_CALLING_RULES;
  const traceRequestId = createLlmTraceRequestId();

  const baseBody =
    apiMode === "chat"
      ? {
          model: getOpenAIModel(),
          messages: [
            {
              role: "system",
              content: openAiSystemPrompt,
            },
            {
              role: "user",
              content: JSON.stringify(nativePlannerInput),
            },
          ],
          ...(openAiTools.length > 0
            ? {
                tools: toChatCompletionTools(openAiTools),
                parallel_tool_calls: false,
                tool_choice: "required" as const,
              }
            : {}),
        }
      : {
          model: getOpenAIModel(),
          input: [
            {
              role: "system",
              content: openAiSystemPrompt,
            },
            {
              role: "user",
              content: JSON.stringify(nativePlannerInput),
            },
          ],
          ...(openAiTools.length > 0
            ? { tools: openAiTools, parallel_tool_calls: false }
            : {}),
        };
  const withReasoning = reasoningEffort
    ? {
        ...baseBody,
        ...(apiMode === "chat"
          ? { reasoning_effort: reasoningEffort }
          : { reasoning: { effort: reasoningEffort } }),
      }
    : baseBody;
  const body =
    typeof temperature === "number"
      ? { ...withReasoning, temperature }
      : withReasoning;
  const apiUrl =
    apiMode === "chat" ? OPENAI_CHAT_COMPLETIONS_API_URL : OPENAI_API_URL;

  if (DEBUG_LLM) {
    console.log(
      "[tuning-agent][llm] planner request input:",
      JSON.stringify(input),
    );
  }
  emitLlmTrace("request", {
    requestId: traceRequestId,
    method: "POST",
    url: apiUrl,
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });

  let response: Response;
  try {
    response = await fetchOpenAiWithRetry({
      url: apiUrl,
      apiKey,
      body,
      onAttemptError: (info) => {
        emitLlmTrace("error", {
          requestId: traceRequestId,
          phase: `fetch.attempt.${info.phase}`,
          attempt: info.attempt,
          willRetry: info.willRetry,
          ...(info.status === undefined ? {} : { status: info.status }),
          errorMessage: info.errorMessage,
          ...(info.errorName === undefined ? {} : { errorName: info.errorName }),
        });
      },
    });
  } catch (error) {
    emitLlmTrace("error", {
      requestId: traceRequestId,
      phase: "fetch",
      ...formatTraceError(error),
    });
    throw error;
  }

  if (!response.ok) {
    const firstErrorText = await response.text();
    const shouldRetryWithoutTemperature =
      typeof temperature === "number" &&
      isUnsupportedTemperatureError(response.status, firstErrorText);

    let retriedWithoutTemperature = false;
    if (shouldRetryWithoutTemperature) {
      if (DEBUG_LLM) {
        console.warn(
          "[tuning-agent][llm] planner temperature rejected; retrying without temperature",
        );
      }
      emitLlmTrace("request", {
        requestId: traceRequestId,
        method: "POST",
        url: apiUrl,
        headers: {
          "Content-Type": "application/json",
        },
        body: baseBody,
      });
      try {
        response = await fetchOpenAiWithRetry({
          url: apiUrl,
          apiKey,
          body: baseBody,
        });
        retriedWithoutTemperature = true;
      } catch (error) {
        emitLlmTrace("error", {
          requestId: traceRequestId,
          phase: "fetch.retry_without_temperature",
          ...formatTraceError(error),
        });
        throw error;
      }
    }

    if (!response.ok) {
      // The first response body is already consumed; only re-read when a retry
      // produced a new response.
      const errorText = redactApiKeys(
        retriedWithoutTemperature ? await response.text() : firstErrorText,
      );
      if (isAuthFailureStatus(response.status)) {
        console.error(
          `[tuning-agent][llm] OpenAI rejected the API key (${response.status}). ` +
            "The planner cannot run until a valid key is provided:",
          errorText,
        );
        emitLlmTrace("error", {
          requestId: traceRequestId,
          status: response.status,
          errorText,
          code: "OPENAI_AUTH_FAILED",
        });
        throw new OpenAiAuthError(response.status, errorText);
      }
      if (DEBUG_LLM) {
        console.error("[tuning-agent][llm] planner error response:", errorText);
      }
      emitLlmTrace("error", {
        requestId: traceRequestId,
        status: response.status,
        errorText,
      });
      throw new Error(
        `OpenAI planner failed (${response.status}): ${errorText}`,
      );
    }
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch (error) {
    emitLlmTrace("error", {
      requestId: traceRequestId,
      phase: "response.json",
      ...formatTraceError(error),
      });
    throw error;
  }
  const outputText =
    apiMode === "chat"
      ? parseChatCompletionOutputText(payload)
      : parseOpenAIOutputText(payload);
  const nativeToolCall =
    apiMode === "chat"
      ? extractChatCompletionToolCall(payload)
      : extractNativeToolCall(payload);
  if (DEBUG_LLM) {
    console.log("[tuning-agent][llm] planner raw output_text:", outputText);
    console.log(
      "[tuning-agent][llm] planner native tool call:",
      JSON.stringify(nativeToolCall),
    );
  }
  emitLlmTrace("response.raw", {
    requestId: traceRequestId,
    outputText,
    nativeToolCall,
  });

  if (nativeToolCall) {
    const parsedNative = plannerOutputFromNativeToolCall(
      nativeToolCall,
      outputText,
    );
    emitLlmTrace("response.parsed", {
      requestId: traceRequestId,
      parsed: parsedNative,
    });
    return parsedNative;
  }

  if (!outputText) return null;
  const parsed = parseJsonObject(outputText);
  if (DEBUG_LLM) {
    console.log(
      "[tuning-agent][llm] planner parsed output:",
      JSON.stringify(parsed),
    );
  }
  if (parsed) {
    const structured = toPlannerOutput(parsed);
    emitLlmTrace("response.parsed", {
      requestId: traceRequestId,
      parsed: structured ?? parsed,
      parser: "json-schema-fallback",
    });
    if (structured) {
      return structured;
    }
  }

  const noToolOutput = plannerOutputFromNoToolCall(outputText);
  emitLlmTrace("response.parsed", {
    requestId: traceRequestId,
    parsed: noToolOutput,
    parser: "text-no-tool",
  });
  return noToolOutput;
}
