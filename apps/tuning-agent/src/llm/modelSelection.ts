/**
 * Which OpenAI model this agent process calls, and the request parameters that
 * model will accept.
 *
 * Three layers, highest first:
 *   1. a per-session override the host sent as a `planner.model` envelope (the
 *      visitor picked it in the settings sheet),
 *   2. AGENT_OPENAI_MODEL from the environment,
 *   3. the compiled-in default.
 *
 * The override has to live here rather than in process.env: envRefresh.ts
 * re-reads AGENT_OPENAI_MODEL from .env before every planner call, so an
 * override written into process.env would be undone on the next turn in any
 * deployment that has a .env file beside the checkout.
 *
 * One agent process serves one session, so "this process" and "this session"
 * are the same thing here.
 */
import {
  DEFAULT_PLANNER_MODEL,
  findPlannerModelOption,
  isPlannerModelId,
} from './plannerModels';

let sessionModelOverride: string | null = null;

export interface SetSessionPlannerModelResult {
  /** False when the id was not on the allow-list; the override is then unchanged. */
  accepted: boolean;
  /** The model the next request will use. */
  model: string;
}

/**
 * `null` or an empty string clears the override and returns to the env/default
 * model. Anything not on the allow-list is refused and leaves the current
 * choice in place -- a refused change must not silently become "default".
 */
export function setSessionPlannerModel(requested: string | null): SetSessionPlannerModelResult {
  const trimmed = requested?.trim() ?? '';
  if (!trimmed) {
    sessionModelOverride = null;
    return { accepted: true, model: resolveOpenAIModel() };
  }
  if (!isPlannerModelId(trimmed)) {
    return { accepted: false, model: resolveOpenAIModel() };
  }
  sessionModelOverride = trimmed;
  return { accepted: true, model: trimmed };
}

export function getSessionPlannerModelOverride(): string | null {
  return sessionModelOverride;
}

export function resolveOpenAIModel(): string {
  return sessionModelOverride ?? (process.env.AGENT_OPENAI_MODEL || DEFAULT_PLANNER_MODEL);
}

/**
 * The planner and extractor ask for `none` by default -- measured as the best
 * setting for tool choice and latency on GPT-5.6. GPT-6 Astra and GPT-6.1 Sol do
 * not offer it; OpenAI's migration guide says to use `low` there. A model not
 * on the allow-list (set through the environment) is assumed to accept what it
 * is given, as before.
 */
export function resolveReasoningEffortFor<T extends string>(
  model: string,
  requested: T,
): T | 'low' {
  if (requested !== 'none') return requested;
  const option = findPlannerModelOption(model);
  if (option && !option.supportsNoneReasoning) return 'low';
  return requested;
}

/**
 * `temperature` is only legal while reasoning is off. When the effort had to be
 * raised above `none` for the model, the parameter is dropped up front instead
 * of relying on the retry-without-temperature guard, which would cost a round
 * trip on every call.
 */
export function resolveTemperatureFor(
  reasoningEffort: string | undefined,
  temperature: number | undefined,
): number | undefined {
  if (reasoningEffort && reasoningEffort !== 'none') return undefined;
  return temperature;
}
