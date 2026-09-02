/**
 * Shared machinery for the planner regression harnesses.
 *
 * Named *.regress.ts so the agent's tsconfig excludes it from the build along
 * with the harnesses themselves: it imports the frontend's tool definitions,
 * which sit outside this project's rootDir.
 *
 * A study trace records the exact planner input for every turn, so a case is
 * "this situation, through today's prompt". Two things are deliberately NOT
 * replayed from the log:
 *
 *   - the tool schema, which is looked up from the CURRENT definitions by the
 *     names the turn was offered, because tool descriptions are part of what
 *     these harnesses regress;
 *   - currentView.hiddenByFilterCount, which did not exist when the study ran
 *     and is recomputed here exactly as buildCurrentView now computes it, so a
 *     replay sees what today's agent would actually send.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { isSelectableItem } from '../core/filterSimulation';
import type { PlannerWorkflow, PlannerWorkflowMemory } from './llmPlanner';
import { modificationTools, interactionTools } from '../../../frontend/src/agent/tools';
import type { ToolDefinition } from '../../../frontend/src/agent/tools';
import type { ToolSchemaItem } from '../types';

export const TRACE_DIR = path.resolve(process.cwd(), 'logs/trace');

const CURRENT_TOOLS = new Map<string, ToolDefinition>(
  [...modificationTools, ...interactionTools].map((tool) => [tool.name, tool])
);

export interface ReplayTurn {
  history: unknown[];
  memory?: PlannerWorkflowMemory;
  workflow: PlannerWorkflow;
  availableToolNames: string[];
  stageMeta: Array<{ stage: string; goal: string; fieldGuide: string }>;
  visibleIds: string[];
  itemCount: number;
  hiddenByFilterCount: number;
  stage: string;
  /** What the study run actually did on this turn, for the console header. */
  loggedTool: string | null;
  loggedHighlight: string[] | null;
  loggedMessage: string | null;
}

/** Rebuilds stageMeta from the system prompt the turn was served. */
function parseStageMeta(
  systemPrompt: string
): Array<{ stage: string; goal: string; fieldGuide: string }> {
  const start = systemPrompt.indexOf('Stage goals:\n');
  if (start < 0) return [];
  const meta: Array<{ stage: string; goal: string; fieldGuide: string }> = [];
  for (const line of systemPrompt.slice(start + 'Stage goals:\n'.length).split('\n')) {
    const match = /^ {2}(\w+): (.+)$/.exec(line);
    if (!match) break;
    meta.push({ stage: match[1], goal: match[2], fieldGuide: '' });
  }
  return meta;
}

/** Mirrors hasActiveFilter in core/planner.ts. */
function hasActiveFilter(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => entry !== null && typeof entry === 'object');
  return value !== null && typeof value === 'object';
}

/** Streams one trace file and returns the planner input for a request id. */
export async function loadTurn(trace: string, requestId: string): Promise<ReplayTurn | null> {
  const filePath = path.join(TRACE_DIR, trace);
  if (!fs.existsSync(filePath)) return null;
  const stream = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let turn: ReplayTurn | null = null;
  try {
    for await (const line of stream) {
      if (!line.includes(requestId)) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload || payload.requestId !== requestId) continue;

      if (event.type === 'llm.planner.request' && !turn) {
        const body = payload.body as
          | { input?: Array<{ content?: unknown }>; tools?: unknown[] }
          | undefined;
        const messages = body?.input ?? [];
        const systemPrompt = typeof messages[0]?.content === 'string' ? messages[0].content : '';
        const userContent = messages[messages.length - 1]?.content;
        if (typeof userContent !== 'string') continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(userContent) as Record<string, unknown>;
        } catch {
          continue;
        }
        const workflow = parsed.workflow as PlannerWorkflow | undefined;
        if (!workflow) continue;
        const view = (workflow.currentView ?? {}) as Record<string, unknown>;
        const visible = Array.isArray(view.visibleItems) ? view.visibleItems : [];
        const items = Array.isArray(view.items) ? (view.items as Record<string, unknown>[]) : [];
        // Same arithmetic buildCurrentView now ships: the selectable inventory
        // less what the filter left on screen.
        const hidden = hasActiveFilter((view.modification as Record<string, unknown>)?.filter)
          ? Math.max(
              0,
              items.filter((item) => isSelectableItem(item)).length - visible.length
            )
          : 0;
        // REPLAY_NO_HIDDEN_FIELD=1 reproduces the payload as the study logged
        // it, so a case can be measured with and without the new field.
        if (hidden > 0 && process.env.REPLAY_NO_HIDDEN_FIELD !== '1') {
          view.hiddenByFilterCount = hidden;
        }
        turn = {
          history: Array.isArray(parsed.history) ? parsed.history : [],
          memory: parsed.memory as PlannerWorkflowMemory | undefined,
          workflow,
          availableToolNames: (body?.tools ?? [])
            .map((tool) => (tool as { name?: string }).name)
            .filter((name): name is string => Boolean(name) && name !== 'respond'),
          stageMeta: parseStageMeta(systemPrompt),
          visibleIds: visible.map((item) => String((item as { id?: unknown }).id)),
          itemCount: items.length,
          hiddenByFilterCount: hidden,
          stage: String(view.stage ?? workflow.currentStage ?? ''),
          loggedTool: null,
          loggedHighlight: null,
          loggedMessage: null,
        };
      }

      if (event.type === 'llm.planner.response.parsed' && turn) {
        const parsed = (payload.parsed ?? {}) as Record<string, unknown>;
        const action = (parsed.action ?? {}) as Record<string, unknown>;
        turn.loggedTool =
          typeof action.toolName === 'string' && action.toolName ? action.toolName : 'respond';
        turn.loggedMessage =
          typeof parsed.assistantMessage === 'string' ? parsed.assistantMessage : null;
        if (action.toolName === 'highlight') {
          const ids = (action.params as { itemIds?: unknown })?.itemIds;
          turn.loggedHighlight = Array.isArray(ids) ? ids.map(String) : [];
        }
      }
    }
  } finally {
    stream.close();
  }
  return turn;
}

export function toolsFor(names: string[]): ToolSchemaItem[] {
  const tools: ToolSchemaItem[] = [];
  for (const name of names) {
    const definition = CURRENT_TOOLS.get(name);
    if (definition) tools.push(definition as unknown as ToolSchemaItem);
  }
  return tools;
}

export function requireApiKey(harness: string): void {
  if (process.env.OPENAI_API_KEY?.trim() || process.env.AGENT_OPENAI_API_KEY?.trim()) return;
  console.error(
    `No OpenAI key in the environment. This harness makes real API calls:\n` +
      `  OPENAI_API_KEY=... npx tsx apps/tuning-agent/src/llm/${harness}`
  );
  process.exit(2);
}

/** `--runs N`, shared by both harnesses. */
export function readRuns(): number {
  const i = process.argv.indexOf('--runs');
  const parsed = i >= 0 ? Number.parseInt(process.argv[i + 1] ?? '', 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** `--only <substring>` narrows a run to cases whose name contains it. */
export function readOnly(): string {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? (process.argv[i + 1] ?? '').toLowerCase() : '';
}
