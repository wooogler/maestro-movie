/**
 * Card B, replayed: does the booth agent say that IMAX and "15 miles at most"
 * cannot both be met, instead of booking a cinema with no IMAX and then
 * offering to change a day the visitor named?
 *
 *   OPENAI_API_KEY=... npx tsx apps/tuning-agent/src/llm/cardB.regress.ts \
 *       --trace-dir /home/sangwonlee/tuning-movie/logs/demo/trace
 *   ... --runs 3        replays per case and side (default 3)
 *   ... --only limit    cases whose name contains the substring
 *   ... --verbose       print every replayed chain
 *
 * The B runs of the 2026-10-24 Korean simulation (docs/scenarios/
 * ksea2026-korean-simulation.md: B2t, B3v, B4v) are the input. Every case
 * starts from a request one of those sessions actually logged and replays it
 * twice: BEFORE is the prompt and memory the session had; AFTER is the same
 * request with this branch's booth changes — the extractor's booth field
 * guides (`demoSession`), and the planner's REQUIREMENT_CONFLICT_RULES
 * (`requirementConflicts`) with the uncheckedHardPreferenceIds annotation on
 * priorStageAlternativeCounts.
 *
 *   extract-opener   the opener ("…스트리트 파이터를 IMAX로 보려고요"): is the
 *                    IMAX requirement relevant to the theater stage?
 *   extract-limit    "15마일 넘게는 운전 안 할 거예요": does IMAX keep theater
 *                    (AFTER starts from AFTER's opener scope), and is the
 *                    distance limit on theater?
 *   extract-relax    the visitor answers the conflict question — "첫 번째 걸로
 *                    할게요" (the first way out: no IMAX) and "트로이까지 갈게요"
 *                    — is exactly the right requirement retracted?
 *   theater-entry    the planner's first step at the theater stage, before the
 *                    limit is known: what state is the screen in when the
 *                    second line arrives? (informational)
 *   theater-limit    the planner after the limit: SUCCESS = no select / next /
 *                    prev, and the last sentence names IMAX and Troy or its
 *                    distance and asks; FAIL = picks a cinema, or offers
 *                    another day or film.
 *   theater-relaxed  after AFTER's conflict question, the visitor gives one up:
 *                    the booking must carry on (select or ask among the rest),
 *                    not raise the conflict again.
 *   time-deadend     the time stage at a cinema with no IMAX — the fallback,
 *                    with the memory the session had (IMAX scoped to time
 *                    only): SUCCESS = no prev, no other day offered, and the
 *                    sentence names IMAX and the distance limit.
 *
 * The chain simulation follows decisiveSelection.regress.ts: augment, filter,
 * sort, highlight and clearModification are applied to the logged currentView
 * the way the host would, the step goes into history as the agent's own
 * annotation, and the tool list narrows as getPlannerToolSchema narrows it.
 *
 * Real API calls, so this stays out of `npm run check` like the other
 * `*.regress.ts` harnesses; `plannerPrompt.check.ts` is the offline half.
 */
import fs from 'node:fs';
import path from 'node:path';

import { applyFilterExpressions, isSelectableItem } from '../core/filterSimulation';
import type { FilterExpression, Preference } from '../types';
import { extractStructuredPreferences } from './llmExtractor';
import type { PreferenceExtractionContext } from './llmExtractor';
import { SUPPORTED_CONVERSATION_LANGUAGES, buildLanguageSection, planActionWithOpenAI } from './llmPlanner';
import type { PlannerOutput, PlannerWorkflow, PlannerWorkflowMemory } from './llmPlanner';
import { requireApiKey, toolsFor } from './plannerReplay.regress';

type Json = Record<string, unknown>;

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const TRACE_DIR = readArg('--trace-dir') ?? path.resolve(process.cwd(), 'logs/demo/trace');
const RUNS = Number.parseInt(readArg('--runs') ?? '', 10) || 3;
const ONLY = (readArg('--only') ?? '').toLowerCase();
const VERBOSE = process.argv.includes('--verbose');
/** The three card-B sessions of 2026-10-24 (B1v never started). */
const SESSIONS: Array<[string, string]> = [
  ['B2t', '6ef202cdea644d518b1d29edbb46292c'],
  ['B3v', '5a33d8a986ce4628813f40487b1642c8'],
  ['B4v', 'bd2644e381784ed585fd60379781bf09'],
];
const MAX_CHAIN = 6;
/**
 * `--extra-trace <file>` (repeatable): live runs made with the fix. Their
 * extractor requests that answer the conflict question become the
 * `extract-relax-live` case — the real screen and wording, which the synthetic
 * extract-relax case does not have (on 2026-10-24 the screen showed only Troy,
 * and "첫 번째" was read as Troy once).
 */
const EXTRA_TRACES = process.argv.flatMap((arg, i) => (arg === '--extra-trace' ? [process.argv[i + 1] ?? ''] : [])).filter(Boolean);
/** What the AFTER side's agent asks once the conflict shows, for the follow-up cases. */
const CONFLICT_QUESTION =
  'IMAX는 20.4마일 떨어진 MJR Troy에만 있어요. IMAX 없이 가까운 곳에서 일반이나 3D로 보실래요, 아니면 Troy까지 가실래요?';

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Trace parsing ───────────────────────────────────────────────────────────

interface PlannerRequest {
  requestId: string;
  systemPrompt: string;
  toolNames: string[];
  history: unknown[];
  memory?: PlannerWorkflowMemory;
  workflow: PlannerWorkflow;
  openedByUser: string | null;
  /** The logged response: tool name (respond for none) and preferenceIds it bound. */
  tool?: string;
  preferenceIds?: string[];
}

interface ExtractorRequest {
  requestId: string;
  systemPrompt: string;
  input: Json;
}

interface Session {
  name: string;
  planner: PlannerRequest[];
  extractor: ExtractorRequest[];
}

function loadSession(name: string, id: string): Session | null {
  const file = fs.existsSync(TRACE_DIR)
    ? fs.readdirSync(TRACE_DIR).find((entry) => entry.includes(id) && entry.endsWith('.llm-trace.jsonl'))
    : undefined;
  if (!file) return null;
  const planner = new Map<string, PlannerRequest>();
  const extractor: ExtractorRequest[] = [];
  for (const line of fs.readFileSync(path.join(TRACE_DIR, file), 'utf8').split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line) as Json;
    const payload = (event.payload ?? {}) as Json;
    const requestId = String(payload.requestId ?? '');
    const body = (payload.body ?? {}) as { input?: Array<{ content?: unknown }>; tools?: Array<{ name?: string }> };
    if (event.type === 'llm.planner.request') {
      const messages = body.input ?? [];
      const parsed = JSON.parse(String(messages[messages.length - 1]?.content ?? '{}')) as Json;
      const history = Array.isArray(parsed.history) ? parsed.history : [];
      const last = history[history.length - 1];
      planner.set(requestId, {
        requestId,
        systemPrompt: String(messages[0]?.content ?? ''),
        toolNames: (body.tools ?? []).map((tool) => String(tool.name ?? '')).filter(Boolean),
        history,
        memory: parsed.memory as PlannerWorkflowMemory | undefined,
        workflow: parsed.workflow as PlannerWorkflow,
        openedByUser: isRecord(last) && last.type === 'user' ? String(last.label ?? last.text ?? '') : null,
      });
    } else if (event.type === 'llm.planner.response.parsed') {
      const step = planner.get(requestId);
      const action = ((payload.parsed ?? {}) as Json).action as Json | undefined;
      if (step && action) {
        step.tool = action.type === 'none' ? 'respond' : String(action.toolName ?? '');
        step.preferenceIds = Array.isArray(action.preferenceIds) ? action.preferenceIds.map(String) : [];
      }
    } else if (event.type === 'llm.extractor.request') {
      const messages = body.input ?? [];
      extractor.push({
        requestId,
        systemPrompt: String(messages[0]?.content ?? ''),
        input: JSON.parse(String(messages[messages.length - 1]?.content ?? '{}')) as Json,
      });
    }
  }
  return { name, planner: [...planner.values()].filter((step) => step.tool), extractor };
}

function stageMetaFromExtractorPrompt(systemPrompt: string): Array<{ stage: string; goal: string; fieldGuide: string }> {
  const start = systemPrompt.indexOf('stageFieldGuides:\n');
  if (start < 0) return [];
  const meta: Array<{ stage: string; goal: string; fieldGuide: string }> = [];
  for (const line of systemPrompt.slice(start + 'stageFieldGuides:\n'.length).split('\n')) {
    const match = /^- (movie|theater|date|time|seat|confirm): (.+)$/.exec(line);
    if (!match) break;
    meta.push({ stage: match[1], goal: '', fieldGuide: match[2] });
  }
  return meta;
}

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

// ── Memory patches: what AFTER's extractor produces ─────────────────────────

const IMAX = /imax/i;
const DISTANCE = /mile|마일|drive|운전|distance/i;

function withImaxAtTheater<T extends { description: string; relevantStages: string[] }>(preferences: T[]): T[] {
  return preferences.map((preference) =>
    IMAX.test(preference.description) && !preference.relevantStages.includes('theater')
      ? { ...preference, relevantStages: ['theater', ...preference.relevantStages] }
      : preference
  );
}

/**
 * The annotation core/planner.ts adds in a booth session: the hard preferences
 * relevant to each earlier stage that no hard filter there was bound to. The
 * bound ones are read from the session's own filter calls.
 */
function annotateCounts(workflow: PlannerWorkflow, memory: PlannerWorkflowMemory | undefined, session: Session): void {
  if (!workflow.priorStageAlternativeCounts || !memory) return;
  const bound = new Map<string, Set<string>>();
  for (const step of session.planner) {
    if (step.tool !== 'filter') continue;
    const stage = workflow.currentStage === step.workflow.currentStage ? null : step.workflow.currentStage;
    if (!stage) continue;
    const set = bound.get(stage) ?? new Set<string>();
    for (const id of step.preferenceIds ?? []) set.add(id);
    bound.set(stage, set);
  }
  workflow.priorStageAlternativeCounts = workflow.priorStageAlternativeCounts.map((entry) => {
    const unchecked = memory.preferences
      .filter((p) => p.strength === 'hard' && p.relevantStages.includes(entry.stage as never) && !bound.get(entry.stage)?.has(p.id))
      .map((p) => p.id);
    return unchecked.length > 0 ? { ...entry, uncheckedHardPreferenceIds: unchecked } : { stage: entry.stage, count: entry.count };
  });
}

// ── Chain simulation (as decisiveSelection.regress.ts) ──────────────────────

interface Chain {
  history: unknown[];
  workflow: PlannerWorkflow;
  memory?: PlannerWorkflowMemory;
  toolNames: string[];
  snapshot: Array<{ id: string; value: string }>;
}

function visibleOptions(workflow: PlannerWorkflow): Array<{ id: string; value: string }> {
  const view = (workflow.currentView ?? {}) as Json;
  return (Array.isArray(view.visibleItems) ? view.visibleItems : [])
    .filter(isRecord)
    .map((item) => ({ id: String(item.id ?? ''), value: String(item.value ?? '') }));
}

function narrowTools(all: string[], lastAction: string): string[] {
  const gui = new Set(['augment', 'filter', 'sort', 'highlight', 'clearModification']);
  if (lastAction === 'highlight') return [];
  if (gui.has(lastAction)) return all.filter((name) => gui.has(name) || name === 'select' || name === 'selectMultiple');
  return all;
}

function applyStep(chain: Chain, output: PlannerOutput): void {
  const tool = output.action.toolName;
  const params = output.action.params;
  const view = (chain.workflow.currentView ?? (chain.workflow.currentView = {})) as Json;
  const modification = (isRecord(view.modification) ? view.modification : (view.modification = {})) as Json;
  const visible = visibleOptions(chain.workflow);
  const items = (Array.isArray(view.items) ? view.items : []).filter(isRecord);
  if (tool === 'augment') {
    const given = Array.isArray(params.items) ? params.items.filter(isRecord) : [];
    const byId = new Map(given.map((entry) => [String(entry.itemId ?? ''), String(entry.value ?? '')]));
    view.visibleItems = visible.map((item) => ({ id: item.id, value: byId.get(item.id) || item.value }));
    modification.augment = true;
  } else if (tool === 'filter') {
    const expression = { field: String(params.field ?? ''), operator: String(params.operator ?? 'eq'), value: params.value } as unknown as FilterExpression;
    const existing = Array.isArray(modification.filter) ? (modification.filter as FilterExpression[]) : [];
    const filters = [...existing, expression];
    const kept = new Set(applyFilterExpressions(items, filters, 'value').map((item) => String(item.id)));
    view.visibleItems = visible.filter((item) => kept.has(item.id));
    modification.filter = filters;
    const hidden = items.filter(isSelectableItem).length - (view.visibleItems as unknown[]).length;
    if (hidden > 0) view.hiddenByFilterCount = hidden;
    else delete view.hiddenByFilterCount;
  } else if (tool === 'sort') {
    modification.sort = { field: params.field, order: params.order ?? 'asc' };
  } else if (tool === 'clearModification') {
    const type = String(params.type ?? 'all');
    if (type === 'filter' || type === 'all') {
      const current = new Map(visible.map((item) => [item.id, item.value]));
      const known = new Map(chain.snapshot.map((item) => [item.id, item.value]));
      view.visibleItems = items.filter(isSelectableItem).map((item) => {
        const id = String(item.id);
        return { id, value: current.get(id) ?? known.get(id) ?? String(item.name ?? item.title ?? id) };
      });
      delete modification.filter;
      delete view.hiddenByFilterCount;
    }
    if (type === 'highlight' || type === 'all') {
      delete view.highlightedIds;
      delete modification.highlight;
    }
  } else if (tool === 'highlight') {
    const ids = Array.isArray(params.itemIds) ? params.itemIds.map(String) : [];
    view.highlightedIds = ids;
    modification.highlight = { itemIds: ids };
  }
  const annotation: Json = { kind: 'tool-modification', toolName: tool, source: 'agent' };
  if (output.action.reason) annotation.reason = output.action.reason;
  const entry: Json = { type: 'system', stage: chain.workflow.currentStage, annotation };
  if (output.assistantMessage.trim()) entry.linkedAgentText = output.assistantMessage.trim();
  chain.history.push(entry);
  chain.toolNames = narrowTools(chain.toolNames, tool);
  chain.workflow.availableToolNames = [...chain.toolNames, 'respond'];
}

interface ReplayFlags {
  language?: string;
  spokenBrevity: boolean;
  narrateAdaptations: boolean;
  preloadedMemory: boolean;
}

function flagsFromPrompt(systemPrompt: string): ReplayFlags {
  let language: string | undefined;
  for (const candidate of SUPPORTED_CONVERSATION_LANGUAGES) {
    const section = buildLanguageSection(candidate);
    if (section && systemPrompt.includes(section)) language = candidate;
  }
  return {
    ...(language ? { language } : {}),
    spokenBrevity: systemPrompt.includes('Writing for the ear'),
    narrateAdaptations: systemPrompt.includes('Narrating the adaptation'),
    preloadedMemory: systemPrompt.includes('Remembered preferences (this session)'),
  };
}

interface Step {
  tool: string;
  message: string;
  reason: string;
  params: Json;
  conflictIds: string[];
}

interface ChainResult {
  steps: Step[];
  chain: Chain;
  /** The sentence the visitor is left with. */
  lastMessage: string;
  /** select / selectMultiple / next / prev, with the item id for select. */
  committed: string | null;
}

async function replayChain(
  start: PlannerRequest,
  overrides: { history?: unknown[]; memory?: PlannerWorkflowMemory; workflow?: PlannerWorkflow; toolNames?: string[] },
  after: boolean
): Promise<ChainResult | null> {
  const flags = flagsFromPrompt(start.systemPrompt);
  const workflow = clone(overrides.workflow ?? start.workflow);
  const chain: Chain = {
    history: clone(overrides.history ?? start.history),
    workflow,
    memory: clone(overrides.memory ?? start.memory),
    toolNames: (overrides.toolNames ?? start.toolNames).filter((name) => name !== 'respond'),
    snapshot: visibleOptions(workflow),
  };
  chain.workflow.availableToolNames = [...chain.toolNames, 'respond'];
  const steps: Step[] = [];
  let committed: string | null = null;
  for (let left = MAX_CHAIN; left > 0; left -= 1) {
    const output = await planActionWithOpenAI({
      history: chain.history,
      availableTools: toolsFor(chain.toolNames),
      workflow: chain.workflow,
      stageMeta: stageMetaFromPlannerPrompt(start.systemPrompt),
      ...(chain.memory ? { memory: chain.memory } : {}),
      ...(flags.language ? { language: flags.language } : {}),
      ...(flags.narrateAdaptations ? { narrateAdaptations: true } : {}),
      ...(flags.spokenBrevity ? { spokenBrevity: true } : {}),
      ...(flags.preloadedMemory ? { preloadedMemory: true } : {}),
      demoSession: true,
      decisiveSelection: true,
      ...(after ? { requirementConflicts: true } : {}),
    });
    if (!output) return null;
    const tool = output.action.type === 'none' ? 'respond' : output.action.toolName;
    steps.push({
      tool,
      message: output.assistantMessage,
      reason: output.action.reason,
      params: output.action.params,
      conflictIds: output.conflictMemory?.preferenceIds ?? [],
    });
    if (tool === 'select' || tool === 'selectMultiple') {
      committed = `${tool} ${String(output.action.params.itemId ?? (output.action.params.itemIds as unknown[] | undefined)?.join('+') ?? '')}`;
      break;
    }
    if (tool === 'respond' || tool === 'next' || tool === 'prev') {
      if (tool !== 'respond') committed = tool;
      break;
    }
    if (!chain.toolNames.includes(tool)) break;
    applyStep(chain, output);
  }
  const lastMessage = [...steps].reverse().find((step) => step.message.trim())?.message ?? '';
  return { steps, chain, lastMessage, committed };
}

function describeChain(result: ChainResult): string {
  return result.steps
    .map((step) => {
      const detail =
        step.tool === 'filter'
          ? ` ${String(step.params.field)} ${String(step.params.operator)} ${JSON.stringify(step.params.value)}`
          : step.tool === 'select'
            ? ` ${String(step.params.itemId)}`
            : step.tool === 'augment'
              ? ` [${(Array.isArray(step.params.items) ? step.params.items : []).filter(isRecord).map((i) => String(i.value)).join(' | ')}]`
              : step.tool === 'clearModification'
                ? ` ${String(step.params.type ?? '')}`
                : '';
      return `${step.tool}${detail}${step.message.trim() ? ` "${step.message.trim()}"` : ''}`;
    })
    .join(' → ');
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const OFFERS_OTHER_DAY = /날짜|다른 날|요일을|date|another day|different day/i;
const OFFERS_OTHER_FILM = /다른 영화|another (?:movie|film)/i;
const NAMES_TROY = /troy|트로이|20\.4/i;
const NAMES_LIMIT = /15\s*(?:마일|mile)|마일|mile|거리|distance|가까운|closer|nearby/i;
const ASKS = /\?\s*$|까요|나요|실래요|할래요/;

interface Verdict {
  ok: boolean;
  label: string;
}

function scoreTheaterLimit(result: ChainResult): Verdict {
  const message = result.lastMessage;
  if (result.committed) return { ok: false, label: `commits (${result.committed})` };
  if (OFFERS_OTHER_DAY.test(message) || OFFERS_OTHER_FILM.test(message)) return { ok: false, label: 'offers another day/film' };
  if (!IMAX.test(message)) return { ok: false, label: 'no IMAX in the sentence' };
  if (!NAMES_TROY.test(message)) return { ok: false, label: 'does not say where IMAX is' };
  if (!ASKS.test(message.trim())) return { ok: false, label: 'does not ask' };
  return { ok: true, label: 'names the conflict and asks' };
}

function scoreTimeDeadEnd(result: ChainResult): Verdict {
  const message = result.lastMessage;
  if (result.committed === 'prev') return { ok: false, label: 'goes back unasked' };
  if (result.committed) return { ok: false, label: `commits (${result.committed})` };
  if (OFFERS_OTHER_DAY.test(message)) return { ok: false, label: 'offers another day' };
  if (!IMAX.test(message)) return { ok: false, label: 'no IMAX in the sentence' };
  if (!NAMES_LIMIT.test(message) && !/극장|theater|cinema/i.test(message)) return { ok: false, label: 'names only IMAX' };
  if (!ASKS.test(message.trim())) return { ok: false, label: 'does not ask' };
  return { ok: true, label: 'names both and asks' };
}

function scoreRelaxed(result: ChainResult, expected: 'nearby' | 'troy'): Verdict {
  const message = result.lastMessage;
  // The [conflict] tag is expected here (the section covers the answer too);
  // what must not happen is the same either-or question again.
  const conflictAgain = !result.committed && IMAX.test(message) && NAMES_TROY.test(message) && ASKS.test(message.trim());
  if (conflictAgain) return { ok: false, label: 'raises the conflict again' };
  if (OFFERS_OTHER_DAY.test(message)) return { ok: false, label: 'offers another day' };
  const selected = result.committed?.startsWith('select ') ? result.committed.slice('select '.length) : null;
  if (expected === 'troy') {
    if (selected === 't5') return { ok: true, label: 'selects Troy' };
    if (selected) return { ok: false, label: `selects ${selected}, not Troy` };
    return { ok: false, label: result.committed ? `commits (${result.committed})` : 'asks instead of taking Troy' };
  }
  if (selected === 't5') return { ok: false, label: 'selects Troy anyway' };
  if (selected) return { ok: true, label: `selects ${selected}` };
  const view = (result.chain.workflow.currentView ?? {}) as Json;
  const onScreen = (Array.isArray(view.visibleItems) ? view.visibleItems : []).filter(isRecord).map((item) => String(item.id));
  if (onScreen.includes('t5')) return { ok: false, label: 'distance filter lost, Troy back on screen' };
  if (!result.committed && ASKS.test(message.trim())) return { ok: true, label: 'asks between the nearby two' };
  return { ok: false, label: result.committed ? `commits (${result.committed})` : 'no question' };
}

// ── Cases ───────────────────────────────────────────────────────────────────

interface Tally {
  ok: number;
  n: number;
  labels: Map<string, number>;
}

const tallies = new Map<string, { before: Tally; after: Tally }>();

function record(caseName: string, side: 'before' | 'after', verdict: Verdict | null, detail: string): void {
  const entry = tallies.get(caseName) ?? {
    before: { ok: 0, n: 0, labels: new Map() },
    after: { ok: 0, n: 0, labels: new Map() },
  };
  const tally = entry[side];
  tally.n += 1;
  const label = verdict ? verdict.label : 'no output';
  if (verdict?.ok) tally.ok += 1;
  tally.labels.set(label, (tally.labels.get(label) ?? 0) + 1);
  tallies.set(caseName, entry);
  if (VERBOSE || !verdict?.ok) {
    console.log(`    ${side.padEnd(6)} ${verdict?.ok ? 'ok  ' : 'FAIL'} ${label} :: ${detail}`);
  }
}

function wants(name: string): boolean {
  return !ONLY || name.includes(ONLY);
}

function extractionCtx(request: ExtractorRequest, after: boolean, patch?: (ctx: PreferenceExtractionContext) => void): PreferenceExtractionContext {
  const input = clone(request.input);
  const ctx: PreferenceExtractionContext = {
    userMessage: String(input.userMessage ?? ''),
    currentStage: String(input.currentStage ?? ''),
    state: (input.state ?? null) as Json | null,
    compactUi: input.compactUi,
    recentDialogue: (input.recentDialogue ?? []) as PreferenceExtractionContext['recentDialogue'],
    existingPreferences: (input.existingPreferences ?? []) as Preference[],
    stageMeta: stageMetaFromExtractorPrompt(request.systemPrompt),
    ...(after ? { demoSession: true } : {}),
  };
  patch?.(ctx);
  return ctx;
}

function describePreferences(preferences: Preference[]): string {
  return preferences.map((p) => `${p.description} [${p.relevantStages.join(',')}]`).join(' / ');
}

async function runSession(session: Session): Promise<void> {
  console.log(`\n${session.name}`);
  const opener = session.extractor.find((request) => IMAX.test(String(request.input.userMessage ?? '')));
  const limit = session.extractor.find((request) => /15\s*마일/.test(String(request.input.userMessage ?? '')));

  for (let run = 0; run < RUNS; run += 1) {
    if (opener && wants('extract-opener')) {
      for (const after of [false, true]) {
        const preferences = await extractStructuredPreferences(extractionCtx(opener, after));
        const imax = preferences.find((p) => IMAX.test(p.description));
        const verdict: Verdict = !imax
          ? { ok: false, label: 'no IMAX preference' }
          : imax.relevantStages.includes('theater')
            ? { ok: true, label: `IMAX on ${imax.relevantStages.join(',')}` }
            : { ok: false, label: `IMAX on ${imax.relevantStages.join(',')} only` };
        record('extract-opener', after ? 'after' : 'before', verdict, describePreferences(preferences));
      }
    }

    if (limit && wants('extract-limit')) {
      for (const after of [false, true]) {
        const ctx = extractionCtx(limit, after, (c) => {
          if (after) c.existingPreferences = withImaxAtTheater(c.existingPreferences);
        });
        const preferences = await extractStructuredPreferences(ctx);
        const imax = preferences.find((p) => IMAX.test(p.description));
        const distance = preferences.find((p) => DISTANCE.test(p.description));
        const verdict: Verdict = !distance?.relevantStages.includes('theater')
          ? { ok: false, label: 'distance not on theater' }
          : !imax?.relevantStages.includes('theater')
            ? { ok: false, label: 'IMAX not on theater' }
            : { ok: true, label: 'both on theater' };
        record('extract-limit', after ? 'after' : 'before', verdict, describePreferences(preferences));
      }
    }

    if (limit && wants('extract-relax')) {
      for (const [answer, expected] of [
        ['첫 번째 걸로 할게요.', 'drop-imax'],
        ['트로이까지 갈게요.', 'drop-limit'],
      ] as const) {
        for (const after of [false, true]) {
          const ctx = extractionCtx(limit, after, (c) => {
            const distanceId = 'pref_limit000000';
            c.existingPreferences = [
              ...withImaxAtTheater(c.existingPreferences),
              { id: distanceId, description: 'Will not drive more than 15 miles.', strength: 'hard', relevantStages: ['theater'] },
            ];
            c.recentDialogue = [
              ...c.recentDialogue,
              { type: 'user', text: c.userMessage },
              { type: 'agent', text: CONFLICT_QUESTION },
            ];
            c.userMessage = answer;
          });
          const preferences = await extractStructuredPreferences(ctx);
          const hasImax = preferences.some((p) => IMAX.test(p.description) && !/without|no imax|없이|drop/i.test(p.description));
          const hasLimit = preferences.some((p) => /15/.test(p.description) && DISTANCE.test(p.description));
          const ok = expected === 'drop-imax' ? !hasImax && hasLimit : hasImax && !hasLimit;
          record(
            `extract-relax (${answer})`,
            after ? 'after' : 'before',
            { ok, label: `IMAX ${hasImax ? 'kept' : 'gone'}, 15 mi ${hasLimit ? 'kept' : 'gone'}` },
            describePreferences(preferences)
          );
        }
      }
    }

    const entry = session.planner.find((step) => step.workflow.currentStage === 'theater');
    if (entry && wants('theater-entry')) {
      for (const after of [false, true]) {
        const memory = clone(entry.memory);
        if (after && memory) memory.preferences = withImaxAtTheater(memory.preferences);
        const result = await replayChain(entry, { memory }, after);
        record(
          'theater-entry',
          after ? 'after' : 'before',
          result ? { ok: true, label: result.committed ?? `asks: ${result.lastMessage.slice(0, 40)}` } : null,
          result ? describeChain(result) : ''
        );
      }
    }

    const atLimit = session.planner.find((step) => step.workflow.currentStage === 'theater' && /15\s*마일/.test(step.openedByUser ?? ''));
    if (atLimit && (wants('theater-limit') || wants('theater-relaxed'))) {
      for (const after of [false, true]) {
        const memory = clone(atLimit.memory);
        if (after && memory) memory.preferences = withImaxAtTheater(memory.preferences);
        const result = await replayChain(atLimit, { memory }, after);
        if (wants('theater-limit')) {
          record('theater-limit', after ? 'after' : 'before', result ? scoreTheaterLimit(result) : null, result ? describeChain(result) : '');
        }
        // The follow-up only makes sense from a chain that asked the question.
        if (!after || !result || !wants('theater-relaxed') || !scoreTheaterLimit(result).ok || !memory) continue;
        for (const [answer, expected, gone] of [
          ['첫 번째 걸로 할게요.', 'nearby', IMAX],
          ['트로이까지 갈게요.', 'troy', DISTANCE],
        ] as const) {
          const history = [
            ...result.chain.history,
            { type: 'agent', stage: 'theater', text: result.lastMessage },
            { type: 'user', stage: 'theater', action: 'input', label: answer },
          ];
          const relaxedMemory = { ...clone(memory), preferences: memory.preferences.filter((p) => !gone.test(p.description)) };
          const followed = await replayChain(
            atLimit,
            { history, memory: relaxedMemory, workflow: result.chain.workflow, toolNames: atLimit.toolNames },
            true
          );
          record(`theater-relaxed (${answer})`, 'after', followed ? scoreRelaxed(followed, expected) : null, followed ? describeChain(followed) : '');
        }
      }
    }

    const time = session.planner.find((step) => step.workflow.currentStage === 'time');
    if (time && wants('time-deadend')) {
      for (const after of [false, true]) {
        const workflow = clone(time.workflow);
        if (after) annotateCounts(workflow, time.memory, session);
        const result = await replayChain(time, { workflow }, after);
        record('time-deadend', after ? 'after' : 'before', result ? scoreTimeDeadEnd(result) : null, result ? describeChain(result) : '');
      }
    }
  }
}

/** Requests from live runs where the visitor answered the either-or question. */
function liveRelaxRequests(): ExtractorRequest[] {
  const found: ExtractorRequest[] = [];
  for (const file of EXTRA_TRACES) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      const event = JSON.parse(line) as Json;
      if (event.type !== 'llm.extractor.request') continue;
      const payload = (event.payload ?? {}) as Json;
      const body = (payload.body ?? {}) as { input?: Array<{ content?: unknown }> };
      const messages = body.input ?? [];
      const input = JSON.parse(String(messages[messages.length - 1]?.content ?? '{}')) as Json;
      const dialogue = Array.isArray(input.recentDialogue) ? (input.recentDialogue as Json[]) : [];
      const lastAgent = [...dialogue].reverse().find((entry) => entry.type === 'agent');
      if (!lastAgent || !IMAX.test(String(lastAgent.text)) || !/아니면/.test(String(lastAgent.text))) continue;
      if (!/첫 번째/.test(String(input.userMessage ?? ''))) continue;
      // Only an answer given while both requirements were still in memory: a
      // later re-ask after one was already (wrongly) retracted scores nothing.
      const existing = Array.isArray(input.existingPreferences) ? (input.existingPreferences as Json[]) : [];
      if (!existing.some((p) => IMAX.test(String(p.description))) || !existing.some((p) => DISTANCE.test(String(p.description)))) continue;
      found.push({ requestId: String(payload.requestId ?? ''), systemPrompt: String(messages[0]?.content ?? ''), input });
    }
  }
  return found;
}

async function runLiveRelax(): Promise<void> {
  if (!wants('extract-relax-live')) return;
  for (const request of liveRelaxRequests()) {
    for (let run = 0; run < RUNS; run += 1) {
      const preferences = await extractStructuredPreferences(extractionCtx(request, true));
      const hasImax = preferences.some((p) => IMAX.test(p.description));
      const hasLimit = preferences.some((p) => /15/.test(p.description) && DISTANCE.test(p.description));
      record(
        'extract-relax-live (첫 번째 → no IMAX)',
        'after',
        { ok: !hasImax && hasLimit, label: `IMAX ${hasImax ? 'kept' : 'gone'}, 15 mi ${hasLimit ? 'kept' : 'gone'}` },
        `${request.requestId}: ${describePreferences(preferences)}`
      );
    }
  }
}

async function main(): Promise<void> {
  requireApiKey('cardB.regress.ts');
  const sessions = SESSIONS.map(([name, id]) => loadSession(name, id)).filter((s): s is Session => s !== null);
  if (sessions.length === 0) {
    console.error(`No card-B traces under ${TRACE_DIR}; pass --trace-dir <main checkout>/logs/demo/trace`);
    process.exit(2);
  }
  console.log(`card B replay: ${sessions.map((s) => s.name).join(', ')}, ${RUNS} run(s) per case and side`);
  await Promise.all([...sessions.map((session) => runSession(session)), runLiveRelax()]);

  console.log('\nsummary (success / replays)');
  for (const [name, { before, after }] of tallies) {
    const line = (tally: Tally) =>
      tally.n === 0 ? '—' : `${tally.ok}/${tally.n}  ${[...tally.labels].map(([label, n]) => `${label} ×${n}`).join('; ')}`;
    console.log(`  ${name}`);
    console.log(`    before ${line(before)}`);
    console.log(`    after  ${line(after)}`);
  }
}

void main();
