/**
 * The planner models a visitor may pick from the settings sheet.
 *
 * This file is deliberately free of Node imports: the frontend keeps a
 * byte-for-byte copy at apps/frontend/src/agent/plannerModels.ts (it cannot
 * import across apps at build time), and
 * apps/frontend/src/agent/plannerModels.check.ts fails `npm run check` the
 * moment the two drift. Edit both, in the same change.
 *
 * The list is an allow-list, not a suggestion: the agent refuses any id that
 * is not here (see modelSelection.ts), so a visitor at a public booth cannot
 * type an arbitrary model string onto the operator's key.
 *
 * Model facts below come from the OpenAI model docs as of 2026-10-17
 * (developers.openai.com/api/docs/guides/latest-model). The one that matters
 * to the request body is `supportsNoneReasoning`: GPT-6.1 Sol (and GPT-6
 * Astra) reject `reasoning.effort: "none"`, and once reasoning is active the
 * API also rejects `temperature`. modelSelection.ts adjusts both.
 *
 * GPT-6 Astra is deliberately NOT offered. Measured on 2026-10-17 with
 * scripts/planner-latency.ts it was the dearest option, ran at `low` effort
 * (~3s a turn against Terra's ~1.6s), and two of five requests never returned
 * -- a hung planner call is a frozen booth. Add it back only with a timeout
 * around the planner fetch.
 */

export interface PlannerModelOption {
  id: string;
  label: string;
  /** One line for the settings sheet. English only: model names are not localised. */
  description: string;
  /**
   * Whether the model accepts `reasoning.effort: "none"`, which is what the
   * planner sends by default. False means the lowest legal rung is `low`.
   */
  supportsNoneReasoning: boolean;
}

export const PLANNER_MODEL_OPTIONS: readonly PlannerModelOption[] = [
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'Default. Matched the study model’s tool choice in replay at ~20% lower cost.',
    supportsNoneReasoning: true,
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'The model the published user study ran on.',
    supportsNoneReasoning: true,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'GPT-5.6 flagship. Scored the same as Terra in replay, at twice the cost.',
    supportsNoneReasoning: true,
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    description: 'Fastest and cheapest GPT-6, built for focused high-volume tasks.',
    supportsNoneReasoning: true,
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    description: 'GPT-6 for complex coding and agentic workflows.',
    supportsNoneReasoning: true,
  },
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    description: 'Near-Astra quality at lower cost. Always reasons (no "none" effort), so each turn is slower.',
    supportsNoneReasoning: false,
  },
];

export const DEFAULT_PLANNER_MODEL = 'gpt-5.6-terra';

export type PlannerModelId = (typeof PLANNER_MODEL_OPTIONS)[number]['id'];

export function findPlannerModelOption(id: string): PlannerModelOption | undefined {
  return PLANNER_MODEL_OPTIONS.find((option) => option.id === id);
}

export function isPlannerModelId(value: unknown): value is string {
  return typeof value === 'string' && findPlannerModelOption(value) !== undefined;
}
