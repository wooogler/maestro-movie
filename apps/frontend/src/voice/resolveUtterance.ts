import { classifyUtterance, type UtteranceClassification } from './classifyUtterance';
import { resolveCategoryFromTool } from './verbosity';

export interface ResolvedUtterance extends UtteranceClassification {
  /** Whether the category came from the agent's own tag or from the text. */
  source: 'agent' | 'heuristic';
}

/**
 * Prefer the agent's tag when it sends one, otherwise read the category out of
 * the text.
 *
 * The study build does not tag anything, so `source` is `'heuristic'` in
 * practice. The hook is here because tagging is a one-field, decision-neutral
 * addition on the agent side (`buildAgentMessageAction` already has the planned
 * tool name in scope) and the frontend should not need a second change if that
 * ever happens. An unrecognised tag falls through to the classifier rather than
 * failing — an agent from a different branch must not break voice output.
 */
export function resolveUtterance(agentCategory: string | null, text: string): ResolvedUtterance {
  const classification = classifyUtterance(text);
  const tagged = resolveCategoryFromTool(agentCategory);
  if (tagged) {
    return { ...classification, category: tagged, source: 'agent' };
  }
  return { ...classification, source: 'heuristic' };
}
