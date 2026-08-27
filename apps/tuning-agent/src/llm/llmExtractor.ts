import { refreshModelEnvVars } from "../core/envRefresh";
import { buildPreferenceId, normalizePreferenceList } from "../core/cpMemory";
import { resolveOpenAiApiKey } from "./openaiKey";
import { fetchOpenAiWithRetry } from "./resilientFetch";
import { CONFLICT_STAGES } from "../types";
import type { ConflictStage, Preference } from "../types";

interface PreferenceExtractionInput {
  userMessage: string;
  currentStage: string;
  state: Record<string, unknown> | null;
  compactUi: unknown;
  recentDialogue: Array<{ type: "user" | "agent"; text: string }>;
  existingPreferences: Array<{
    description: string;
    strength: "hard" | "soft";
    relevantStages: ConflictStage[];
  }>;
}

interface PreferenceExtractionOutput {
  hasUpdate: boolean;
  preferences: Array<{
    description: string;
    strength: "hard" | "soft";
    relevantStages: ConflictStage[];
  }>;
  /**
   * Descriptions the user has explicitly withdrawn. Optional: absent means
   * "nothing was withdrawn", which is why an omitted hard preference is now
   * retained rather than silently dropped.
   */
  retractedDescriptions?: string[];
}

interface LlmTraceEvent {
  component: "extractor";
  type: "request" | "response.raw" | "response.parsed" | "error";
  payload: unknown;
}

type LlmTraceListener = (event: LlmTraceEvent) => void;
type ExtractionKind = "preferences";

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
  "Output: { hasUpdate, preferences, retractedDescriptions }.\n" +
  "- preferences: the full current preference list as you understand it.\n" +
  "- retractedDescriptions: descriptions the user has explicitly withdrawn or replaced. Copy the description verbatim from existingPreferences.\n" +
  "- A hard preference you omit from preferences is KEPT. To remove one, you must list it in retractedDescriptions. Soft preferences you omit are dropped.\n" +
  "\n" +
  "Procedural vs durable — read the full recentDialogue first:\n" +
  "- Procedural: the agent narrowed to a small set and asked the user to pick one. The user just picks one to proceed. → set hasUpdate=false, preferences=[].\n" +
  "- Durable: the user freely states what they want — a name, a constraint, a desire. This is a preference even if it matches a visible item. Store it.\n" +
  "- When in doubt, set hasUpdate=false, preferences=[].\n" +
  "\n" +
  "Strength:\n" +
  '- "hard": user accepts ONLY matching options (cues: must, only, need, should, no later than).\n' +
  '- "hard": user names a specific visible item exactly (e.g. userMessage matches a visibleItems value). Picking a concrete item by name is a direct selection, not a vague preference.\n' +
  '- "hard": user restates an existing soft preference without any hedging words (prefer, ideally, if possible, would like, want) — treat the restatement as an upgrade to hard.\n' +
  '- "soft": user prefers but accepts alternatives (cues: prefer, ideally, if possible, like, want).\n' +
  "- If one clause combines a hard acceptance constraint with a soft tie-breaker, extract them as separate preferences.\n" +
  '- Ambiguous defaults to "soft".\n' +
  "\n" +
  "Updating existingPreferences:\n" +
  "- Changed (strength, scope, or wording): update the entry in place. Do not duplicate.\n" +
  "- Withdrawn: omit it. Unchanged: preserve wording and relevantStages exactly.\n" +
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
 * This used to be a full replace: whatever list the model returned became the
 * memory, so a preference the model simply did not restate was treated as
 * withdrawn. In the study corpus 59 of 550 updates silently lost a preference
 * that way, in the worst case dropping two hard constraints at once, and the
 * participant had no way to tell why the conditions they had stated were being
 * ignored.
 *
 * Now:
 *   - a returned preference replaces the one with the same id (as before);
 *   - an omitted HARD preference is retained — withdrawing a hard constraint
 *     requires the model to name it in `retractedDescriptions`;
 *   - an omitted SOFT preference is still dropped, since soft preferences are
 *     revisable by design and re-stating the list is how they get revised.
 */
function materializePreferences(
  raw: PreferenceExtractionOutput,
  existingPreferences: Preference[],
): Preference[] {
  const existingById = new Map(
    existingPreferences.map((item) => [item.id, item]),
  );
  const retractedIds = new Set(
    (raw.retractedDescriptions ?? [])
      .map((description) => normalizeDescription(description))
      .filter((description): description is string => Boolean(description))
      .map((description) => buildPreferenceId(description)),
  );

  const preferences: Preference[] = [];
  const returnedIds = new Set<string>();
  for (const rawPreference of raw.preferences) {
    const description = normalizeDescription(rawPreference.description);
    if (!description) continue;
    const strength = normalizePreferenceStrength(rawPreference.strength);
    const id = buildPreferenceId(description);
    if (retractedIds.has(id)) continue;
    returnedIds.add(id);
    const existing = existingById.get(id);
    preferences.push({
      id,
      description,
      strength,
      relevantStages: normalizeRelevantStages(
        rawPreference.relevantStages,
        existing?.relevantStages,
      ),
    });
  }

  // Carry forward hard constraints the model neither restated nor retracted.
  const carriedForward = existingPreferences.filter(
    (item) =>
      item.strength === "hard" &&
      !returnedIds.has(item.id) &&
      !retractedIds.has(item.id),
  );

  return normalizePreferenceList([...preferences, ...carriedForward]);
}

function toPreferenceExtractionOutput(
  value: Record<string, unknown>,
): PreferenceExtractionOutput | null {
  const hasUpdate = value.hasUpdate === true;

  const retractedDescriptions = Array.isArray(value.retractedDescriptions)
    ? value.retractedDescriptions
        .map((entry) => normalizeDescription(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];

  const rawPreferences = Array.isArray(value.preferences)
    ? value.preferences
    : null;
  if (!rawPreferences) return { hasUpdate, preferences: [], retractedDescriptions };

  const preferences: PreferenceExtractionOutput["preferences"] = [];
  for (const entry of rawPreferences) {
    if (!isRecord(entry)) continue;
    const description = normalizeDescription(entry.description);
    if (!description) continue;
    preferences.push({
      description,
      strength: normalizePreferenceStrength(entry.strength),
      relevantStages: normalizeRelevantStages(entry.relevantStages),
    });
  }

  return { hasUpdate, preferences, retractedDescriptions };
}
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_CHAT_COMPLETIONS_API_URL =
  "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_TEMPERATURE = 0;
type OpenAiApiMode = "responses" | "chat";

function getOpenAIApiMode(): OpenAiApiMode {
  return process.env.AGENT_OPENAI_API_MODE === "chat" ? "chat" : "responses";
}

function resolveOpenAIReasoning(
  kind: ExtractionKind,
): { effort: "low" | "medium"; summary?: "auto" } | undefined {
  void kind;
  return undefined;
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

function getOpenAIModel(): string {
  return process.env.AGENT_OPENAI_MODEL || "gpt-5.4";
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

  const model = getOpenAIModel();
  const temperature = resolveOpenAITemperature();
  const reasoning = resolveOpenAIReasoning(kind);
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
            description: { type: "string" },
            strength: { type: "string", enum: ["hard", "soft"] },
            relevantStages: {
              type: "array",
              items: { type: "string", enum: CONFLICT_STAGES },
            },
          },
          required: ["description", "strength", "relevantStages"],
          additionalProperties: false,
        },
      },
      retractedDescriptions: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["hasUpdate", "preferences", "retractedDescriptions"],
    additionalProperties: false,
  };

  const systemPrompt = ctx.stageMeta
    ? PREFERENCE_SYSTEM_PROMPT +
      "\n\nstageFieldGuides:\n" +
      ctx.stageMeta.map((s) => `- ${s.stage}: ${s.fieldGuide}`).join("\n")
    : PREFERENCE_SYSTEM_PROMPT;

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
