/**
 * What does the planner do with the empty-respond note? Real API calls.
 *
 *   set -a; . ./.env; set +a
 *   npx tsx apps/tuning-agent/src/llm/emptyRespond.regress.ts --runs 5 <trace.jsonl> <planner-request-id>
 *
 * The live failure is rare (1 empty respond in 345 responds over the 50 booth
 * traces of 2026-10-24), so a handful of full-card runs will not show the
 * guard firing. This replays the request that did fail, C1v planner-8
 * ("첫 번째 걸로 할게요." answered with respond + ""), twice over:
 *
 *   plain — the logged input as it was, on today's prompt: how often the
 *           first answer is still empty (what the guard has to catch);
 *   note  — the same input with the runtime note appended to history, exactly
 *           as `withEmptyRespondNote` + `buildPlannerHistory` deliver it: the
 *           re-plan. It passes if it is not an empty respond.
 *
 * `--raw` sends the LOGGED request body instead (system prompt, tools, model
 * and all, byte for byte), so it replays the prompt that actually failed
 * rather than today's; `note` then differs from it only by the history entry.
 *
 * `emptyRespond.check.ts` is the offline half: it drives the re-plan and the
 * fallback with a stub planner.
 */
import fs from 'node:fs';

import { buildEmptyRespondNote } from '../core/emptyRespond';
import { resolveOpenAiApiKey } from './openaiKey';
import { planActionWithOpenAI } from './llmPlanner';
import type { PlannerWorkflow, PlannerWorkflowMemory } from './llmPlanner';
import { readRuns, requireApiKey, toolsFor } from './plannerReplay.regress';

type Json = Record<string, unknown>;

const RUNS = readRuns();
const RAW = process.argv.includes('--raw');
const [traceFile, requestId] = process.argv.slice(2).filter((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg));

function stageMetaFromPlannerPrompt(systemPrompt: string): Array<{ stage: string; goal: string; fieldGuide: string }> {
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

function loadRequest(file: string, id: string) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes(id) || !line.includes('llm.planner.request')) continue;
    const event = JSON.parse(line) as Json;
    const payload = event.payload as Json;
    if (event.type !== 'llm.planner.request' || payload.requestId !== id) continue;
    const body = payload.body as { input: Array<{ content: unknown }>; tools?: Array<{ name?: string }> };
    const systemPrompt = String(body.input[0]?.content ?? '');
    const input = JSON.parse(String(body.input[body.input.length - 1]?.content ?? '{}')) as Json;
    return {
      body: body as unknown as Json,
      systemPrompt,
      input,
      toolNames: (body.tools ?? []).map((tool) => String(tool.name ?? '')).filter((name) => name && name !== 'respond'),
    };
  }
  return null;
}

/** The logged body with only the user message replaced; parsed like the planner's native tool call. */
async function rawReplay(
  body: Json,
  input: Json
): Promise<{ action: { type: string; toolName: string; params: Json }; assistantMessage: string } | null> {
  const messages = clone(body.input) as Array<Json>;
  messages[messages.length - 1] = { ...messages[messages.length - 1], content: JSON.stringify(input) };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolveOpenAiApiKey()}` },
    body: JSON.stringify({ ...body, input: messages }),
  });
  if (!response.ok) {
    console.error(`  HTTP ${response.status}`);
    return null;
  }
  const json = (await response.json()) as { output?: Array<Json> };
  const call = (json.output ?? []).find((item) => item.type === 'function_call');
  if (!call) return null;
  const args = JSON.parse(String(call.arguments ?? '{}')) as Json;
  const toolName = String(call.name ?? '');
  const { reason: _reason, assistantMessage, conflictMemory: _conflict, preferenceIds: _ids, ...params } = args;
  return {
    action: toolName === 'respond' ? { type: 'none', toolName: '', params: {} } : { type: 'tool.call', toolName, params },
    assistantMessage: typeof assistantMessage === 'string' ? assistantMessage : '',
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function main(): Promise<void> {
  requireApiKey('emptyRespond.regress.ts');
  if (!traceFile || !requestId) {
    console.error('usage: emptyRespond.regress.ts [--runs N] <trace.jsonl> <planner-request-id>');
    process.exit(2);
  }
  const request = loadRequest(traceFile, requestId);
  if (!request) {
    console.error(`no ${requestId} in ${traceFile}`);
    process.exit(2);
  }
  const workflow = request.input.workflow as PlannerWorkflow;
  const history = request.input.history as unknown[];
  const language = /한국어|Korean/.test(request.systemPrompt) ? 'ko' : undefined;
  const base = {
    workflow,
    availableTools: toolsFor(request.toolNames),
    stageMeta: stageMetaFromPlannerPrompt(request.systemPrompt),
    ...(request.input.memory ? { memory: request.input.memory as PlannerWorkflowMemory } : {}),
    ...(language ? { language } : {}),
    spokenBrevity: request.systemPrompt.includes('Writing for the ear (voice session)'),
    demoSession: true,
    decisiveSelection: true,
    requirementConflicts: true,
  };
  const last = history[history.length - 1] as Json | undefined;
  console.log(`${requestId}: stage ${workflow.currentStage}, last history entry ${JSON.stringify(last)}`);
  console.log(`tools ${request.toolNames.join(', ')}; language ${language ?? 'en'}; spokenBrevity ${base.spokenBrevity}`);

  const tally: Record<string, { empty: number; runs: number; outcomes: string[] }> = {
    plain: { empty: 0, runs: 0, outcomes: [] },
    note: { empty: 0, runs: 0, outcomes: [] },
  };
  for (let run = 0; run < RUNS; run += 1) {
    for (const side of ['plain', 'note'] as const) {
      const sideHistory = side === 'note' ? [...history, buildEmptyRespondNote(workflow.currentStage)] : history;
      const output = RAW
        ? await rawReplay(request.body, { ...request.input, history: sideHistory })
        : await planActionWithOpenAI({ ...base, history: sideHistory });
      const entry = tally[side];
      entry.runs += 1;
      if (!output) {
        entry.outcomes.push('(no output)');
        continue;
      }
      const tool = output.action.type === 'none' ? 'respond' : output.action.toolName;
      const message = output.assistantMessage.trim();
      if (tool === 'respond' && !message) entry.empty += 1;
      entry.outcomes.push(`${tool}${tool === 'select' ? ` ${String(output.action.params.itemId)}` : ''}${message ? ` "${message}"` : ' ""'}`);
    }
  }
  for (const [side, entry] of Object.entries(tally)) {
    console.log(`\n${side}: empty respond ${entry.empty}/${entry.runs}`);
    for (const outcome of entry.outcomes) console.log(`  ${outcome}`);
  }
}

void main();
