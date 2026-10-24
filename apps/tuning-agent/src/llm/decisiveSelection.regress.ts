/**
 * How often does the booth agent ask for a confirmation the visitor already gave?
 *
 *   npx tsx apps/tuning-agent/src/llm/decisiveSelection.regress.ts
 *       walk the demo traces since 2026-10-17 and score what was LOGGED (no API)
 *   OPENAI_API_KEY=... npx tsx apps/tuning-agent/src/llm/decisiveSelection.regress.ts --replay
 *       replay every visitor turn twice — today's demo prompt, and today's demo
 *       prompt plus the decisive-selection section — and score both
 *   ... --control          replay both sides with the section OFF (planner variance)
 *   ... --only a22b5409    one session (substring of the trace file name)
 *   ... --limit 20         first N visitor turns only
 *   ... --since 20261017   earliest trace date (yyyymmdd) to include
 *   ... --no-widen         replay without the demo-only "select after a GUI
 *                          step" tool availability (see getPlannerToolSchema)
 *   ... --verbose          print every replayed chain, not just the summary
 *
 * Read out of the 2026-10-23 booth session: "I wanna see the Street Fighter"
 * became clearModification → highlight → "Would you like to choose Street
 * Fighter?", and "which one is the closest one?" became sort → "The closest
 * theater is Bel Air Luxury Cinema. Would you like to choose it?" → "okay it's
 * fine" → select. Three visitor turns for one decision, in a noisy room.
 *
 * The unit is a VISITOR TURN: one utterance and every planner call it caused,
 * up to the next utterance (the stage-entry call after `next` belongs to the
 * turn that caused it). Each turn is scored twice:
 *
 *   said     — what the visitor had just said, from the utterance and what was
 *              on screen at that moment: `named` (an on-screen option by name),
 *              `agree` (yes / that one / 그걸로), `question`, `preference`
 *              (a criterion, not a pick) or `other` (noise, fragments).
 *   outcome  — what the agent did with it: `commit` (select / selectMultiple /
 *              next at confirm / prev when asked), or the kind of sentence it
 *              ended on instead: `confirm-q` ("Would you like to choose X?",
 *              "선택할까요?"), `clarify-q` ("Did you mean 5:15?"), `open-q`
 *              ("Which theater would you like?"), `statement`, or `silent`.
 *
 * `named → confirm-q` is the nagging. `preference → commit` on an item the
 * visitor never named is the failure mode the new section must not introduce,
 * so every replayed commit prints the item and whether the utterance named it.
 *
 * The replay re-runs the FIRST planner call of a turn and follows the chain:
 * augment, sort, filter, highlight and clearModification are simulated on the
 * logged currentView the way the host would apply them (augment rewrites the
 * display values it was given; sort reorders by the raw field; filter uses the
 * agent's own filterSimulation; clear restores from the turn's snapshot), the
 * step is appended to history as the agent's own annotation, and the tool list
 * is narrowed as getPlannerToolSchema narrows it. The simulation is not the
 * host — a cleared filter cannot rebuild labels it never saw — but it is close
 * enough to tell a chain that ends in select from one that ends in a question.
 *
 * Real API calls, so this stays out of `npm run check` like the other
 * `*.regress.ts` harnesses; `plannerPrompt.check.ts` is the offline half.
 */
import fs from 'node:fs';
import path from 'node:path';

import { applyFilterExpressions, isSelectableItem } from '../core/filterSimulation';
import type { FilterExpression } from '../types';
import {
  SUPPORTED_CONVERSATION_LANGUAGES,
  buildLanguageSection,
  planActionWithOpenAI,
} from './llmPlanner';
import type { PlannerOutput, PlannerWorkflow, PlannerWorkflowMemory } from './llmPlanner';
import { requireApiKey, toolsFor } from './plannerReplay.regress';

const DEMO_TRACE_DIR = path.resolve(process.cwd(), 'logs/demo/trace');

const REPLAY = process.argv.includes('--replay');
const CONTROL = process.argv.includes('--control');
const VERBOSE = process.argv.includes('--verbose');
const WIDEN = !process.argv.includes('--no-widen');
const ONLY = readArg('--only') ?? '';
const LIMIT = Number.parseInt(readArg('--limit') ?? '', 10) || Infinity;
const SINCE = readArg('--since') ?? '20261017';
const CONCURRENCY = Number.parseInt(readArg('--concurrency') ?? '', 10) || 4;
/** A chain longer than this is a loop, not a plan. */
const MAX_CHAIN = 6;

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

// ── Trace parsing ───────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

interface LoggedStep {
  requestId: string;
  stage: string;
  toolNames: string[];
  history: unknown[];
  memory?: PlannerWorkflowMemory;
  workflow: PlannerWorkflow;
  systemPrompt: string;
  /** The utterance this step was planned from, if history ends on one. */
  openedByUser: string | null;
  lastUser: string | null;
  tool: string;
  params: Json;
  reason: string;
  message: string;
}

interface VisitorTurn {
  trace: string;
  session: string;
  firstRequestId: string;
  utterance: string | null;
  stage: string;
  steps: LoggedStep[];
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSteps(filePath: string): LoggedStep[] {
  const byId = new Map<string, Partial<LoggedStep>>();
  const order: string[] = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line) continue;
    let event: Json;
    try {
      event = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const payload = event.payload as Json | undefined;
    const requestId = payload?.requestId;
    if (typeof requestId !== 'string') continue;
    if (event.type === 'llm.planner.request') {
      const body = payload?.body as { input?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ name?: string }> } | undefined;
      const messages = body?.input ?? [];
      const systemPrompt = typeof messages[0]?.content === 'string' ? messages[0].content : '';
      const userContent = messages[messages.length - 1]?.content;
      if (typeof userContent !== 'string') continue;
      let parsed: Json;
      try {
        parsed = JSON.parse(userContent) as Json;
      } catch {
        continue;
      }
      const workflow = parsed.workflow as PlannerWorkflow | undefined;
      if (!workflow) continue;
      const history = Array.isArray(parsed.history) ? parsed.history : [];
      const last = history[history.length - 1];
      const openedByUser =
        isRecord(last) && last.type === 'user' ? String(last.label ?? last.text ?? '') : null;
      let lastUser: string | null = null;
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const entry = history[i];
        if (isRecord(entry) && entry.type === 'user') {
          lastUser = String(entry.label ?? entry.text ?? '');
          break;
        }
      }
      byId.set(requestId, {
        requestId,
        stage: String(workflow.currentStage ?? ''),
        toolNames: (body?.tools ?? []).map((tool) => String(tool.name ?? '')).filter(Boolean),
        history,
        memory: parsed.memory as PlannerWorkflowMemory | undefined,
        workflow,
        systemPrompt,
        openedByUser,
        lastUser,
      });
      order.push(requestId);
    } else if (event.type === 'llm.planner.response.parsed') {
      const step = byId.get(requestId);
      if (!step) continue;
      const parsed = (payload?.parsed ?? {}) as Json;
      const action = (parsed.action ?? {}) as Json;
      step.tool = typeof action.toolName === 'string' && action.toolName ? action.toolName : 'respond';
      step.params = isRecord(action.params) ? action.params : {};
      step.reason = typeof action.reason === 'string' ? action.reason : '';
      step.message = typeof parsed.assistantMessage === 'string' ? parsed.assistantMessage : '';
    }
  }
  return order
    .map((id) => byId.get(id))
    .filter((step): step is LoggedStep => Boolean(step && step.tool));
}

function groupTurns(trace: string, steps: LoggedStep[]): VisitorTurn[] {
  const session = trace.slice('demo-st_'.length, 'demo-st_'.length + 8);
  const turns: VisitorTurn[] = [];
  for (const step of steps) {
    const opens = step.openedByUser !== null || turns.length === 0;
    if (opens) {
      turns.push({
        trace,
        session,
        firstRequestId: step.requestId,
        utterance: step.openedByUser,
        stage: step.stage,
        steps: [step],
      });
    } else {
      turns[turns.length - 1].steps.push(step);
    }
  }
  return turns;
}

// ── Classifying what the visitor said ───────────────────────────────────────

type Said = 'named' | 'agree' | 'question' | 'preference' | 'other';

const STOP = new Set([
  'the', 'and', 'of', 'a', 'an', 'to', 'at', 'in', 'on', 'cinema', 'cinemas', 'theatre', 'theater',
  'theaters', 'digital', 'grand', 'luxury', 'road', 'street', 'last', 'royal', 'main', 'east',
  'north', 'miles', 'mile', 'away', 'screens', 'screen', 'free', 'parking', 'reserved', 'seating',
  'recliners', 'seat', 'seats', 'row', 'pm', 'am', 'nov', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat',
  'sun', 'standard', 'imax',
]);

/** Korean renderings of the demo dataset's names, as the booth STT wrote them. */
const KO_ALIASES: Array<[RegExp, string]> = [
  [/스트리트\s*파이터/, 'street fighter'],
  [/레전드\s*오브\s*아[암앙]|라스트\s*에어벤더/, 'legend aang airbender'],
  [/클레이\s*페이스/, 'clayface'],
  [/와일드\s*우드/, 'wildwood'],
  [/클라라/, 'klara'],
  [/레드\s*포[드트]/, 'redford'],
  [/벨\s*에어/, 'bel air'],
  [/이[매메]진/, 'emagine'],
  [/트로이/, 'troy'],
  [/시네마\s*디트로이트|디트로이트/, 'detroit'],
];

const WEEKDAYS: Array<[RegExp, string]> = [
  [/\b(monday|mon)\b|월요일/i, 'mon'],
  [/\b(tuesday|tue|tues)\b|화요일/i, 'tue'],
  [/\b(wednesday|wed)\b|수요일/i, 'wed'],
  [/\b(thursday|thu|thurs)\b|목요일/i, 'thu'],
  [/\b(friday|fri)\b|금요일/i, 'fri'],
  [/\b(saturday|sat)\b|토요일/i, 'sat'],
  [/\b(sunday|sun)\b|일요일/i, 'sun'],
];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function visibleOptions(workflow: PlannerWorkflow): Array<{ id: string; value: string }> {
  const view = (workflow.currentView ?? {}) as Json;
  const visible = Array.isArray(view.visibleItems) ? view.visibleItems : [];
  return visible
    .filter(isRecord)
    .map((item) => ({ id: String(item.id ?? ''), value: String(item.value ?? '') }));
}

function rawItems(workflow: PlannerWorkflow): Json[] {
  const view = (workflow.currentView ?? {}) as Json;
  return Array.isArray(view.items) ? view.items.filter(isRecord) : [];
}

/** The on-screen option the utterance names, if exactly one. */
function namedOption(utterance: string, workflow: PlannerWorkflow, stage: string): string | null {
  let text = utterance.toLowerCase();
  for (const [pattern, alias] of KO_ALIASES) text = text.replace(pattern, ` ${alias} `);
  // "7시 40분" → "7:40"; "4:50" stays.
  text = text.replace(/(\d{1,2})\s*시\s*(\d{1,2})\s*분/g, (_m, h, m) => `${h}:${String(m).padStart(2, '0')}`);
  text = text.replace(/(\d{1,2})\s*시(?!\d)/g, (_m, h) => `${h}:00`);
  const said = new Set(tokens(text));
  const options = visibleOptions(workflow);
  if (options.length === 0) return null;

  // Discriminative label tokens: words that belong to one option only.
  const labelTokens = options.map((option) =>
    tokens(option.value.split(' — ')[0]).filter((token) => token.length >= 3 && !STOP.has(token))
  );
  const counts = new Map<string, number>();
  for (const list of labelTokens) for (const token of new Set(list)) counts.set(token, (counts.get(token) ?? 0) + 1);
  const hits = new Set<string>();
  options.forEach((option, index) => {
    if (labelTokens[index].some((token) => counts.get(token) === 1 && said.has(token))) hits.add(option.id);
  });

  if (stage === 'date') {
    for (const [pattern, abbreviation] of WEEKDAYS) {
      if (!pattern.test(utterance)) continue;
      for (const option of options) if (option.value.toLowerCase().includes(`(${abbreviation})`)) hits.add(option.id);
    }
    const dayNumber = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(utterance);
    if (dayNumber) {
      for (const option of options) if (new RegExp(`\\b${dayNumber[1]}\\b`).test(option.value.split(' (')[0])) hits.add(option.id);
    }
  }
  if (stage === 'time') {
    for (const match of text.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
      const clock = `${Number(match[1]) % 12 || 12}:${match[2]}`;
      const clock24 = `${match[1]}:${match[2]}`;
      for (const option of options) {
        const label = option.value.toLowerCase();
        if (label.startsWith(clock + ' ') || label.startsWith(clock24 + ' ') || label.includes(` ${clock} `)) hits.add(option.id);
      }
    }
  }
  if (stage === 'seat') {
    const seats = new Set<string>();
    for (const match of utterance.toUpperCase().matchAll(/\b([A-K])\s?(\d{1,2})\b/g)) seats.add(`${match[1]}${match[2]}`);
    // "C567" → C5, C6, C7
    for (const match of utterance.toUpperCase().matchAll(/\b([A-K])(\d{2,})\b/g)) {
      for (const digit of match[2]) seats.add(`${match[1]}${digit}`);
    }
    // "the 4 and 5" against a highlighted pair
    const view = (workflow.currentView ?? {}) as Json;
    const highlighted = Array.isArray(view.highlightedIds) ? view.highlightedIds.map(String) : [];
    const numbers = [...utterance.matchAll(/\b(\d{1,2})\b/g)].map((m) => m[1]);
    if (seats.size === 0 && numbers.length >= 1 && highlighted.length > 0) {
      const rows = new Set(highlighted.map((id) => id.slice(id.lastIndexOf('-') + 1).replace(/\d+$/, '')));
      if (rows.size === 1) for (const n of numbers) seats.add(`${[...rows][0]}${n}`);
    }
    if (seats.size > 0) {
      const matched = options.filter((option) => seats.has(option.id.slice(option.id.lastIndexOf('-') + 1).toUpperCase()));
      if (matched.length === seats.size) return matched.map((option) => option.id).join('+');
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

const AGREE = /^(?:um+,?\s*|uh+,?\s*|okay,?\s*|ok,?\s*|yes,?\s*|yeah,?\s*|sure,?\s*|어+,?\s*|음+,?\s*|네,?\s*|응,?\s*|그럼\s*|일단\s*)*(?:거기로|맞아|yes|yeah|yep|sure|ok|okay|fine|it's fine|that's good|that seems good|that one|this one|go ahead|please|do it|sounds good|good|그걸로|그거로|그렇게|해\s?줘|해주세요|그래|네|응|좋아|좋네)/i;
const QUESTION_LEAD = /^(?:um+,?\s*|uh+,?\s*|okay,?\s*|excuse me,?\s*|어+,?\s*)*(?:which|what|is|are|can|could|do|does|how|where|when|why|would|will|should|혹시|어느|어떤|언제|어디|뭐|무엇|왜)\b/i;
const PREFERENCE = /\b(?:horror|comedy|action|animation|drama|family|thriller|sci-?fi|adventure|kids?|closest|nearest|cheapest|earliest|latest|only|need|must|until|before|after|by|prefer|adjacent|together|middle|recliner|imax|3d|special|evening|morning|afternoon|weekend)\b|longer|shorter|longest|shortest|공포|액션|코미디|애니|가까운|가장|이전|이후|전에|후에|리클라이너|붙어|나란히|자리|조건|이면 좋|ホラー|映画/i;

function classifySaid(turn: VisitorTurn): { said: Said; named: string | null } {
  const utterance = turn.utterance;
  if (!utterance || !utterance.trim()) return { said: 'other', named: null };
  const first = turn.steps[0];
  const named = namedOption(utterance, first.workflow, turn.stage);
  const isQuestion = /\?\s*$/.test(utterance) || QUESTION_LEAD.test(utterance.trim()) || /있나\??$|있을까\??$|없나\??$|없을까\??$|어디지\??$|가깝지\??$/.test(utterance.trim());
  // "어 스트리트 파이터?" — a name with the transcript's question mark is a name.
  if (named && tokens(utterance).length <= 4 && !QUESTION_LEAD.test(utterance.trim())) return { said: 'named', named };
  if (isQuestion) return { said: 'question', named };
  if (named) return { said: 'named', named };
  if (AGREE.test(utterance.trim()) && tokens(utterance).length <= 8) return { said: 'agree', named: null };
  if (PREFERENCE.test(utterance)) return { said: 'preference', named: null };
  return { said: 'other', named: null };
}

// ── Classifying what the agent did ──────────────────────────────────────────

type Outcome = 'commit' | 'confirm-q' | 'final-q' | 'clarify-q' | 'open-q' | 'statement' | 'silent';

const OPEN_Q_KO = /어느|어떤|무엇|뭐|몇|어디|언제|중 어느|어떻게/;
const CONFIRM_Q = /would you like (?:to )?(?:choose|select|pick|keep|go|proceed|confirm|book|continue|take|the |it\b|this|that|them)|shall (?:i|we)\b|do you want (?:me )?to|should i\b|want me to|ready to|선택할까요|선택해 드릴까요|진행할까요|진행할게요\?|확정할|계속할까요|로 할까요|으로 할까요|돌아가 볼까요|살펴볼까요|바꿀까요|괜찮으세요|되셨나요|할까요\?\s*$|でよろしいですか|しますか|でいいですか/i;
const CLARIFY_Q = /did you mean|do you mean|which (?:one )?(?:do|did) you mean|말씀하시는|어느 (?:극장|영화|시간|날짜)을 말씀|맞나요/i;
const HAS_QUESTION = /\?\s*$|[까요나요]\s*\?|\?$/;

interface Scored {
  outcome: Outcome;
  /** The turn reached the confirm stage and ended on the booking read-back question. */
  finalConfirmAsked: boolean;
  /** The last sentence the visitor heard. */
  lastMessage: string;
  committed: string | null;
  tools: string[];
  rule: string | null;
}

function classifyMessage(message: string, stage: string): Outcome {
  const text = message.trim();
  if (!text) return 'silent';
  if (CLARIFY_Q.test(text)) return 'clarify-q';
  // "어느 극장으로 할까요?" is "which theater?", not "shall I choose it?".
  if (OPEN_Q_KO.test(text) && !/선택할까요|진행할까요/.test(text)) return 'open-q';
  if (CONFIRM_Q.test(text)) return stage === 'confirm' ? 'final-q' : 'confirm-q';
  if (HAS_QUESTION.test(text) || /\?/.test(text)) return 'open-q';
  return 'statement';
}

/** The `[rule]` tag the decisive section asks the planner to open `reason` with. */
function readRule(reason: string): string | null {
  const match = /^\s*\[([a-z-]+)\]/i.exec(reason);
  return match ? match[1].toLowerCase() : null;
}

function scoreLogged(turn: VisitorTurn): Scored {
  const tools = turn.steps.map((step) => step.tool);
  const lastWithMessage = [...turn.steps].reverse().find((step) => step.message.trim());
  const lastMessage = lastWithMessage?.message ?? '';
  const commitStep = turn.steps.find(
    (step) =>
      step.tool === 'select' ||
      step.tool === 'selectMultiple' ||
      (step.tool === 'next' && step.stage === 'confirm') ||
      step.tool === 'prev'
  );
  const rule = readRule(turn.steps[0].reason);
  // The sentence that ended the turn is what the visitor must answer.
  const ending = turn.steps[turn.steps.length - 1];
  const endingMessage = ending.message.trim() ? ending.message : lastMessage;
  const endingOutcome = classifyMessage(endingMessage, ending.stage);
  const finalConfirmAsked = endingOutcome === 'final-q';
  if (commitStep) {
    return { outcome: 'commit', finalConfirmAsked, lastMessage, committed: describeCommit(commitStep, commitStep.workflow), tools, rule };
  }
  return { outcome: endingOutcome, finalConfirmAsked, lastMessage: endingMessage, committed: null, tools, rule };
}

function describeCommit(step: { tool: string; params: Json; stage: string }, workflow: PlannerWorkflow): string {
  if (step.tool === 'select') {
    const id = String(step.params.itemId ?? '');
    const option = visibleOptions(workflow).find((item) => item.id === id);
    return option ? option.value.split(' — ')[0] : `${id} (NOT ON SCREEN)`;
  }
  if (step.tool === 'selectMultiple') {
    const ids = Array.isArray(step.params.itemIds) ? step.params.itemIds.map(String) : [];
    return ids.map((id) => id.slice(id.lastIndexOf('-') + 1)).join('+');
  }
  return step.tool;
}

// ── Replay: the chain simulation ────────────────────────────────────────────

interface ChainState {
  history: unknown[];
  workflow: PlannerWorkflow;
  memory?: PlannerWorkflowMemory;
  toolNames: string[];
  /** The screen as the turn began, for clearModification. */
  snapshot: { visible: Array<{ id: string; value: string }>; highlighted: string[]; modification: Json };
}

function cloneWorkflow(workflow: PlannerWorkflow): PlannerWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as PlannerWorkflow;
}

/**
 * Mirrors getPlannerToolSchema in core/planner.ts, with the demo-only widening
 * under test: after augment / filter / sort / clearModification a demo turn that
 * a visitor utterance opened keeps select and selectMultiple, so a preference
 * that leaves one option can be acted on in the same turn. Never after next
 * (stage entry stays a consent boundary) and never after highlight.
 */
function narrowTools(all: string[], lastAction: string, widen: boolean): string[] {
  const gui = new Set(['augment', 'filter', 'sort', 'highlight', 'clearModification']);
  switch (lastAction) {
    case 'select':
    case 'selectMultiple':
      return all.filter((name) => name === 'next');
    case 'next':
      return all.filter((name) => gui.has(name));
    case 'highlight':
      return [];
    case 'augment':
    case 'filter':
    case 'sort':
    case 'clearModification':
      return all.filter((name) => gui.has(name) || (widen && (name === 'select' || name === 'selectMultiple')));
    default:
      return all;
  }
}

function applyStep(state: ChainState, output: PlannerOutput): void {
  const tool = output.action.toolName;
  const params = output.action.params;
  const view = (state.workflow.currentView ?? (state.workflow.currentView = {})) as Json;
  const modification = (isRecord(view.modification) ? view.modification : (view.modification = {})) as Json;
  const visible = visibleOptions(state.workflow);
  const items = rawItems(state.workflow);

  if (tool === 'augment') {
    const given = Array.isArray(params.items) ? params.items.filter(isRecord) : [];
    const byId = new Map(given.map((entry) => [String(entry.itemId ?? ''), String(entry.value ?? '')]));
    view.visibleItems = visible.map((item) => ({ id: item.id, value: byId.get(item.id) || item.value }));
    modification.augment = true;
  } else if (tool === 'sort') {
    const field = String(params.field ?? '');
    const order = params.order === 'desc' ? -1 : 1;
    const key = (id: string): number | string => {
      const raw = items.find((item) => String(item.id) === id)?.[field];
      if (typeof raw === 'number') return raw;
      const text = String(raw ?? '');
      const clock = /^(\d{1,2}):(\d{2})/.exec(text);
      return clock ? Number(clock[1]) * 60 + Number(clock[2]) : text;
    };
    view.visibleItems = [...visible].sort((a, b) => {
      const ka = key(a.id);
      const kb = key(b.id);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * order;
    });
    modification.sort = { field, order: params.order ?? 'asc' };
  } else if (tool === 'filter') {
    const expression = { field: String(params.field ?? ''), operator: String(params.operator ?? 'eq'), value: params.value } as unknown as FilterExpression;
    const existing = Array.isArray(modification.filter) ? (modification.filter as FilterExpression[]) : isRecord(modification.filter) ? [modification.filter as unknown as FilterExpression] : [];
    const filters = [...existing, expression];
    const kept = new Set(applyFilterExpressions(items, filters, 'value').map((item) => String(item.id)));
    view.visibleItems = visible.filter((item) => kept.has(item.id));
    modification.filter = filters;
    const hidden = items.filter(isSelectableItem).length - (view.visibleItems as unknown[]).length;
    if (hidden > 0) view.hiddenByFilterCount = hidden;
    else delete view.hiddenByFilterCount;
  } else if (tool === 'clearModification') {
    const type = String(params.type ?? 'all');
    if (type === 'filter' || type === 'all') {
      // Everything selectable comes back; a label the turn never showed is
      // rebuilt from the raw item, which is the one place the simulation and
      // the host can differ.
      const known = new Map(state.snapshot.visible.map((item) => [item.id, item.value]));
      const current = new Map(visible.map((item) => [item.id, item.value]));
      view.visibleItems = items.filter(isSelectableItem).map((item) => {
        const id = String(item.id);
        return { id, value: current.get(id) ?? known.get(id) ?? String(item.title ?? item.name ?? item.value ?? id) };
      });
      delete modification.filter;
      delete view.hiddenByFilterCount;
    }
    if (type === 'highlight' || type === 'all') {
      delete view.highlightedIds;
      delete modification.highlight;
    }
    if (type === 'sort' || type === 'all') delete modification.sort;
    if (type === 'augment' || type === 'all') delete modification.augment;
  } else if (tool === 'highlight') {
    const ids = Array.isArray(params.itemIds) ? params.itemIds.map(String) : [];
    view.highlightedIds = ids;
    modification.highlight = { itemIds: ids };
  }

  const annotation: Json = { kind: 'tool-modification', toolName: tool, source: 'agent' };
  if (output.action.reason) annotation.reason = output.action.reason;
  const entry: Json = { type: 'system', stage: state.workflow.currentStage, annotation };
  if (output.assistantMessage.trim()) entry.linkedAgentText = output.assistantMessage.trim();
  state.history.push(entry);
  state.toolNames = narrowTools(state.toolNames, tool, WIDEN && state.widen);
  state.workflow.availableToolNames = [...state.toolNames, 'respond'];
}

interface ChainStateWithFlag extends ChainState {
  widen: boolean;
}

interface ReplayFlags {
  language?: string;
  spokenBrevity: boolean;
  preloadedMemory: boolean;
  narrateAdaptations: boolean;
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
    preloadedMemory: systemPrompt.includes('Remembered preferences (this session)'),
    narrateAdaptations: systemPrompt.includes('Narrating the adaptation'),
  };
}

interface ReplayResult {
  steps: Array<{ tool: string; message: string; reason: string; params: Json }>;
  scored: Scored;
  /** A select whose item was not on screen: the host would reject it. */
  invalidSelect: boolean;
}

async function replayTurn(turn: VisitorTurn, decisive: boolean): Promise<ReplayResult | null> {
  const first = turn.steps[0];
  const flags = flagsFromPrompt(first.systemPrompt);
  const state: ChainStateWithFlag = {
    history: JSON.parse(JSON.stringify(first.history)) as unknown[],
    workflow: cloneWorkflow(first.workflow),
    ...(first.memory ? { memory: first.memory } : {}),
    toolNames: first.toolNames.filter((name) => name !== 'respond'),
    snapshot: {
      visible: visibleOptions(first.workflow),
      highlighted: Array.isArray((first.workflow.currentView as Json | undefined)?.highlightedIds)
        ? ((first.workflow.currentView as Json).highlightedIds as unknown[]).map(String)
        : [],
      modification: isRecord((first.workflow.currentView as Json | undefined)?.modification)
        ? ((first.workflow.currentView as Json).modification as Json)
        : {},
    },
    widen: decisive,
  };
  const steps: ReplayResult['steps'] = [];
  let invalidSelect = false;
  let committed: string | null = null;
  let stepsLeft = MAX_CHAIN;
  while (stepsLeft > 0) {
    stepsLeft -= 1;
    const output = await planActionWithOpenAI({
      history: state.history,
      availableTools: toolsFor(state.toolNames),
      workflow: state.workflow,
      stageMeta: parseStageMeta(first.systemPrompt),
      ...(state.memory ? { memory: state.memory } : {}),
      ...(flags.language ? { language: flags.language } : {}),
      ...(flags.narrateAdaptations ? { narrateAdaptations: true } : {}),
      ...(flags.spokenBrevity ? { spokenBrevity: true } : {}),
      ...(flags.preloadedMemory ? { preloadedMemory: true } : {}),
      demoSession: true,
      ...(decisive ? { decisiveSelection: true } : {}),
    });
    if (!output) return null;
    const tool = output.action.type === 'none' ? 'respond' : output.action.toolName;
    steps.push({ tool, message: output.assistantMessage, reason: output.action.reason, params: output.action.params });
    if (tool === 'select') {
      const id = String(output.action.params.itemId ?? '');
      const option = visibleOptions(state.workflow).find((item) => item.id === id);
      if (!option) invalidSelect = true;
      committed = describeCommit({ tool, params: output.action.params, stage: state.workflow.currentStage }, state.workflow);
      break;
    }
    if (tool === 'selectMultiple') {
      committed = describeCommit({ tool, params: output.action.params, stage: state.workflow.currentStage }, state.workflow);
      break;
    }
    if (tool === 'respond' || tool === 'next' || tool === 'prev') {
      if ((tool === 'next' && state.workflow.currentStage === 'confirm') || tool === 'prev') committed = tool;
      // The host would change stage here; the simulation has no next screen.
      break;
    }
    if (!state.toolNames.includes(tool)) {
      // The host would reject this; stop rather than simulate a tool it never had.
      break;
    }
    applyStep(state, output);
    if (state.toolNames.length === 0) {
      // After a highlight only respond remains: ask it for the closing sentence.
      continue;
    }
  }
  const last = steps[steps.length - 1];
  const lastMessage = [...steps].reverse().find((step) => step.message.trim())?.message ?? '';
  const outcome: Outcome = committed
    ? 'commit'
    : classifyMessage(last?.message.trim() ? last.message : lastMessage, turn.stage);
  return {
    steps,
    scored: {
      outcome,
      finalConfirmAsked: turn.stage === 'confirm' && outcome === 'final-q',
      lastMessage: last?.message.trim() ? last.message : lastMessage,
      committed,
      tools: steps.map((s) => s.tool),
      rule: readRule(steps[0]?.reason ?? ''),
    },
    invalidSelect,
  };
}

function parseStageMeta(systemPrompt: string): Array<{ stage: string; goal: string; fieldGuide: string }> {
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

// ── Reporting ───────────────────────────────────────────────────────────────

const SAID_ORDER: Said[] = ['named', 'agree', 'question', 'preference', 'other'];
const OUTCOME_ORDER: Outcome[] = ['commit', 'confirm-q', 'final-q', 'clarify-q', 'open-q', 'statement', 'silent'];

type Matrix = Record<Said, Record<Outcome, number>>;

function emptyMatrix(): Matrix {
  const matrix = {} as Matrix;
  for (const said of SAID_ORDER) {
    matrix[said] = {} as Record<Outcome, number>;
    for (const outcome of OUTCOME_ORDER) matrix[said][outcome] = 0;
  }
  return matrix;
}

function printMatrix(title: string, matrix: Matrix): void {
  console.log(`\n${title}`);
  console.log(`  ${'said \\ outcome'.padEnd(12)} ${OUTCOME_ORDER.map((o) => o.padStart(10)).join('')}   total`);
  for (const said of SAID_ORDER) {
    const row = matrix[said];
    const total = OUTCOME_ORDER.reduce((sum, outcome) => sum + row[outcome], 0);
    if (total === 0) continue;
    console.log(`  ${said.padEnd(12)} ${OUTCOME_ORDER.map((o) => String(row[o]).padStart(10)).join('')}   ${total}`);
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`;
}

function short(text: string | null, n = 70): string {
  const value = (text ?? '').replace(/\s+/g, ' ');
  return value.length > n ? value.slice(0, n - 1) + '…' : value;
}

function collectTurns(): VisitorTurn[] {
  const files = fs
    .readdirSync(DEMO_TRACE_DIR)
    .filter((name) => name.endsWith('.llm-trace.jsonl'))
    .filter((name) => {
      const date = /-(\d{8})-\d{6}\.llm-trace\.jsonl$/.exec(name)?.[1] ?? '';
      return date >= SINCE;
    })
    .filter((name) => !ONLY || name.includes(ONLY))
    .sort();
  const turns: VisitorTurn[] = [];
  for (const file of files) {
    turns.push(...groupTurns(file, readSteps(path.join(DEMO_TRACE_DIR, file))));
  }
  return turns;
}

async function pool<T, R>(items: T[], size: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const all = collectTurns();
  // Opening turns (nothing said yet) are not decisions the visitor made.
  const turns = all.filter((turn) => turn.utterance && turn.utterance.trim() && turn.utterance !== 'None');
  console.log(`demo traces since ${SINCE}${ONLY ? ` matching "${ONLY}"` : ''}: ${new Set(all.map((t) => t.trace)).size} sessions, ${turns.length} visitor turns`);

  // 1. What was logged.
  const logged = emptyMatrix();
  const scoredLogged = turns.map((turn) => ({ turn, said: classifySaid(turn), scored: scoreLogged(turn) }));
  for (const entry of scoredLogged) logged[entry.said.said][entry.scored.outcome] += 1;

  console.log('\nlogged turns  (session#request  stage  said  →  tools  →  outcome | last sentence)');
  for (const { turn, said, scored } of scoredLogged) {
    console.log(
      `  ${turn.session}#${turn.firstRequestId.replace('planner-', '').padStart(3)} ${turn.stage.padEnd(7)} ` +
        `${said.said.padEnd(10)} "${short(turn.utterance, 44)}"`.padEnd(70) +
        ` → ${scored.tools.join('>')} → ${scored.outcome}${scored.committed ? ` [${scored.committed}]` : ''} | ${short(scored.lastMessage, 80)}`
    );
  }
  printMatrix('LOGGED (as the booth ran, whatever prompt and model it had that day)', logged);
  summarize(scoredLogged.map((entry) => ({ said: entry.said.said, scored: entry.scored, named: entry.said.named, turn: entry.turn })));

  if (!REPLAY) return;
  requireApiKey('decisiveSelection.regress.ts');

  const subset = scoredLogged.slice(0, LIMIT);
  console.log(
    `\nreplaying ${subset.length} turns × 2 (${CONTROL ? 'CONTROL: both sides with the section OFF' : 'today vs decisive'}), concurrency ${CONCURRENCY}` +
      (WIDEN ? ', decisive side keeps select after a GUI step' : ', no tool widening')
  );
  const results = await pool(subset, CONCURRENCY, async (entry) => {
    const today = await replayTurn(entry.turn, false);
    const decisive = await replayTurn(entry.turn, !CONTROL);
    return { ...entry, today, decisive };
  });

  const todayMatrix = emptyMatrix();
  const decisiveMatrix = emptyMatrix();
  const flagged: string[] = [];
  const rules = new Map<string, number>();
  let invalid = 0;
  let failed = 0;
  console.log('\nreplayed turns');
  for (const entry of results) {
    const { turn, said } = entry;
    if (!entry.today || !entry.decisive) {
      failed += 1;
      console.log(`  ${turn.session}#${turn.firstRequestId}  FAIL planner returned nothing`);
      continue;
    }
    todayMatrix[said.said][entry.today.scored.outcome] += 1;
    decisiveMatrix[said.said][entry.decisive.scored.outcome] += 1;
    if (entry.decisive.invalidSelect) invalid += 1;
    const rule = entry.decisive.scored.rule ?? '(none)';
    rules.set(rule, (rules.get(rule) ?? 0) + 1);
    const line =
      `  ${turn.session}#${turn.firstRequestId.replace('planner-', '').padStart(3)} ${turn.stage.padEnd(7)} ${said.said.padEnd(10)} "${short(turn.utterance, 44)}"\n` +
      `      today    : ${entry.today.scored.tools.join('>')} → ${entry.today.scored.outcome}${entry.today.scored.committed ? ` [${entry.today.scored.committed}]` : ''} | ${short(entry.today.scored.lastMessage, 90)}\n` +
      `      decisive : ${entry.decisive.scored.tools.join('>')} → ${entry.decisive.scored.outcome}${entry.decisive.scored.committed ? ` [${entry.decisive.scored.committed}]` : ''} [${rule}] | ${short(entry.decisive.scored.lastMessage, 90)}`;
    const changed = entry.today.scored.outcome !== entry.decisive.scored.outcome || entry.today.scored.committed !== entry.decisive.scored.committed;
    if (VERBOSE || changed) console.log(line);
    // The failure mode: a commit on something the visitor did not name.
    if (entry.decisive.scored.outcome === 'commit' && entry.decisive.scored.committed && !['next', 'prev'].includes(entry.decisive.scored.committed)) {
      const namedIt = said.said === 'named' || said.said === 'agree' || (said.named !== null);
      if (!namedIt) {
        flagged.push(
          `  ${turn.session}#${turn.firstRequestId}  ${turn.stage}  ${said.said}  "${short(turn.utterance, 60)}"  →  selected [${entry.decisive.scored.committed}]  [${rule}]  "${short(entry.decisive.scored.lastMessage, 80)}"`
        );
      }
    }
  }

  printMatrix('TODAY (current demo prompt, replayed)', todayMatrix);
  summarize(results.filter((r) => r.today).map((r) => ({ said: r.said.said, scored: r.today!.scored, named: r.said.named, turn: r.turn })));
  printMatrix(CONTROL ? 'CONTROL (same prompt again — planner variance)' : 'DECISIVE (current demo prompt + the decisive-selection section)', decisiveMatrix);
  summarize(results.filter((r) => r.decisive).map((r) => ({ said: r.said.said, scored: r.decisive!.scored, named: r.said.named, turn: r.turn })));

  console.log(`\nrules the decisive side named in reason:`);
  for (const [rule, count] of [...rules.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${rule.padEnd(24)} ${count}`);
  console.log(`\nselects of an item not on screen (host would reject): ${invalid}`);
  console.log(`planner returned nothing: ${failed}`);
  console.log(`\ncommits on something the visitor did not name — review each (must be 0 or defensible):`);
  if (flagged.length === 0) console.log('  none');
  for (const line of flagged) console.log(line);
}

function summarize(entries: Array<{ said: Said; scored: Scored; named: string | null; turn: VisitorTurn }>): void {
  const named = entries.filter((e) => e.said === 'named');
  const namedCommit = named.filter((e) => e.scored.outcome === 'commit').length;
  const namedConfirm = named.filter((e) => e.scored.outcome === 'confirm-q').length;
  const preference = entries.filter((e) => e.said === 'preference');
  const prefConfirm = preference.filter((e) => e.scored.outcome === 'confirm-q').length;
  const prefCommit = preference.filter((e) => e.scored.outcome === 'commit').length;
  const questions = entries.filter((e) => e.said === 'question');
  const qConfirm = questions.filter((e) => e.scored.outcome === 'confirm-q').length;
  const agrees = entries.filter((e) => e.said === 'agree').length;
  const confirmAll = entries.filter((e) => e.scored.outcome === 'confirm-q').length;
  const finalConfirm = entries.filter((e) => e.scored.finalConfirmAsked).length;
  console.log(
    `  named an option → committed ${pct(namedCommit, named.length)} (${namedCommit}/${named.length}), asked to confirm ${pct(namedConfirm, named.length)}\n` +
      `  stated a preference → asked to confirm ${pct(prefConfirm, preference.length)} (${prefConfirm}/${preference.length}), committed ${pct(prefCommit, preference.length)}\n` +
      `  asked a question → answer ended on "would you like to choose it?" ${pct(qConfirm, questions.length)} (${qConfirm}/${questions.length})\n` +
      `  confirmation questions outside the confirm stage: ${confirmAll}   turns that reached the confirm read-back question (must stay): ${finalConfirm}\n` +
      `  turns that were only a yes/okay to such a question: ${agrees}`
  );
}

void main();
