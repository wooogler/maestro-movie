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
  "- Treat workflow.currentView as the authoritative screen state for the current stage. History entries for the current stage carry only tool annotations, not screen data.\n" +
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
  "- workflow.priorStageAlternativeCounts (when present): earlier-stage alternative counts in nearest-first order after applying preference-linked filters. Use them to judge flexibility when suggesting backtracking.\n" +
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
  "  1. Hard pass: identify all items satisfying every hard preference. Surface this full set — never narrow it by a soft preference.\n" +
  "  2. Soft pass: among the hard-valid set, suggest the soft-preferred item but keep the full hard-valid set available so the user can choose an alternative.\n" +
  "  3. If exactly one hard-valid item exists, suggest it. If zero exist, see dead-end rules below.\n" +
  "- If hard-valid items exist but none satisfy the soft preference, suggest the closest match — do not suggest backtracking for a soft failure alone.\n" +
  "\n" +
  "Dead-end handling:\n" +
  "- workflow.currentView.deadEndItemIds (when present): item IDs that are dead-ended downstream. Never select or recommend these.\n" +
  "- Apply preferences after excluding dead-ended items. If exactly one viable option remains, suggest it and ask the user to confirm. This is not a conflict, so do not emit conflictMemory. If multiple remain, ask the user to choose.\n" +
  "- If no visible option satisfies a hard preference, emit conflictMemory, briefly explain why, and suggest going back to the nearest earlier stage that has remaining alternatives (based on priorStageAlternativeCounts). Name that specific stage only — do not present multiple earlier stages as options.\n" +
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
  "- When currentStage === backtrackContinuation.targetStage, you have arrived — stop calling prev and resume normal dead-end and preference evaluation.\n" +
  "- If a hard requirement cannot be verified from the current GUI state and no tool can surface it, treat as a dead end.";

const CP_MEMORY_DISABLED_PROMPT_RULES =
  "Backtracking:\n" +
  "- If the user wants to go back and prev is available, call prev immediately.\n" +
  "- If no visible option satisfies the user's stated requirement and prev is available, briefly explain why and ask whether they'd like to go back.";

const GUI_ADAPTATION_ENABLED_RULES =
  "GUI adaptation rules:\n" +
  "\n" +
  "Turn sequencing for GUI tools:\n" +
  "- If the provided tools are limited to GUI adaptation tools, continue applying pending preference-based GUI actions before responding.\n" +
  "- After a GUI action, do not restate or reference what the previous turn already conveyed (e.g., avoid 'already highlighted', 'I've filtered'). If no further GUI action is needed, ask a brief confirmation question.\n" +
  "\n" +
  "assistantMessage style:\n" +
  "- Treat assistantMessage as a brief spoken cue. Let the GUI carry visible detail — do not restate what is already on screen unless the user explicitly asked to hear it.\n" +
  "- Do not mention item metadata in assistantMessage if it is not already visible in the UI; surface it through a GUI tool first.\n" +
  "\n" +
  "How tools stack:\n" +
  "- All GUI tools accumulate — filter + sort means filtered first, then sorted within the remaining set.\n" +
  "- When a preference changes (e.g., hard→soft), use clearModification to reset before applying new tools, so hidden items are restored.\n" +
  "\n" +
  "Tool selection by preference strength:\n" +
  "Step 1 — visibility gate (MANDATORY, always first): for each active criterion, does its field appear in visibleItems[].value?\n" +
  "  visibleItems[].value is the text the user sees. If ANY criterion maps to a field not in those strings, call augment to surface ALL missing criteria in one call before proceeding to filter/highlight/sort.\n" +
  "  Never treat item IDs or ID substrings as visible fields.\n" +
  "Step 2 — if the field IS visible, apply by strength:\n" +
  "  Hard (user can accept ONLY matching options):\n" +
  "  - filter to hide non-matching items.\n" +
  "  - If filter is not available, highlight ALL matching items instead — do not narrow the set by a soft preference.\n" +
  "  - If no option matches, do not filter — respond explaining why.\n" +
  "  Soft (user prefers but would accept alternatives):\n" +
  "  - Ordinal field (rating, time, distance, price …): sort.\n" +
  "  - Categorical field (genre, format, type …): highlight.\n" +
  "  - When highlighting for a soft preference, include all user-stated acceptable options — not just the top pick. Suggest the preferred one in assistantMessage.\n" +
  "  - If a hard preference already highlighted multiple items, do not re-highlight a smaller subset. Instead, mention the soft-preferred item in assistantMessage.\n" +
  "  - Exception: when visible items are numerous, filter is acceptable.\n" +
  "\n" +
  "augment notes:\n" +
  "- Surface only the missing criterion or criteria needed for the user's current request or the immediate next GUI action. Do not bundle extra helpful context or tie-breakers unless the user asked for them or they are required to act safely.\n" +
  "- augment replaces visibleItems display text only — raw item data is unchanged, so filter (which operates on raw fields) is independent of augment.\n" +
  "- filter operates only on native item fields present in items[].\n" +
  "- If a criterion is not visible and remains relevant after another GUI action, augment is still required on the next turn before asking a tie-break question.\n" +
  "\n" +
  "Pre-select confirmation:\n" +
  "- When preference evaluation narrows to a single viable option, highlight it first. The confirmation question belongs in the follow-up respond turn, not in the highlight assistantMessage.\n" +
  "\n" +
  "Guardrails:\n" +
  "- Do not sort, filter, or augment without a user criterion or stage-relevant preference. Without one, prefer respond.";

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
  '- For highlight, also include "coverage": use "full" when the highlighted items are every item satisfying the relevant preference(s), and "partial" when they are only a suggested subset. Coverage describes the preference match, not the stage inventory.\n' +
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

export function buildLanguageSection(language: string | undefined): string | null {
  if (!language || language === "en") return null;
  return LANGUAGE_PROMPTS[language] ?? null;
}

// ── System prompt cache ─────────────────────────────────────────────────────
// cpMemoryEnabled + guiAdaptationEnabled + stageMeta are fixed for a session,
// so we memoize by the combination key to avoid rebuilding on every turn.

let cachedSystemPromptKey = "";
let cachedSystemPrompt = "";

function buildSystemPrompt(
  workflow: PlannerWorkflow,
  stageMeta?: Array<{ stage: string; goal: string; fieldGuide: string }>,
  language?: string,
): string {
  const cpMemory = hasCpMemoryContext(workflow);
  const guiAdaptation = workflow.guiAdaptationEnabled !== false;
  // Language belongs in the key: a visitor may switch mid-session, and the
  // cached prompt would otherwise keep the language they started in.
  const key = `cp:${cpMemory}|gui:${guiAdaptation}|meta:${stageMeta ? stageMeta.length : 0}|lang:${language ?? "en"}`;

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
          'Use "full" when the highlighted items are every item satisfying the linked preference(s); use "partial" when the highlight is only a suggested subset. This describes the preference match only — it says nothing about how many options the stage still has.',
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
  return process.env.AGENT_OPENAI_MODEL || "gpt-5.4";
}

function getOpenAIApiMode(): OpenAiApiMode {
  return process.env.AGENT_OPENAI_API_MODE === "chat" ? "chat" : "responses";
}

function resolveOpenAITemperature(): number | undefined {
  return DEFAULT_OPENAI_TEMPERATURE;
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
    buildSystemPrompt(input.workflow, input.stageMeta, input.language) +
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
  const body =
    typeof temperature === "number" ? { ...baseBody, temperature } : baseBody;
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
