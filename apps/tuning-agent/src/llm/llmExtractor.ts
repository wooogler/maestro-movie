import { refreshModelEnvVars } from "../core/envRefresh";
import {
  createPreferenceId,
  isProfilePreferenceId,
  normalizePreferenceList,
} from "../core/cpMemory";
import { resolveOpenAiApiKey } from "./openaiKey";
import { fetchOpenAiWithRetry } from "./resilientFetch";
import { CONFLICT_STAGES } from "../types";
import type { ConflictStage, Preference } from "../types";
import {
  resolveOpenAIModel,
  resolveReasoningEffortFor,
  resolveTemperatureFor,
} from "./modelSelection";

interface PreferenceExtractionInput {
  userMessage: string;
  currentStage: string;
  state: Record<string, unknown> | null;
  compactUi: unknown;
  recentDialogue: Array<{ type: "user" | "agent"; text: string }>;
  existingPreferences: Array<{
    id: string;
    description: string;
    strength: "hard" | "soft";
    relevantStages: ConflictStage[];
  }>;
}

interface PreferenceExtractionOutput {
  hasUpdate: boolean;
  preferences: Array<{
    /**
     * Echoed from existingPreferences when the entry is being kept or amended.
     * Empty for a genuinely new preference — the id is minted on this side.
     */
    id: string;
    description: string;
    strength: "hard" | "soft";
    relevantStages: ConflictStage[];
  }>;
  /**
   * Ids the user has explicitly withdrawn. Absent means nothing was withdrawn,
   * which is why an omitted hard preference is retained rather than dropped.
   */
  retractedIds?: string[];
}

interface LlmTraceEvent {
  component: "extractor";
  type: "request" | "response.raw" | "response.parsed" | "error";
  payload: unknown;
}

type LlmTraceListener = (event: LlmTraceEvent) => void;
type ExtractionKind = "preferences";

const DEBUG_LLM = process.env.AGENT_LLM_DEBUG === "true";

// Always emitted. The listeners decide what to do with an event: the agent
// monitor honours AGENT_MONITOR_LLM_TRACE, the study trace writer honours the
// visitor's consent. Gating here once silenced both, and a demo session
// started from a backend with the flag off wrote no *.llm-trace.jsonl at all.
const llmTraceListeners = new Set<LlmTraceListener>();
let llmTraceRequestSequence = 0;

function emitLlmTrace(type: LlmTraceEvent["type"], payload: unknown): void {
  const event: LlmTraceEvent = { component: "extractor", type, payload };
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

const PREFERENCE_SYSTEM_PROMPT =
  "You maintain the user preference list for a booking agent.\n" +
  "Input: userMessage, currentStage, state, compactUi, recentDialogue, existingPreferences.\n" +
  "Output: { hasUpdate, preferences, retractedIds }.\n" +
  "- Every entry in existingPreferences carries an `id`. It is that preference's identity and it never changes, even when the wording does.\n" +
  "- preferences: the full current preference list as you understand it. Echo the `id` for every entry you are keeping or amending. Use an empty id (\"\") only for a preference the user has just introduced.\n" +
  "- retractedIds: the ids the user has explicitly withdrawn or replaced.\n" +
  "- A hard preference you omit from preferences is KEPT. To remove one, you must list its id in retractedIds. Soft preferences you omit are dropped.\n" +
  "\n" +
  "Procedural vs durable — read the full recentDialogue first:\n" +
  "- Procedural: the agent had narrowed the list and asked the user to choose, and the user answers with one of the offered items and nothing else. That is a selection, not a new requirement. → set hasUpdate=false, preferences=[].\n" +
  "- Durable: the user freely states what they want — a name, a constraint, a desire. This is a preference even if it matches a visible item. Store it.\n" +
  "- When in doubt, set hasUpdate=false, preferences=[].\n" +
  "\n" +
  "Strength — ask one question: if the only remaining options all failed this, would the user rather be shown them anyway, or be told there is no match?\n" +
  '- "told there is no match" -> "hard". "show me anyway" -> "soft".\n' +
  "- A constraint the user states unprompted with a concrete value — a cutoff time, a format, a seat count, a required amenity, an age rating — is HARD by default, whatever verb introduces it. \"I want two seats together\" and \"I need two seats together\" are the same requirement.\n" +
  '- "hard": user accepts ONLY matching options (cues: must, only, need, should, no later than).\n' +
  '- "hard": user volunteers a specific item by name when the agent did NOT just ask them to choose (e.g. naming a movie at the start of the task). Wanting that item is the requirement. If the agent had just asked, treat it as Procedural instead.\n' +
  '- "hard": user restates an existing soft preference without any hedging words (prefer, ideally, if possible) — treat the restatement as an upgrade to hard.\n' +
  '- "soft": user prefers but would still accept an alternative (cues: prefer, ideally, if possible, would be nice). Hedging language only makes something soft when the user is expressing a taste, not naming a concrete requirement.\n' +
  "- If one clause combines a hard acceptance constraint with a soft tie-breaker, extract them as separate preferences.\n" +
  "- When one utterance states the same KIND of constraint for two branches (e.g. a time window for Saturday and a time window for Sunday), give them the same strength. The user is describing one requirement that applies per branch, not one requirement and one whim, and the verb they happened to use for each is not the difference.\n" +
  '- Genuinely vague wants with no concrete value ("something fun", "a good seat") default to "soft". This does not override the concrete-value rule above.\n' +
  "\n" +
  "Updating existingPreferences:\n" +
  "- Unchanged: re-emit the entry with its wording and relevantStages untouched. Keeping an existing preference is the DEFAULT. Never omit an entry merely because this turn was not about it.\n" +
  "- Changed (strength, scope, or value): re-emit it with the SAME id and the new text. Only rewrite the wording when what the user wants actually changed — a cosmetic rewrite of an unchanged preference is an error.\n" +
  "- Dormant: a preference scoped to a branch the user is not currently on (e.g. a Saturday-only time window while Sunday is selected) is NOT withdrawn. Keep it, with its qualifier, exactly as written. Requirements for different branches coexist; choosing one branch does not retract the other. If the user has told you both branches, write BOTH as separate scope-qualified entries.\n" +
  "- Retracted: list the entry's id under retractedIds, and only when the user withdrew it in THIS turn. Omitting an entry from preferences is NOT a way to withdraw it.\n" +
  "- If the agent's own last message asked the user to relax ONE named requirement and the user agreed, retract only that requirement. Never retract requirements that were not asked about.\n" +
  '- Write each description as a short sentence capturing user intent (e.g. "Wants to watch Cosmic Laughs.", "Prefers evening showtimes."). One entry per distinct preference.\n' +
  "- If a preference is conditioned on or scoped to a choice at another stage, preserve the qualifier in the description. Dropping it turns a conditional preference into an unconditional one.\n" +
  "- Assign relevantStages using stageFieldGuides.";

export function getExtractorSystemPrompt(): string {
  return ["Preference Extraction Prompt:", PREFERENCE_SYSTEM_PROMPT].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function createLlmTraceRequestId(kind: ExtractionKind): string {
  llmTraceRequestSequence += 1;
  return `${kind}-${llmTraceRequestSequence}`;
}

function formatTraceError(error: unknown): {
  errorMessage: string;
  errorName?: string;
} {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      ...(error.name ? { errorName: error.name } : {}),
    };
  }
  return { errorMessage: String(error) };
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

function toConflictStage(value: string): ConflictStage | null {
  switch (value) {
    case "movie":
    case "theater":
    case "date":
    case "time":
    case "seat":
    case "confirm":
      return value;
    default:
      return null;
  }
}

function normalizeDescription(value: unknown): string | null {
  const text = readTrimmedString(value);
  if (!text) return null;
  return text.replace(/\s+/g, " ");
}

function normalizePreferenceStrength(value: unknown): Preference["strength"] {
  return value === "soft" ? "soft" : "hard";
}

function normalizeRelevantStages(
  value: unknown,
  fallback: readonly ConflictStage[] = CONFLICT_STAGES,
): ConflictStage[] {
  const normalized: ConflictStage[] = [];
  const seen = new Set<ConflictStage>();
  const source = Array.isArray(value) ? value : fallback;
  for (const item of source) {
    if (typeof item !== "string") continue;
    const stage = toConflictStage(item);
    if (!stage || seen.has(stage)) continue;
    seen.add(stage);
    normalized.push(stage);
  }
  return normalized.length > 0 ? normalized : CONFLICT_STAGES.slice();
}

/**
 * Merge the extractor's output into the existing preference list.
 *
 * Identity comes from the echoed `id`, not from the description text. That is
 * what lets a preference be reworded without becoming a different preference —
 * the dead ends and filter traces keyed on it survive the edit.
 *
 * Two safety nets, because the model can forget to echo an id:
 *   - an entry whose description exactly matches an existing one inherits that
 *     entry's id rather than being minted as a duplicate;
 *   - an omitted HARD preference is carried forward. Withdrawing one requires
 *     naming its id in `retractedIds`. Soft preferences are still revisable by
 *     restating the list.
 */
function materializePreferences(
  raw: PreferenceExtractionOutput,
  existingPreferences: Preference[],
): Preference[] {
  const existingById = new Map(existingPreferences.map((item) => [item.id, item]));
  const existingByDescription = new Map(
    existingPreferences.map((item) => [normalizeDescription(item.description), item]),
  );
  const retractedIds = new Set(raw.retractedIds ?? []);

  const preferences: Preference[] = [];
  const returnedIds = new Set<string>();
  for (const rawPreference of raw.preferences) {
    const description = normalizeDescription(rawPreference.description);
    if (!description) continue;

    const echoedId = rawPreference.id.trim();
    const matched =
      (echoedId ? existingById.get(echoedId) : undefined) ??
      existingByDescription.get(description);
    const id = matched?.id ?? createPreferenceId();
    if (retractedIds.has(id)) continue;
    if (returnedIds.has(id)) continue;
    returnedIds.add(id);

    preferences.push({
      id,
      description,
      strength: normalizePreferenceStrength(rawPreference.strength),
      relevantStages: normalizeRelevantStages(
        rawPreference.relevantStages,
        matched?.relevantStages,
      ),
    });
  }

  // Carry forward hard constraints the model neither restated nor retracted,
  // and profile-seeded entries at EITHER strength.
  //
  // A seeded preference was never said out loud, so the model has no reason to
  // restate it; under the hard-only rule a soft one would vanish on the
  // visitor's first sentence — and intermittently at that, since a `hasUpdate:
  // false` response skips this rewrite entirely. Retraction still removes it:
  // `retractedIds` remains the only way out, which is what keeps "forget the
  // closer-theater thing" working on a seeded preference.
  const carriedForward = existingPreferences.filter(
    (item) =>
      (item.strength === "hard" || isProfilePreferenceId(item.id)) &&
      !returnedIds.has(item.id) &&
      !retractedIds.has(item.id),
  );

  return normalizePreferenceList([...preferences, ...carriedForward]);
}

function toPreferenceExtractionOutput(
  value: Record<string, unknown>,
): PreferenceExtractionOutput | null {
  const hasUpdate = value.hasUpdate === true;

  const retractedIds = Array.isArray(value.retractedIds)
    ? value.retractedIds
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry): entry is string => Boolean(entry))
    : [];

  const rawPreferences = Array.isArray(value.preferences)
    ? value.preferences
    : null;
  if (!rawPreferences) return { hasUpdate, preferences: [], retractedIds };

  const preferences: PreferenceExtractionOutput["preferences"] = [];
  for (const entry of rawPreferences) {
    if (!isRecord(entry)) continue;
    const description = normalizeDescription(entry.description);
    if (!description) continue;
    preferences.push({
      id: typeof entry.id === "string" ? entry.id.trim() : "",
      description,
      strength: normalizePreferenceStrength(entry.strength),
      relevantStages: normalizeRelevantStages(entry.relevantStages),
    });
  }

  return { hasUpdate, preferences, retractedIds };
}
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_CHAT_COMPLETIONS_API_URL =
  "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_TEMPERATURE = 0;
/**
 * Explicit for the same reason as in llmPlanner: gpt-5.4 defaulted to `none`
 * when this was omitted and the GPT-5.6 family defaults to `medium`, so leaving
 * it out would have changed extraction behaviour -- and the cost of every turn
 * -- as a side effect of the model swap. It also keeps `temperature` legal,
 * which GPT-5.6 refuses once reasoning is active.
 */
const DEFAULT_OPENAI_REASONING_EFFORT = "none" as const;
type OpenAiApiMode = "responses" | "chat";

function getOpenAIApiMode(): OpenAiApiMode {
  return process.env.AGENT_OPENAI_API_MODE === "chat" ? "chat" : "responses";
}

function resolveOpenAIReasoning(
  kind: ExtractionKind,
  model: string,
): { effort: "none" | "low" | "medium"; summary?: "auto" } | undefined {
  void kind;
  return { effort: resolveReasoningEffortFor(model, DEFAULT_OPENAI_REASONING_EFFORT) };
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

// OpenAI auth errors echo a partially masked key back in the error body; strip
// anything key-shaped before it reaches a log or trace.
function redactApiKeys(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_*\-]{6,}/g, "sk-[redacted]");
}

function parseReasoningSummary(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const output = Array.isArray(record.output) ? record.output : [];
  const summaries: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type !== "reasoning") continue;
    const summary = Array.isArray(itemRecord.summary) ? itemRecord.summary : [];
    for (const entry of summary) {
      if (!entry || typeof entry !== "object") continue;
      const entryRecord = entry as Record<string, unknown>;
      if (typeof entryRecord.text === "string" && entryRecord.text.trim()) {
        summaries.push(entryRecord.text.trim());
      }
    }
  }
  return summaries.length > 0 ? summaries : null;
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
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return null;
  const choiceRecord = firstChoice as Record<string, unknown>;
  const message =
    choiceRecord.message &&
    typeof choiceRecord.message === "object" &&
    !Array.isArray(choiceRecord.message)
      ? (choiceRecord.message as Record<string, unknown>)
      : null;
  if (!message) return null;

  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }

  const content = Array.isArray(message.content) ? message.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type !== "text") continue;
    if (typeof itemRecord.text === "string" && itemRecord.text.trim()) {
      return itemRecord.text.trim();
    }
  }
  return null;
}

async function callOpenAIJson(
  kind: ExtractionKind,
  systemPrompt: string,
  input: unknown,
  schema: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (process.env.AGENT_ENABLE_OPENAI === "false") return null;
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) return null;

  const model = resolveOpenAIModel();
  const reasoning = resolveOpenAIReasoning(kind, model);
  const temperature = resolveTemperatureFor(reasoning?.effort, DEFAULT_OPENAI_TEMPERATURE);
  const apiMode = getOpenAIApiMode();
  const baseBody =
    apiMode === "chat"
      ? {
          model,
          messages: [
            {
              role: "system",
              content: `${systemPrompt}\n- Return JSON only via schema.`,
            },
            { role: "user", content: JSON.stringify(input) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: `${kind}_result`,
              strict: false,
              schema,
            },
          },
        }
      : {
          model,
          input: [
            {
              role: "system",
              content: `${systemPrompt}\n- Return JSON only via schema.`,
            },
            { role: "user", content: JSON.stringify(input) },
          ],
          text: {
            format: {
              type: "json_schema",
              name: `${kind}_result`,
              strict: false,
              schema,
            },
          },
        };
  const body = {
    ...baseBody,
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(apiMode === "chat"
      ? reasoning?.effort
        ? { reasoning_effort: reasoning.effort }
        : {}
      : reasoning
        ? { reasoning }
        : {}),
  };
  const traceRequestId = createLlmTraceRequestId(kind);
  const apiUrl =
    apiMode === "chat" ? OPENAI_CHAT_COMPLETIONS_API_URL : OPENAI_API_URL;

  if (DEBUG_LLM) {
    console.log(
      `[tuning-agent][extractor:${kind}:openai] request:`,
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
          kind,
          provider: "openai",
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
      kind,
      provider: "openai",
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
          kind,
          provider: "openai",
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
      if (response.status === 401 || response.status === 403) {
        console.error(
          `[tuning-agent][extractor:${kind}:openai] OpenAI rejected the API key (${response.status}):`,
          errorText,
        );
      }
      emitLlmTrace("error", {
        requestId: traceRequestId,
        kind,
        provider: "openai",
        status: response.status,
        errorText,
      });
      throw new Error(
        `OpenAI extractor failed (${response.status}): ${errorText}`,
      );
    }
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch (error) {
    emitLlmTrace("error", {
      requestId: traceRequestId,
      kind,
      provider: "openai",
      phase: "response.json",
      ...formatTraceError(error),
    });
    throw error;
  }
  const outputText =
    apiMode === "chat"
      ? parseChatCompletionOutputText(payload)
      : parseOpenAIOutputText(payload);
  const reasoningSummary =
    apiMode === "chat" ? null : parseReasoningSummary(payload);
  emitLlmTrace("response.raw", {
    requestId: traceRequestId,
    kind,
    provider: "openai",
    outputText,
    reasoningSummary,
  });
  if (!outputText) return null;

  const parsed = parseJsonObject(outputText);
  emitLlmTrace("response.parsed", {
    requestId: traceRequestId,
    kind,
    provider: "openai",
    parsed,
  });
  return parsed;
}

async function callStructuredExtractor(
  kind: ExtractionKind,
  systemPrompt: string,
  input: unknown,
  schema: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  refreshModelEnvVars();
  const openaiEnabled =
    process.env.AGENT_ENABLE_OPENAI !== "false" &&
    Boolean(resolveOpenAiApiKey());

  if (!openaiEnabled) {
    throw new Error("EXTRACTION_PROVIDER_UNAVAILABLE");
  }

  return await callOpenAIJson(kind, systemPrompt, input, schema);
}

export interface PreferenceExtractionContext {
  userMessage: string;
  currentStage: string;
  state: Record<string, unknown> | null;
  compactUi: unknown;
  recentDialogue: Array<{ type: "user" | "agent"; text: string }>;
  existingPreferences: Preference[];
  stageMeta?: Array<{ stage: string; goal: string; fieldGuide: string }>;
  /** The host-reported conversation language. Absent and 'en' are identical. */
  language?: string;
  /**
   * A booth demo session (AGENT_STUDY_MODE=demo). Absent or false leaves the
   * prompt exactly as the study ran it. See boothStageFieldGuides.
   */
  demoSession?: boolean;
}

/*
  Booth demo only: a screening format is a theater property too.

  The stage field guides come from the frontend's STAGE_META, which study
  sessions send as well, and the study's guide says outright that IMAX and 3D
  are "NOT a property of theaters". That was the reason card B failed 3 of 3 in
  the 2026-10-24 Korean simulation: "IMAX로 보려고요" was scoped to the time
  stage only, so at the theater stage the planner filtered on distance alone,
  booked a cinema with no IMAX screen, and met the dead end two stages later.
  In the booth world a cinema's `amenities` list the formats its screens show
  ("IMAX", "3D Screens") and a cinema without the amenity has no showing in that
  format (demo_uist2026_detroit.json: IMAX only at MJR Troy, in amenities and
  showings alike), so a format requirement can be judged where the cinema is
  chosen. The rewrite happens here, on the agent, so the frontend keeps sending
  the study's text and a study session's extractor prompt is unchanged.
  `plannerPrompt.check.ts` pins both halves: the study sentences it replaces
  are still in generators.ts, and the study prompt is untouched without the flag.
*/
export const STUDY_THEATER_FORMAT_NOTE =
  "Note: screening format (IMAX, 3D) is NOT a property of theaters — it varies per showtime and belongs to the time stage.";
export const STUDY_TIME_FORMAT_NOTE =
  "Important: IMAX and 3D are per-showtime attributes determined at this stage, not at the theater stage.";
const BOOTH_THEATER_FORMAT_NOTE =
  'Screening format: amenities list the formats a theater\'s screens can show ("IMAX", "3D Screens"), and a theater whose amenities lack a format never shows a film in it. So a screening-format requirement (IMAX, 3D) is relevant to this stage as well as to time — assign it to both theater and time.';
const BOOTH_TIME_FORMAT_NOTE =
  "IMAX and 3D are per-showtime attributes confirmed at this stage; a screening-format requirement belongs to both theater and time.";

/** Appended to the extractor prompt in a booth session: see the field-guide note above. */
const BOOTH_RELAXATION_LINE =
  "Booth demo:\n" +
  "- If the agent's last message said two of the user's requirements cannot both be met and offered two ways out — one that gives up requirement A, one that gives up requirement B — and the user picks one, retract only the requirement the picked way out gives up, and keep the other unchanged.\n" +
  "- A positional answer counts in the order of the agent's message: \"the first one\" / \"첫 번째\" is the way out the agent offered first, \"the second one\" / \"두 번째\" the one it offered after it. Example: agent \"IMAX is only at MJR Troy, 20.4 miles away. See it in Standard or 3D closer by, or drive to Troy for IMAX?\" — \"the first one\" gives up IMAX and keeps the distance limit; \"Troy, then\" gives up the distance limit and keeps IMAX.";

function replaceOrAppend(guide: string, studyNote: string, boothNote: string): string {
  return guide.includes(studyNote)
    ? guide.replace(studyNote, boothNote)
    : `${guide} ${boothNote}`;
}

export function boothStageFieldGuides(
  stageMeta: Array<{ stage: string; goal: string; fieldGuide: string }>,
): Array<{ stage: string; goal: string; fieldGuide: string }> {
  return stageMeta.map((meta) => {
    if (meta.stage === "theater") {
      return { ...meta, fieldGuide: replaceOrAppend(meta.fieldGuide, STUDY_THEATER_FORMAT_NOTE, BOOTH_THEATER_FORMAT_NOTE) };
    }
    if (meta.stage === "time") {
      return { ...meta, fieldGuide: replaceOrAppend(meta.fieldGuide, STUDY_TIME_FORMAT_NOTE, BOOTH_TIME_FORMAT_NOTE) };
    }
    return meta;
  });
}

/**
 * The extractor's system prompt, before the JSON-only line the call appends.
 * Exported for `plannerPrompt.check.ts`, which pins that a study session's
 * prompt is unchanged and that the booth flag only rewrites the format notes.
 */
export function buildPreferenceSystemPrompt(
  stageMeta: Array<{ stage: string; goal: string; fieldGuide: string }> | undefined,
  language: string | undefined,
  demoSession?: boolean,
): string {
  const booth = demoSession === true;
  const guides = stageMeta && booth ? boothStageFieldGuides(stageMeta) : stageMeta;
  const basePrompt = guides
    ? PREFERENCE_SYSTEM_PROMPT +
      "\n\nstageFieldGuides:\n" +
      guides.map((s) => `- ${s.stage}: ${s.fieldGuide}`).join("\n")
    : PREFERENCE_SYSTEM_PROMPT;
  const languageLine = buildPreferenceLanguageLine(language);
  const withLanguage = languageLine ? `${basePrompt}\n\n${languageLine}` : basePrompt;
  return booth ? `${withLanguage}\n\n${BOOTH_RELAXATION_LINE}` : withLanguage;
}

/**
 * Appended for the languages added after the recorded study, so a Japanese
 * visitor's memory panel reads in Japanese like the rest of the conversation.
 *
 * English gets nothing, so its prompt is byte-identical to the one the study
 * ran. Korean also gets nothing: the study ran in Korean with this prompt as
 * it stands, and its descriptions came back in whatever language the model
 * chose — changing that is a decision about Korean sessions, not part of
 * adding languages.
 */
const PREFERENCE_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ja: "Japanese",
  "zh-Hans": "Chinese, in Simplified characters",
  "zh-Hant": "Chinese, in Traditional characters",
  de: "German",
  fr: "French",
  es: "Spanish",
};

export function buildPreferenceLanguageLine(language: string | undefined): string | null {
  const name = language ? PREFERENCE_LANGUAGE_NAMES[language] : undefined;
  if (!name) return null;
  return (
    "Language:\n" +
    `- The user is speaking ${name}. Write every new or rewritten description in ${name}.\n` +
    "- Keep film titles, cinema names, formats, seat ids, dates, times and prices exactly as they appear on screen.\n" +
    "- An unchanged existing preference keeps its wording as it is, whatever language it is in. id, strength and relevantStages are unaffected by language."
  );
}

export async function extractStructuredPreferences(
  ctx: PreferenceExtractionContext,
): Promise<Preference[]> {
  const input: PreferenceExtractionInput = {
    userMessage: ctx.userMessage,
    currentStage: ctx.currentStage,
    state: ctx.state,
    compactUi: ctx.compactUi,
    recentDialogue: ctx.recentDialogue,
    existingPreferences: ctx.existingPreferences.map((preference) => ({
      id: preference.id,
      description: preference.description,
      strength: preference.strength,
      relevantStages: preference.relevantStages,
    })),
  };

  const schema = {
    type: "object",
    properties: {
      hasUpdate: { type: "boolean" },
      preferences: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                'Echo the id from existingPreferences when keeping or amending that entry. Use "" for a brand-new preference.',
            },
            description: { type: "string" },
            strength: { type: "string", enum: ["hard", "soft"] },
            relevantStages: {
              type: "array",
              items: { type: "string", enum: CONFLICT_STAGES },
            },
          },
          required: ["id", "description", "strength", "relevantStages"],
          additionalProperties: false,
        },
      },
      retractedIds: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["hasUpdate", "preferences", "retractedIds"],
    additionalProperties: false,
  };

  const systemPrompt = buildPreferenceSystemPrompt(ctx.stageMeta, ctx.language, ctx.demoSession);

  const parsed = await callStructuredExtractor(
    "preferences",
    systemPrompt,
    input,
    schema,
  );
  if (!parsed) {
    throw new Error("PREFERENCE_EXTRACTION_INVALID_OUTPUT");
  }

  const output = toPreferenceExtractionOutput(parsed);
  if (!output) {
    throw new Error("PREFERENCE_EXTRACTION_INVALID_OUTPUT");
  }

  if (!output.hasUpdate) {
    return ctx.existingPreferences;
  }

  return materializePreferences(output, ctx.existingPreferences);
}
