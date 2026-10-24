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
import {
  resolveOpenAIModel,
  resolveReasoningEffortFor,
  resolveTemperatureFor,
} from "./modelSelection";

export interface PlannerWorkflowMemory {
  preferences: Preference[];
  deadEnds: Array<Pick<DeadEnd, "preferenceIds" | "scope" | "reason">>;
}

export interface PlannerWorkflow {
  currentStage: string;
  previousStage: string | null;
  priorStageAlternativeCounts?: Array<{
    stage: string;
    count: number;
    /** Booth only: hard preferences relevant to that stage the count did not apply. */
    uncheckedHardPreferenceIds?: string[];
  }>;
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
  /**
   * At least one preference in memory was seeded from a visitor profile before
   * the visitor said anything. Demo only — absent or false leaves the prompt
   * exactly as it was. See PRELOADED_MEMORY_RULES.
   */
  preloadedMemory?: boolean;
  /**
   * A booth demo session (AGENT_STUDY_MODE=demo). Absent or false leaves the
   * prompt exactly as it was. See DEMO_SESSION_RULES.
   */
  demoSession?: boolean;
  /**
   * Booth demo only: select what the visitor named instead of asking them to
   * confirm it. Absent or false leaves the prompt and the tool descriptions
   * exactly as they were. See DECISIVE_SELECTION_RULES. A separate flag from
   * `demoSession` so `decisiveSelection.regress.ts` can replay a turn with and
   * without it against the same demo prompt.
   */
  decisiveSelection?: boolean;
  /**
   * Booth demo only: two hard requirements that exclude each other are a
   * conflict to put to the visitor, not a dead end to back out of. Absent or
   * false leaves the prompt exactly as it was. See REQUIREMENT_CONFLICT_RULES;
   * its own flag, like `decisiveSelection`, so `cardB.regress.ts` can replay a
   * turn with and without it against the same demo prompt.
   */
  requirementConflicts?: boolean;
  /**
   * Booth demo only: on entering a stage nothing bears on yet, ask for a
   * preference the stage's fields can act on rather than "which one?". Absent
   * or false leaves the prompt exactly as it was. See STAGE_OPENING_RULES.
   */
  openingQuestions?: boolean;
  /**
   * Booth demo only: at the seat stage, mark up to three whole choices of the
   * stated party size and pick one when the visitor delegates. Absent or false
   * leaves the prompt exactly as it was. See SEAT_CHOICE_RULES.
   */
  seatChoices?: boolean;
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

// Always emitted. The listeners decide what to do with an event: the agent
// monitor honours AGENT_MONITOR_LLM_TRACE, the study trace writer honours the
// visitor's consent. Gating here once silenced both, and a demo session
// started from a backend with the flag off wrote no *.llm-trace.jsonl at all.
const llmTraceListeners = new Set<LlmTraceListener>();
let llmTraceRequestSequence = 0;

function emitLlmTrace(type: LlmTraceEvent["type"], payload: unknown): void {
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
 * The Korean section's shape, for the languages added after the study. Korean
 * keeps its own literal text below: its prompt is pinned by hash in
 * `plannerPrompt.check.ts`, so it is never rebuilt from this. The one addition
 * is the catalogue line naming dates and prices: in these languages the screen
 * still reads "Mar 14 (Sat)" and "$14.00", and the model must say them as
 * written rather than render them in the visitor's calendar or currency.
 */
function buildForeignLanguageSection(words: { speaks: string; write: string; rest: string }): string {
  return (
    "Language:\n" +
    `- The user speaks ${words.speaks}. Write assistantMessage in ${words.write}.\n` +
    '- Keep film titles, cinema names, formats (IMAX, 3D), seat ids ("C1"), dates ("Mar 14 (Sat)"), times ("7:30 PM") and prices ("$14.00") exactly as they appear on screen, in their original script. Do not translate or transliterate them.\n' +
    `- Everything else in assistantMessage — verbs, questions, comparisons, counts — is ${words.rest}.\n` +
    '- "reason" stays in English. It is a trace field, not something the user hears.\n' +
    "- Tool names and every tool parameter value stay exactly as the schema and the screen define them. They are identifiers, not prose."
  );
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
  ja: buildForeignLanguageSection({
    speaks: "Japanese",
    write: "Japanese, in the polite です・ます register",
    rest: "Japanese",
  }),
  "zh-Hans": buildForeignLanguageSection({
    speaks: "Mandarin Chinese",
    write: "Simplified Chinese characters (简体中文), in a polite register that addresses the user as 您",
    rest: "Chinese, written in Simplified characters. Never use Traditional characters",
  }),
  "zh-Hant": buildForeignLanguageSection({
    speaks: "Mandarin Chinese",
    write: "Traditional Chinese characters (繁體中文), in a polite register that addresses the user as 您",
    rest: "Chinese, written in Traditional characters. Never use Simplified characters",
  }),
  de: buildForeignLanguageSection({
    speaks: "German",
    write: "German, addressing the user formally as Sie",
    rest: "German",
  }),
  fr: buildForeignLanguageSection({
    speaks: "French",
    write: "French, addressing the user formally as vous",
    rest: "French",
  }),
  es: buildForeignLanguageSection({
    speaks: "Spanish",
    write: "Spanish, addressing the user formally as usted",
    rest: "Spanish",
  }),
};

/**
 * Every code the host may send that changes what the agent says. English is
 * the absence of a section, so it is listed explicitly.
 */
export const SUPPORTED_CONVERSATION_LANGUAGES: readonly string[] = ["en", ...Object.keys(LANGUAGE_PROMPTS)];

export function isSupportedConversationLanguage(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_CONVERSATION_LANGUAGES.includes(value);
}

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
  "- A GUI step that you will follow with another step in the same user turn says nothing: leave its assistantMessage empty. That includes the single-choice highlight whose confirmation question the rules above put in the follow-up respond turn, and the augment, sort or filter that prepares for it. If the user asked a question the step answers, the answer goes on the respond turn, in front of the question, not on the GUI step.\n" +
  "- Before writing a respond turn, read this user turn’s earlier steps in history. A sentence that is already there — as agent text or as linkedAgentText on a step — has been heard. Never write it again in any wording: not as an answer, not as a reason, not as a lead-in. If the answer is already there, the whole message is the question. \"Redford Theatre has the fewest screens.\" on an earlier step and then \"Redford Theatre has the fewest screens. Would you like to choose it?\" is the failure; the correct message is \"Would you like to choose it?\" and nothing else.\n" +
  "- Never read back what is now on screen, never name the items one by one, and never explain a change whose result the user is looking at.\n" +
  "- Never drop a question you do need answered in order to be brief, and always speak an error or a failure in full.\n" +
  "- Never say again, in any wording, something you already said that still stands. A rephrasing of it is a repetition.\n" +
  "- Where this section conflicts with the assistantMessage style rules or the tool-calling rules, this section wins.";

/**
 * Demo only: the visitor chose a preference profile on the start screen, so
 * memory holds criteria nobody stated in this conversation.
 *
 * Read out of the 2026-10-18 booth trace: with a profile loaded, the planner
 * entered the movie stage and called filter FIRST (five films to two), then
 * augmented only the two survivors; entered the theater stage and sorted by
 * distance without ever showing a distance; entered the time stage and filtered
 * three showtimes to one before augmenting. The visibility gate in the GUI
 * rules says augment comes first, but the planner read it as a rule about what
 * the user just asked for, and a remembered preference did not feel like that.
 * To the visitor it looked as if augmentation had stopped working — the screen
 * simply shrank. This section makes the gate explicit for remembered criteria
 * without touching the study prompt (a study session never loads a profile).
 */
/**
 * Demo only. Two things a visitor heard on 2026-10-18 that a booth should
 * never say: "the seat selection tool is not available, so I cannot pick two
 * seats together" (the host withholds select/next until the visitor has spoken
 * at a stage — a consent guard, not a fact about the booking), and "I cannot
 * verify the booking and the confirm function is unavailable" (the summary was
 * missing from currentView; it is now `currentView.booking`). The study prompt
 * never carried these lines, so they live in a section the study never gets.
 */
const DEMO_SESSION_RULES =
  "Booth demo (this session):\n" +
  "- Never tell the user which tools, functions or actions are or are not available to you, and never describe a limitation of your own interface. If you cannot act yet, ask the one question that moves the booking forward, or describe the choice in front of them. The screen is theirs.\n" +
  "- At the confirm stage, currentView.booking holds the assembled booking: movie, theater, date, time, seats, totalPrice. On entering the stage, read it back in one sentence and ask whether to confirm. When the user says to confirm, call next — that submits the booking. Never say the details cannot be verified: they are in currentView.booking and workflow.state.\n" +
  "- If currentView.booking carries completed: true, the booking is done; say so briefly and ask nothing.";

const PRELOADED_MEMORY_RULES =
  "Remembered preferences (this session):\n" +
  "- Some preferences in memory were loaded from the visitor's profile before they said anything. They are criteria like any other, and the visibility gate applies to them in full.\n" +
  "- On entering a stage where a remembered preference is relevant, the order is fixed: FIRST augment — every option on screen, every missing field, in one call — THEN filter, sort or highlight by strength, THEN the respond turn. Never filter or sort first and augment what is left: the visitor must see what the preference is acting on before the screen narrows or reorders.\n" +
  "- A soft comparison preference (closer, cheaper, earlier) is applied by augmenting its field and then sorting. The sort does not replace the augment.\n" +
  "- If the field is already in visibleItems[].value, skip the augment and apply by strength as the GUI rules say.";

/**
 * Demo only. The 2026-10-23 booth session, in a noisy room: "I wanna see the
 * Street Fighter" became clearModification, highlight, "Would you like to
 * choose Street Fighter?"; "which one is the closest one?" became sort, "The
 * closest theater is Bel Air Luxury Cinema. Would you like to choose it?",
 * "okay it's fine", select. Three shouted turns for one decision. The decision
 * framework, the commitment guardrail and the Pre-select confirmation rule were
 * written for a study in which consent before every GUI change was the point;
 * the study prompt keeps them byte-for-byte, and this section — appended for
 * the booth only, after brevity so it outranks brevity's "never select without
 * the consent those rules ask for" — says which consent the visitor's own words
 * already gave. `decisiveSelection.regress.ts` measures it against the logged
 * booth sessions; the one failure it must never produce is a select on an
 * option the visitor did not name.
 */
const DECISIVE_SELECTION_RULES =
  "Deciding for the visitor (booth demo):\n" +
  "- This is a conference booth in a loud room, not the study. Every confirmation question costs the visitor a shouted \"yes\", so the consent the rules above ask for before select is given by what the visitor says, not by a yes to a question you ask. Where this section conflicts with the decision framework (ACT / SUGGEST / ASK), the commitment guardrail, the Pre-select confirmation rule, the brevity section, or a tool description that says to end with a question, this section wins.\n" +
  "- SELECT, do not ask, when:\n" +
  "  (1) [named-option] the visitor names an option that is in visibleItems on this screen — a title, a theater, a day (\"Thursday\", \"the 6th\"), a start time, a seat or a seat pair — in any wording, including a preference-shaped one (\"I'm only free on Thursday\", \"I wanna see Street Fighter\", \"7:40 works\", \"D1 and D2\"). A position names an option too: \"the first one\", \"첫 번째 걸로\", \"맨 위 거\" is the option at that position in visibleItems as they are now — unless your own last question offered something other than the options on screen (two ways out of a conflict), in which case it names that offer. Call select on it as the FIRST step of the turn, with an empty assistantMessage — the screen shows the choice — and when the host then offers next, call it. Do not highlight it, do not augment, and do not clear a stale filter or mark first — select works with them in place. The one exception: if the named option is in currentView.items but a filter is hiding it from visibleItems, call clearModification with type \"filter\" first, then select it on the next step.\n" +
  "  (2) [single-viable] the visitor states a preference in this turn that leaves exactly one option viable at this stage — the only horror film, the only showtime that ends by ten. Count viable options over currentView.items less deadEndItemIds, never over what a filter left on screen. If the preference's field is not in visibleItems[].value, augment first (the visibility gate still applies), then select on the next step. On the select step, say in one sentence what you picked and why (\"Clayface is the only horror film, so I've picked it.\"); the next step that follows says nothing. That sentence overrides the brevity rule that a GUI step followed by another step stays silent.\n" +
  "  (3) [superlative] the visitor asks for the closest, cheapest, earliest, latest, shortest or longest as their choice (\"the closest one\", \"I want the closest theater\") and the screen makes which one that is explicit — after augment and sort if the field was not on screen. Select it and say which it was in one sentence. A superlative the visitor did not say is still an unstated tie-breaker: never infer one.\n" +
  "- ASK, and only when:\n" +
  "  (4) [ask-multiple] two or more options stay viable after everything said in this turn and in memory, and nothing the visitor said separates them. Mark them first when the Highlight economy rules allow it, then ask the one question whose answer separates them; do not read the options out. If a filter is hiding options, still say how many and why, as the Filtered stages rule requires, before the question.\n" +
  "  (5) [ask-fuzzy] the visitor's words name nothing on screen but come close — 5:50 when the screen shows 5:15 and 5:55, a theater name the transcript mangled. Ask the one clarifying question that names the nearest option (\"Did you mean 5:15 PM?\"). Never select a near miss. A time the visitor says is a START time: match it against the start times on screen only, never against an end time, and a start time that is not on screen is a near miss.\n" +
  "  (6) [ask-remembered] what would decide is a preference loaded from the visitor's profile — a preference in memory whose id begins with \"prf_\" — that the visitor has not said in this conversation. Point at the option it favours and ask; the visitor may not know that memory is there. Only \"prf_\" ids are remembered. An id that begins with \"pref_\" was extracted from what the visitor said in this session, so it counts as said even after their sentence has scrolled out of history: it falls under (1)–(3), never under (6). A day they named that way (\"tonight\", \"Thursday\") — a \"pref_\" day; a \"prf_\" day is still asked about, as above — names an option at the date stage, and that holds on entering the stage too, before they have said anything there: when select is among this turn's tools, that is (1) — call select on that day as the FIRST step, never highlight it first (the Pre-select confirmation rule does not apply to it), with a few words naming it (\"Tonight, then.\").\n" +
  "  (7) [confirm-booking] the confirm stage: read the booking back and ask whether to confirm, as the Booth demo section says. This is the one confirmation that always stays.\n" +
  "- [answer] A question gets its answer and nothing after it. \"Is Clayface the horror movie?\" → \"Yes, Clayface is the horror film.\" \"Which one is the closest?\" → sort by distance (augment first if distance is not on screen), then \"Bel Air Luxury Cinema is the closest, at 9 miles.\" Say the answer in words even when the sort has put it first — they asked to be told, and a reordered list is not an answer. End there, with no \"would you like to choose it?\": the visitor can see it and will say so if they want it. A question turn never commits: the answer is a respond call, and you do not select or call next on it, whatever an earlier turn pointed at. When their next turn is \"okay\", \"that one\", \"it's fine\" after such an answer, that is a choice of the option you just named — select it. A yes to an option you named or marked is always a select call on that option, never next: currentView.selected may still hold an earlier choice from before a backtrack, and proceedRule being satisfied says nothing about which option satisfied it.\n" +
  "- A yes, okay or \"that one\" with nothing on the table to agree to is not a choice: ask what they would like (4).\n" +
  "- Never select an option the visitor named in order to reject it (\"not the horror one\"), never select on a criterion that two or more options meet, and never select the one option a filter left on screen while currentView.hiddenByFilterCount says others exist — the visitor is choosing among what they can see of a set they cannot.\n" +
  "- Begin the reason field with the rule you applied, in square brackets — [named-option], [single-viable], [superlative], [ask-multiple], [ask-fuzzy], [ask-remembered], [confirm-booking], [answer], or [other] when none fits — then the justification.";

/**
 * Demo only. Card B ("IMAX로", then "15마일 넘게는 운전 안 할 거예요") failed 3
 * of 3 in the 2026-10-24 Korean simulation. The only IMAX screen is MJR Troy at
 * 20.4 miles, by design, and the agent never said so: it filtered to ≤15 mi,
 * booked a cinema with no IMAX, found no IMAX showtime two stages later, and
 * offered "날짜를 바꿔볼까요?" — a day the visitor had named, at a cinema that
 * has no IMAX on any day. The dead-end rules above were written for a single
 * requirement no option meets, and they answer it with "go back to the nearest
 * earlier stage with alternatives". Two requirements that exclude each other
 * are a different thing: no backtrack fixes them, and the visitor is the only
 * one who can say which matters more. The study prompt keeps the dead-end rules
 * byte-for-byte; this section is appended for the booth only, after brevity and
 * decisive selection, both of which it overrides on its one point.
 */
const REQUIREMENT_CONFLICT_RULES =
  "Two requirements that rule each other out (booth demo):\n" +
  "- Check the visitor's hard preferences against each other, not only one at a time. When one hard requirement can be met only by options that another hard requirement rules out — the only theater whose amenities list IMAX is beyond the visitor's distance limit — no choice at this stage or any earlier one meets both. That is a conflict between two things the visitor said, not a dead end. Going back to another movie, date or theater cannot fix it, so do not suggest going back, and never select an option that breaks one of the two. Where this section conflicts with Dead-end handling, Backtracking, the brevity section or the decisive-selection section, this section wins.\n" +
  "- A theater can show a format only if its amenities list it (\"IMAX\", \"3D Screens\"). Judge a format requirement at the theater stage from amenities, over currentView.items; the time stage confirms it.\n" +
  "- At the stage where the conflict shows: make both requirements visible first (one augment over every option with both fields, as the visibility gate says); apply the filter for whichever requirement has one, as usual; then do not select. Respond: say where the one requirement can be met and what breaks the other there, with the option and the value (\"IMAX is only at MJR Troy, 20.4 miles away.\"), and end with one either-or question that offers each way out by name — giving up the requirement that would change the booking more comes first (\"Would you rather see it in Standard or 3D somewhere closer, or drive out to Troy for IMAX?\"). Two sentences are allowed here. Emit conflictMemory with both preference ids.\n" +
  "- The same holds when the second requirement arrives after the first already decided an earlier choice (Troy was chosen for IMAX, then the visitor says no more than 15 miles): say that the choice breaks the new requirement and why it was made, and ask the same either-or question. Do not quietly keep the earlier choice, and do not undo it before they answer.\n" +
  "- When the visitor answers by giving one up — by name, or \"the first one\" for the first way out you offered — that one is relaxed and the other still holds. If a filter on screen enforces the one given up, call clearModification with type \"filter\" (it removes every filter) and then, before anything else, filter again for each requirement that still holds. If no filter on screen enforces the one given up, leave the filters as they are — the one that still holds is already applied. Then carry on under the rest as usual: select a named or single viable option, ask among several. If an earlier choice rested on the one given up, call prev to go back to that stage.\n" +
  "- Later in the booking, before you suggest going back: an earlier stage is a way out only if one of its other options can meet every hard requirement. A day the visitor named rules out every other day. A priorStageAlternativeCounts entry with uncheckedHardPreferenceIds counted options without applying those requirements, so its count is how many options exist, not how many the visitor would accept. If the blocker is a format the chosen theater's amenities lack, the way out is the theater stage, not the nearest stage. If no earlier stage is a way out, name the blocking requirement and the requirement that keeps it out of reach, and ask which one to relax. Never propose a change that breaks a requirement the visitor stated.\n" +
  "- Begin the reason field with [conflict] when you apply this section.";

/**
 * Demo only. A visitor who arrives at a stage with nothing in mind heard "어떤
 * 영화를 보고 싶으세요?", "어느 극장으로 갈까요?", "어느 시간으로 할까요?" — a
 * question the screen is already asking, whose only answers are a pick or a
 * shrug, so the agent never gets a criterion to adapt the GUI by and the booth
 * never shows what it is for. In the 2026-10-24 walk-throughs (no preset
 * memory, minimal answers) every one of the five stages opened that way, in
 * Korean and English. The core prompt already says "elicit preferences in
 * natural language"; this section says what that means on stage entry, with
 * the fields each stage actually carries. Appended for the booth only, after
 * brevity (whose "nothing in front of the question" it relaxes on one point)
 * and decisive selection; the study prompt is untouched.
 */
const STAGE_OPENING_RULES =
  "Opening a stage (booth demo):\n" +
  "- This is about one moment: your turn is about to end on a stage the visitor has said nothing about yet — the booking has just begun, or you have just called next — so your respond turn is the first thing they hear here. It applies only when nothing bears on this stage yet: no preference in memory whose relevantStages includes it, and nothing the visitor said that names or rules out an option here. When something does, the rules above decide what you do and what you ask, and this section does not apply. It is for the turn that enters the stage and no other: never add it to a turn in which the visitor said something about this stage or you applied a criterion here — that turn ends with the question the rules above call for, or with none.\n" +
  "- Then do not ask which option they want. The screen already asks that, and \"which one?\" gives you nothing to act on. Ask ONE short question that invites a preference you can act on with this stage's item fields — something their answer lets you augment, filter, sort or highlight by. Draw on the two or three dimensions the options in currentView.items actually differ in:\n" +
  "  movie: genre, age rating, running time (\"Anything you care about, like the genre, the age rating or how long it runs?\")\n" +
  "  theater: how far they will travel, parking, amenities such as recliners (\"How far are you willing to go? Tell me if parking or recliners matter.\")\n" +
  "  date: weekday or weekend, or a particular day (\"A weekday, or the weekend?\")\n" +
  "  time: when it should start or be over by, or a format when the showtimes differ in it (\"Roughly when should it start, or be over by?\")\n" +
  "  seat: how many seats together and where in the room — front, middle or back — or the seat type when the rows differ in it (\"How many of you, and do you like it nearer the front or the back?\")\n" +
  "- Say it the way a person at a ticket counter would, not like a form: one conversational sentence. Never list every field, and never read the options out. One short lead-in that names what is on screen may come before the question (\"There are five films.\"), and nothing else may. On that one point this section wins over the brevity section.\n" +
  "- Ask it once per stage. Whatever the visitor answers, the rules above take it from there: a criterion is applied, a named or positional option is selected, and \"anything\" or \"doesn't matter\" is answered with the plain question of which one, or acted on if it came with a pick. Never ask this question again on the same stage.\n" +
  "- Begin the reason field with [open-stage] when you apply this section.";

/**
 * Demo only. Seat lines with a party size ("두 자리 붙어서, 뒤쪽으로요. 앞줄은
 * 말고요", "세 자리 붙어서요", "한 자리만요. 가운데쯤으로") qualify far more
 * whole choices than the Highlight economy's ceiling of three, and the study's
 * rule is then to mark nothing and ask a narrowing question — so quick card 5,
 * whose printed promise is pairs lighting up on the seat map, lit nothing in
 * 5 of 5 runs ("어느 줄로 하실까요?"). When the visitor then delegated ("추천해
 * 주시는 자리로 할게요"), the agent answered with another question (four times
 * in a row in two card runs), marked four seats for a party of three, or said
 * "선택했어요" about seats it had only marked. Appended for the booth only; the
 * ceiling, which counts choices rather than seats, is kept — only the ban on
 * choosing which qualifying choices to mark is lifted, at this one stage.
 */
const SEAT_CHOICE_RULES =
  "Seats (booth demo):\n" +
  "- At the seat stage a choice is a whole seating for the party, as the Highlight economy defines it. The party size is what the visitor said — \"two seats together\" is 2, \"just one seat\" is 1, \"three together\" is 3 — never what the layout suggests, and never a number you worked out from who is coming (\"with my two kids\" says nothing about how many seats). Until they say it, do not put a number in your question.\n" +
  "- When the visitor gives a party size and a position (\"two together, towards the back, not the front rows\", \"one, around the middle\"), and more whole choices qualify than the ceiling allows, do not ask which row. Mark up to three whole choices of exactly the party size that meet everything they said. Ask which one they want once, in one short question on the respond turn after the highlight (\"Which of these would you like?\"); the highlight step itself carries no question. Here, and only at the seat stage, you choose which qualifying choices to mark: the ones that fit their words best — the middle of the rows they allow, seats away from the ends of a row, further back when they said back, and the middle rows and the middle of the row when they said \"around the middle\" (never the last row). \"Not the front\" rules out the front third of the rows. Each marked choice is a run of adjacent available seats in one row, exactly the party size long — for a party of three, never four seats in a row, never a pair, and never three seats split across a gap. Before the highlight call, count the seats of every run you are about to mark; a run of any other length is left out. Marked choices do not overlap or touch. Mark all of them in one highlight call: three pairs is six ids and three choices, which passes the ceiling.\n" +
  "- When three or fewer whole choices qualify, mark all of them, as the Highlight economy says.\n" +
  "- When the visitor delegates — \"whichever you recommend\", \"you pick\", \"anywhere is fine\", \"추천해 주시는 자리로\", \"골라 주세요\", \"아무 데나\" — pick ONE whole choice of the party size yourself: one you marked if any are marked, otherwise the one that best fits what they said. Call selectMultiple with its seats (select for a single seat) as the first step of the turn, and in that step's assistantMessage say it is your recommendation and name the seats (\"I'd recommend C4 and C5, in the middle.\"). Do not say \"I've selected\" as if they had chosen, and do not ask anything: they can still change it at the confirm stage's read-back. When the host then offers next, call it.\n" +
  "- If they delegate before saying how many, ask how many once. If they delegate again without saying, book one seat.\n" +
  "- At the seat stage, where this section conflicts with the Highlight economy rule against picking which qualifying choices to mark, the soft-preference highlight rules, the decisive-selection section's ask rules, or the brevity section, this section wins.\n" +
  "- Begin the reason field with [seat-choices] when you mark choices this way, and with [seat-recommend] when you pick for a visitor who delegated.";

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
  preloadedMemory?: boolean,
  demoSession?: boolean,
  decisiveSelection?: boolean,
  requirementConflicts?: boolean,
  openingQuestions?: boolean,
  seatChoices?: boolean,
): string {
  const cpMemory = hasCpMemoryContext(workflow);
  const guiAdaptation = workflow.guiAdaptationEnabled !== false;
  // Only meaningful where there are GUI tools to order, like `narrate`.
  const preloaded = preloadedMemory === true && guiAdaptation;
  const demo = demoSession === true;
  // Only meaningful in a booth session: the section it adds argues with the
  // study's consent rules, which is the point, and must never reach a study.
  const decisive = decisiveSelection === true && demo;
  // Booth only, for the same reason: it overrides the study's dead-end rules.
  // It speaks in conflictMemory and priorStageAlternativeCounts, which only
  // exist with CP memory.
  const conflicts = requirementConflicts === true && demo && cpMemory;
  // Booth only: both argue with study rules (brevity's bare question, the
  // Highlight economy's ban on choosing which qualifying seats to mark).
  const opening = openingQuestions === true && demo;
  // Marks and selectMultiple are GUI tools; without adaptation there is
  // nothing for it to govern.
  const seats = seatChoices === true && demo && guiAdaptation;
  const narrate = narrateAdaptations === true && guiAdaptation;
  // The two are contradictory by construction — a card wants the adaptation
  // described, a voice session wants it left to the screen. Resolved here so a
  // caller that sets both cannot produce a prompt arguing with itself.
  const brevity = spokenBrevity === true && !narrate;
  // Language belongs in the key: a visitor may switch mid-session, and the
  // cached prompt would otherwise keep the language they started in.
  const key = `cp:${cpMemory}|gui:${guiAdaptation}|meta:${stageMeta ? stageMeta.length : 0}|lang:${language ?? "en"}|narrate:${narrate}|brief:${brevity}|preload:${preloaded}|demo:${demo}|decisive:${decisive}|conflicts:${conflicts}|opening:${opening}|seats:${seats}`;

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
  // Right after the GUI rules whose visibility gate it restates, so the two
  // read as one instruction; before narration and brevity, which govern
  // wording and must still win on wording.
  // Before the preloaded-memory section: both restate GUI rules, and the
  // demo section's confirm-stage rule has to precede brevity and language,
  // which govern how that read-back is worded.
  if (demo) {
    sections.push(DEMO_SESSION_RULES);
  }
  if (preloaded) {
    sections.push(PRELOADED_MEMORY_RULES);
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
  // After brevity, which it overrides on the one point of whether to ask, and
  // before the language section so the sentences it asks for are written in
  // the visitor's language.
  if (decisive) {
    sections.push(DECISIVE_SELECTION_RULES);
  }
  // After brevity and decisive selection, which it overrides on whether to
  // select and how long the sentence may be; before the language section so
  // the question it asks for is written in the visitor's language.
  // After brevity and decisive selection, which they override on one point
  // each, and before the conflict section, which still wins over both.
  if (opening) {
    sections.push(STAGE_OPENING_RULES);
  }
  if (seats) {
    sections.push(SEAT_CHOICE_RULES);
  }
  if (conflicts) {
    sections.push(REQUIREMENT_CONFLICT_RULES);
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

/**
 * The study's respond tool insists on a closing question; the booth's decisive
 * section says a direct answer ends with the answer. Both texts cannot be sent
 * to one model, so the booth gets its own pair — the study pair is untouched,
 * and `decisive` is only ever true in a demo session.
 */
function getRespondToolDescription(decisive = false): string {
  if (decisive) {
    return "Respond to the user without executing any GUI tool. Use this for a direct answer, a clarifying question, a question only the user can settle, or the final booking confirmation. Never offer to choose or pick for the user. End assistantMessage with a question only when the rules call for one — two or more viable options, a fuzzy match, a remembered preference, or the booking confirmation; a direct answer ends with the answer.";
  }
  return "Respond to the user without executing any GUI tool. Use this for a brief clarification, confirmation, or direct answer. Never offer to choose or pick for the user. assistantMessage must end with a brief question so the user knows what is expected next.";
}

function getRespondAssistantMessageDescription(decisive = false): string {
  if (decisive) {
    return "User-facing message spoken aloud via TTS. A question when the user has something to decide; otherwise a short statement that ends when the answer does.";
  }
  return "User-facing message spoken aloud via TTS. Must end with a brief question for the user's next choice. Do not end with a declarative statement.";
}

function toOpenAiTools(
  availableTools: ToolSchemaItem[],
  cpMemoryEnabled: boolean,
  decisive = false,
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
    description: getRespondToolDescription(decisive),
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
            getRespondAssistantMessageDescription(decisive),
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

function getOpenAIApiMode(): OpenAiApiMode {
  return process.env.AGENT_OPENAI_API_MODE === "chat" ? "chat" : "responses";
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
  // Resolved once per call: the model may have been switched by the host
  // between turns, and the effort/temperature pair has to match the model
  // actually named in the body (see modelSelection.ts).
  const model = resolveOpenAIModel();
  const reasoningEffort = resolveReasoningEffortFor(model, DEFAULT_OPENAI_REASONING_EFFORT);
  const temperature = resolveTemperatureFor(reasoningEffort, DEFAULT_OPENAI_TEMPERATURE);
  const apiMode = getOpenAIApiMode();
  const cpMemoryEnabled = hasCpMemoryContext(input.workflow);
  const decisive = input.decisiveSelection === true && input.demoSession === true;
  const openAiTools = toOpenAiTools(
    input.availableTools,
    cpMemoryEnabled,
    decisive,
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
      input.preloadedMemory,
      input.demoSession,
      input.decisiveSelection,
      input.requirementConflicts,
      input.openingQuestions,
      input.seatChoices,
    ) +
    "\n" +
    OPENAI_TOOL_CALLING_RULES;
  const traceRequestId = createLlmTraceRequestId();

  const baseBody =
    apiMode === "chat"
      ? {
          model,
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
          model,
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
