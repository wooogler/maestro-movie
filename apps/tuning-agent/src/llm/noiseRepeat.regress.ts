/**
 * Noise turns and the hidden count, replayed from the KSEA poster sessions
 * (2026-10-24). Round 3 of docs/scenarios/ksea2026-korean-simulation.md.
 *
 *   npx tsx apps/tuning-agent/src/llm/noiseRepeat.regress.ts
 *       offline: run core/repeatLedger.ts over the logged message sequences
 *   OPENAI_API_KEY=... npx tsx apps/tuning-agent/src/llm/noiseRepeat.regress.ts --replay
 *       also replay the planner request behind every repeated or hidden-count
 *       message, BEFORE (today's booth prompt) vs AFTER (+ HIDDEN_COUNT_ONCE_RULES),
 *       and run the ledger on what comes back
 *   ... --logs <dir>      the host-mounted logs root (default: <cwd>/logs)
 *   ... --runs 2          replays per case and side (default 2)
 *   ... --only dc803c81   one session
 *   ... --verbose         print every case
 *
 * Offline half. The three logs of each session (demo/trace, demo/interaction,
 * agent-runtime) are parsed the way `.notes/ksea-poster/timeline.py` and
 * `repetition.py` parse them, and every rendered agent message gets the same
 * labels: `exact` (same normalised text as a message from the same or the
 * previous visitor turn, same stage), `near` (difflib ratio >= 0.6 against
 * those), `hidden` (a "…숨겨/숨겼…" sentence for a condition already stated in
 * the two previous turns). The port is checked against the analysis's totals
 * (32 / 16 / 7) before anything else is reported. Then the messages are fed,
 * in order, through what the booth agent now does with them:
 *
 *   - the existing in-turn exact dedupe (repeatGuard.ts, and 1ec6a31's
 *     closing-respond rule), which resets on every user message;
 *   - the new cross-turn ledger: a visitor turn is "nothing new" when the
 *     preference extractor changed nothing (from `extraction.completed` in the
 *     runtime log) and the words were not a bare agreement (isBareAgreement);
 *     a filter step resets the hidden count (noteFilterChanged).
 *
 * The ledger only ever drops TEXT, never a tool call, so every select/next of
 * an agreement turn still runs; the report counts them anyway, and checks that
 * no agreement turn was ever judged nothing-new.
 *
 * Replay half (real API calls, so out of `npm run check`): the planner request
 * that produced each repeated or hidden-count message is sent again with the
 * Round-2 booth flags (BEFORE) and with hiddenCountOnce added (AFTER); each
 * answer's message goes through a ledger rebuilt from what had been said at
 * that stage before it. Scored: is the planner's own sentence still a repeat /
 * still a restated count, and what survives the ledger.
 *
 * Visitor words are participant data: this file holds none, and prints only
 * the agent's sentences and the session ids.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  asksAboutHidden,
  createStageRepeatLedger,
  hiddenCountKey,
  isBareAgreement,
  isClosedQuestion,
  isHiddenCountSentence,
  isNearRepeat,
  splitSentences,
  type StageRepeatLedger,
} from '../core/repeatLedger';
import type { PlannerWorkflow, PlannerWorkflowMemory } from './llmPlanner';

type Json = Record<string, unknown>;

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const LOGS = readArg('--logs') ?? path.resolve(process.cwd(), 'logs');
const RUNS = Number.parseInt(readArg('--runs') ?? '', 10) || 2;
const ONLY = readArg('--only') ?? '';
const VERBOSE = process.argv.includes('--verbose');
const REPLAY = process.argv.includes('--replay');
const CONCURRENCY = Number.parseInt(readArg('--concurrency') ?? '', 10) || 4;

/** The six poster sessions that conversed (the other five never did). */
const SESSIONS = ['9b9d4210', '41a175f7', '73debf02', '1df4ab03', 'dc803c81', '822a4a42'];

// ── Log loading ─────────────────────────────────────────────────────────────

function loadJsonl(dir: string, prefix: string, suffix: string): Json[] {
  const full = path.join(LOGS, dir);
  if (!fs.existsSync(full)) return [];
  const out: Json[] = [];
  for (const name of fs.readdirSync(full).sort()) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    for (const line of fs.readFileSync(path.join(full, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Json);
      } catch {
        // a torn last line
      }
    }
  }
  return out;
}

/** Seconds since midnight UTC, as timeline.py's ts(). */
function ts(event: Json): number {
  const stamp = String(event.timestamp);
  const [h, m, rest] = stamp.slice(11).replace(/Z$/, '').split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(rest);
}

function edt(t: number): string {
  const x = t - 4 * 3600;
  const h = Math.floor(x / 3600);
  const m = Math.floor((x % 3600) / 60);
  const s = Math.floor(x % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface PlannerCall {
  id: string;
  start: number;
  end: number;
  tool: string;
  params: Json;
  reason: string;
  message: string;
  requestBody: Json | null;
}

interface Turn {
  kind: 'utterance' | 'gui';
  rendered: number;
  t0: number;
  text: string;
  /** Utterances only: did the extractor change memory on it. */
  extractionChanged: boolean | null;
}

interface AgentMessage {
  t: number;
  text: string;
  stage: string | null;
  call: PlannerCall | null;
  turn: number;
  labels: Set<'exact' | 'near' | 'hidden'>;
}

interface Session {
  id: string;
  turns: Turn[];
  messages: AgentMessage[];
  calls: PlannerCall[];
}

function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function loadSession(id: string): Session {
  const prefix = `demo-st_${id}`;
  const trace = loadJsonl('demo/trace', prefix, '.llm-trace.jsonl');
  const inter = loadJsonl('demo/interaction', prefix, '.jsonl').filter((e) => !String(e.type ?? '').startsWith('llm.'));
  const runtime = loadJsonl('agent-runtime', prefix, '.agent-runtime.jsonl');

  const byId = new Map<string, PlannerCall & { has: boolean }>();
  for (const event of trace) {
    const type = String(event.type);
    if (!type.includes('.planner.')) continue;
    const payload = asRecord(event.payload);
    const rid = String(payload.requestId ?? '');
    const call = byId.get(rid) ?? { id: rid, start: 0, end: 0, tool: '', params: {}, reason: '', message: '', requestBody: null, has: false };
    if (type.endsWith('.request')) {
      call.start = ts(event);
      call.has = true;
      call.requestBody = asRecord(payload.body);
    } else if (type.endsWith('.raw')) {
      call.end = ts(event);
    } else if (type.endsWith('.parsed')) {
      if (!call.end) call.end = ts(event);
      const parsed = asRecord(payload.parsed);
      const action = asRecord(parsed.action);
      call.tool = action.type === 'none' ? 'respond' : String(action.toolName ?? '');
      call.params = asRecord(action.params);
      call.reason = String(action.reason ?? '');
      call.message = String(parsed.assistantMessage ?? '');
    }
    byId.set(rid, call);
  }
  const calls = [...byId.values()].filter((c) => c.has).sort((a, b) => a.start - b.start);
  for (const call of calls) if (!call.end) call.end = call.start;

  const captured = inter.filter((e) => e.type === 'chat.voice_input.captured');
  const transcribed = inter.filter((e) => e.type === 'chat.voice_input.transcribed');
  const turns: Turn[] = [];
  const messages: AgentMessage[] = [];
  for (const event of inter) {
    if (event.type !== 'chat.message.rendered') continue;
    const message = asRecord(asRecord(event.payload).message);
    const t = ts(event);
    if (message.type === 'user' && message.action === 'input') {
      let t0 = t;
      if ((message.inputSource ?? 'text') === 'voice') {
        const tr = transcribed.filter((x) => t - 3 <= ts(x) && ts(x) <= t + 0.05).at(-1);
        if (tr) {
          const duration = asRecord(tr.payload).durationMs;
          const cap = captured
            .filter((x) => ts(x) <= ts(tr) && ts(x) >= ts(tr) - 15 && asRecord(x.payload).durationMs === duration)
            .at(-1);
          if (cap) t0 = ts(cap);
        }
      }
      turns.push({ kind: 'utterance', rendered: t, t0, text: String(message.label ?? ''), extractionChanged: null });
    } else if (message.type === 'user') {
      turns.push({ kind: 'gui', rendered: t, t0: t, text: '', extractionChanged: null });
    } else if (message.type === 'agent') {
      messages.push({ t, text: String(message.text ?? ''), stage: (message.stage as string) ?? null, call: null, turn: 0, labels: new Set() });
    }
  }
  turns.sort((a, b) => a.t0 - b.t0);

  // The i-th extraction answers the i-th utterance (one per user.message).
  const extractions = runtime.filter((e) => e.type === 'extraction.completed');
  const key = (prefs: unknown): string =>
    JSON.stringify(
      (Array.isArray(prefs) ? prefs : [])
        .map((p) => asRecord(p))
        .map((p) => [p.id, p.description, p.strength])
        .sort()
    );
  let previous = key([]);
  const utterances = turns.filter((t) => t.kind === 'utterance').sort((a, b) => a.rendered - b.rendered);
  extractions.forEach((event, index) => {
    const now = key(asRecord(event.payload).preferences);
    if (utterances[index]) utterances[index].extractionChanged = now !== previous;
    previous = now;
  });

  for (const m of messages) {
    m.call = calls.filter((c) => c.end <= m.t + 0.02 && c.message.trim() === m.text.trim()).at(-1) ?? null;
    const start = m.call ? m.call.start : m.t;
    let k = 0;
    turns.forEach((turn, index) => {
      if (turn.rendered <= start + 0.05) k = index;
    });
    m.turn = k;
  }
  return { id, turns, messages, calls };
}

// ── repetition.py's labels, ported ──────────────────────────────────────────

/** Python difflib.SequenceMatcher(None, a, b).ratio(). */
function difflibRatio(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  const total = A.length + B.length;
  if (total === 0) return 1;
  const b2j = new Map<string, number[]>();
  B.forEach((ch, j) => {
    const list = b2j.get(ch) ?? [];
    list.push(j);
    b2j.set(ch, list);
  });
  if (B.length >= 200) {
    const ntest = Math.floor(B.length / 100) + 1;
    for (const [ch, list] of [...b2j.entries()]) if (list.length > ntest) b2j.delete(ch);
  }
  const findLongest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const next = new Map<number, number>();
      for (const j of b2j.get(A[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    while (besti > alo && bestj > blo && A[besti - 1] === B[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && A[besti + bestsize] === B[bestj + bestsize]) bestsize += 1;
    return [besti, bestj, bestsize];
  };
  let matches = 0;
  const queue: Array<[number, number, number, number]> = [[0, A.length, 0, B.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (!k) continue;
    matches += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  return (2 * matches) / total;
}

const pyNorm = (s: string): string => (s ?? '').replace(/[\s.,?!。？！·:—-]+/gu, '');
const pySents = (text: string): string[] =>
  (text ?? '')
    .split(/(?<=[.?!。？！])\s*/u)
    .map((p) => p.trim())
    .filter(Boolean);
const PY_HIDDEN = /숨겨|숨겼/u;
function condKey(sentence: string): string {
  let s = sentence.replace(/\d+\s*(개|곳|편)/gu, '#');
  s = s.replace(/(다른\s*)?(영화|상영|옵션|극장)\s*/gu, '');
  return Array.from(pyNorm(s.split(/때문에|으로|로\s/u)[0])).slice(0, 14).join('');
}

function labelSession(session: Session): void {
  const { messages } = session;
  messages.forEach((m, j) => {
    const k = m.turn;
    let prior = messages.slice(0, j).filter((x) => x.turn === k || x.turn === k - 1);
    if (!prior.some((x) => x.turn === k - 1) && j > 0) {
      const earlierTurns = messages.slice(0, j).filter((x) => x.turn < k).map((x) => x.turn);
      if (earlierTurns.length) {
        const last = Math.max(...earlierTurns);
        prior = prior.concat(messages.slice(0, j).filter((x) => x.turn === last));
      }
    }
    prior = prior.filter((x) => x.stage === m.stage);
    if ([...prior].reverse().some((x) => pyNorm(x.text) === pyNorm(m.text))) {
      m.labels.add('exact');
    } else if ([...prior].reverse().some((x) => difflibRatio(pyNorm(x.text), pyNorm(m.text)) >= 0.6)) {
      m.labels.add('near');
    }
    const hs = pySents(m.text).filter((s) => PY_HIDDEN.test(s));
    if (hs.length) {
      const earlier = messages.slice(0, j).filter((x) => k - 2 <= x.turn && x.turn <= k);
      const hit = hs.some((s) => earlier.some((x) => pySents(x.text).some((ps) => PY_HIDDEN.test(ps) && condKey(ps) === condKey(s))));
      if (hit) m.labels.add('hidden');
    }
  });
}

// ── The booth agent's speech path, offline ──────────────────────────────────

interface Spoken {
  message: AgentMessage;
  spoken: string;
  by: 'none' | 'in-turn' | 'ledger-silent' | 'ledger-trimmed';
  droppedHidden: string[];
  droppedRepeats: string[];
  nothingNew: boolean;
}

function turnNothingNew(turn: Turn | undefined): boolean {
  if (!turn || turn.kind !== 'utterance') return false;
  return turn.extractionChanged === false;
}

function turnAgreement(turn: Turn | undefined): boolean {
  return turn?.kind === 'utterance' && isBareAgreement(turn.text);
}

function changesHiddenCount(call: PlannerCall | null): boolean {
  if (!call) return false;
  if (call.tool === 'filter') return true;
  if (call.tool !== 'clearModification') return false;
  const type = typeof call.params.type === 'string' ? call.params.type : '';
  return type === '' || type === 'filter' || type === 'all';
}

function runAgent(session: Session): Spoken[] {
  const ledger = createStageRepeatLedger();
  const out: Spoken[] = [];
  let inTurn = new Set<string>();
  let turnIndex = -1;
  let stage: string | null = null;
  for (const m of session.messages) {
    if (m.turn !== turnIndex || m.stage !== stage) {
      // repeatGuard resets on each user message and on stage change; so does
      // the ledger's in-turn memory (beginTurn on the user message)
      if (m.turn !== turnIndex) ledger.beginTurn();
      inTurn = new Set();
      turnIndex = m.turn;
      stage = m.stage;
    }
    const turn = session.turns[m.turn];
    const nothingNew = turnNothingNew(turn);
    if (changesHiddenCount(m.call)) ledger.noteFilterChanged();
    const heardThisTurn = out.some((o) => o.message.turn === m.turn && o.spoken);
    const result = ledger.filter({
      stage: m.stage,
      text: m.text,
      nothingNew,
      agreement: turnAgreement(turn),
      askedAboutHidden: turn?.kind === 'utterance' ? asksAboutHidden(turn.text) : false,
      keepIfEmptied: !nothingNew && !heardThisTurn,
    });
    let spoken = result.text;
    let by: Spoken['by'] = result.silenced ? 'ledger-silent' : spoken !== m.text.trim() ? 'ledger-trimmed' : 'none';
    if (spoken && (inTurn.has(m.text.trim()) || inTurn.has(spoken))) {
      spoken = '';
      by = 'in-turn';
    }
    if (spoken) {
      inTurn.add(m.text.trim());
      inTurn.add(spoken);
      ledger.noteSpoken(m.stage, spoken);
    }
    out.push({ message: m, spoken, by, droppedHidden: result.droppedHidden, droppedRepeats: result.droppedRepeats, nothingNew });
  }
  return out;
}

function offline(sessions: Session[]): void {
  let exact = 0;
  let near = 0;
  let hidden = 0;
  let total = 0;
  for (const s of sessions) {
    labelSession(s);
    total += s.messages.length;
    exact += s.messages.filter((m) => m.labels.has('exact')).length;
    near += s.messages.filter((m) => m.labels.has('near')).length;
    hidden += s.messages.filter((m) => m.labels.has('hidden')).length;
  }
  console.log(`\nlabels (port of repetition.py): ${total} messages, exact ${exact}, near ${near}, hidden ${hidden}`);
  if (!ONLY) {
    const ok = total === 128 && exact === 32 && near === 16 && hidden === 7;
    console.log(ok ? '  matches the analysis (128 / 32 / 16 / 7)' : '  !! DOES NOT match the analysis (128 / 32 / 16 / 7)');
  }

  const tally = {
    exact: { all: 0, silent: 0, trimmed: 0, inTurn: 0, ledger: 0 },
    near: { all: 0, silent: 0, trimmed: 0, inTurn: 0, ledger: 0 },
    hidden: { all: 0, removed: 0 },
  };
  let agreementTurns = 0;
  let agreementJudgedNothingNew = 0;
  let agreementRepeatDrops = 0;
  let agreementClosedDropped = 0;
  let agreementSilenced = 0;
  let agreementCommits = 0;
  let unlabeledDropped = 0;
  let nothingNewTurns = 0;
  let spokenSentencesBefore = 0;
  let spokenSentencesAfter = 0;
  let hiddenSentencesBefore = 0;
  let hiddenSentencesAfter = 0;
  const examples: string[] = [];
  for (const s of sessions) {
    const spoken = runAgent(s);
    nothingNewTurns += s.turns.filter((t) => turnNothingNew(t)).length;
    for (const turn of s.turns) {
      if (turn.kind !== 'utterance' || !isBareAgreement(turn.text)) continue;
      agreementTurns += 1;
      if (turnNothingNew(turn)) agreementJudgedNothingNew += 1;
    }
    // Commits on agreement turns: select / selectMultiple / next calls planned
    // after the agreement, before the next turn. The ledger never sees them.
    s.turns.forEach((turn, index) => {
      if (turn.kind !== 'utterance' || !isBareAgreement(turn.text)) return;
      const until = s.turns[index + 1]?.rendered ?? Infinity;
      agreementCommits += s.calls.filter(
        (c) => c.start >= turn.rendered - 0.05 && c.start < until && ['select', 'selectMultiple', 'next'].includes(c.tool)
      ).length;
    });
    for (const o of spoken) {
      const m = o.message;
      const turn = s.turns[m.turn];
      if (turnAgreement(turn)) {
        agreementRepeatDrops += o.droppedRepeats.length;
        agreementClosedDropped += o.droppedRepeats.filter(isClosedQuestion).length;
        if (!o.spoken && m.text.trim()) agreementSilenced += 1;
      }
      spokenSentencesBefore += splitSentences(m.text).length;
      spokenSentencesAfter += splitSentences(o.spoken).length;
      hiddenSentencesBefore += splitSentences(m.text).filter(isHiddenCountSentence).length;
      hiddenSentencesAfter += splitSentences(o.spoken).filter(isHiddenCountSentence).length;
      for (const kind of ['exact', 'near'] as const) {
        if (!m.labels.has(kind)) continue;
        const row = tally[kind];
        row.all += 1;
        if (!o.spoken) {
          row.silent += 1;
          if (o.by === 'in-turn') row.inTurn += 1;
          else row.ledger += 1;
        } else if (o.spoken !== m.text.trim()) row.trimmed += 1;
      }
      if (m.labels.has('hidden')) {
        tally.hidden.all += 1;
        if (!splitSentences(o.spoken).some(isHiddenCountSentence)) tally.hidden.removed += 1;
      }
      if (!m.labels.size && o.spoken !== m.text.trim()) unlabeledDropped += 1;
      if (VERBOSE || (m.labels.size && o.spoken === m.text.trim())) {
        examples.push(
          `  ${s.id} ${edt(m.t)} [${[...m.labels].join(',') || '-'}] ${m.stage} ${m.call?.tool ?? '?'} nothingNew=${o.nothingNew} ` +
            `«${m.text}» -> ${o.spoken ? `«${o.spoken}»` : '(silent)'} (${o.by})`
        );
      }
    }
  }
  const pct = (a: number, b: number): string => (b ? `${Math.round((100 * a) / b)}%` : '-');
  console.log(`\nBEFORE -> AFTER on the logged sequences (ledger + in-turn dedupe):`);
  console.log(
    `  exact repeats ${tally.exact.all}: silenced ${tally.exact.silent} (${pct(tally.exact.silent, tally.exact.all)}; ledger ${tally.exact.ledger}, in-turn ${tally.exact.inTurn}), trimmed ${tally.exact.trimmed}`
  );
  console.log(
    `  near repeats  ${tally.near.all}: silenced ${tally.near.silent} (${pct(tally.near.silent, tally.near.all)}; ledger ${tally.near.ledger}, in-turn ${tally.near.inTurn}), trimmed ${tally.near.trimmed}`
  );
  console.log(`  hidden-count restatements ${tally.hidden.all}: the count removed in ${tally.hidden.removed}`);
  console.log(`  hidden-count sentences spoken: ${hiddenSentencesBefore} -> ${hiddenSentencesAfter}`);
  console.log(`  agent sentences spoken: ${spokenSentencesBefore} -> ${spokenSentencesAfter}`);
  console.log(`  unlabelled messages changed: ${unlabeledDropped}`);
  console.log(`  nothing-new visitor turns: ${nothingNewTurns}`);
  console.log(
    `  bare-agreement turns ${agreementTurns} (${agreementJudgedNothingNew} changed no memory): repeated sentences dropped ${agreementRepeatDrops}, ` +
      `messages silenced ${agreementSilenced}, repeated yes/no questions dropped ${agreementClosedDropped} (must be 0); ` +
      `select/next calls on them ${agreementCommits} (all still run: the ledger filters text only)`
  );
  if (examples.length) {
    console.log(VERBOSE ? '\nevery message:' : '\nlabelled messages the agent would still say word for word:');
    for (const line of examples) console.log(line);
  }
}

// ── Replay ──────────────────────────────────────────────────────────────────

interface ReplayCase {
  session: string;
  at: string;
  labels: string[];
  stage: string | null;
  logged: string;
  nothingNew: boolean;
  agreement: boolean;
  askedAboutHidden: boolean;
  /** What had been spoken at this stage before, in order, with filter resets. */
  before: Array<{ text: string; filterReset: boolean; sameTurn: boolean }>;
  body: Json;
}

function buildLedger(c: ReplayCase): StageRepeatLedger {
  const ledger = createStageRepeatLedger();
  let opened = false;
  for (const entry of c.before) {
    // Entries are in order and the case's own turn comes last.
    if (entry.sameTurn && !opened) {
      ledger.beginTurn();
      opened = true;
    }
    if (entry.filterReset) ledger.noteFilterChanged();
    ledger.noteSpoken(c.stage, entry.text);
  }
  if (!opened) ledger.beginTurn();
  return ledger;
}

function replayCases(sessions: Session[]): ReplayCase[] {
  const cases: ReplayCase[] = [];
  for (const s of sessions) {
    const spoken = runAgent(s);
    s.messages.forEach((m, index) => {
      if (!m.labels.size || !m.call?.requestBody) return;
      // What the visitor had heard at this stage: the logged messages of the
      // same stage segment, as the booth would have said them.
      const before: ReplayCase['before'] = [];
      for (let j = index - 1; j >= 0 && s.messages[j].stage === m.stage; j -= 1) {
        const o = spoken[j];
        before.unshift({ text: o.spoken, filterReset: changesHiddenCount(s.messages[j].call), sameTurn: s.messages[j].turn === m.turn });
      }
      const turn = s.turns[m.turn];
      cases.push({
        session: s.id,
        at: edt(m.t),
        labels: [...m.labels],
        stage: m.stage,
        logged: m.text,
        nothingNew: turnNothingNew(turn),
        agreement: turnAgreement(turn),
        askedAboutHidden: turn?.kind === 'utterance' ? asksAboutHidden(turn.text) : false,
        before: before.filter((b) => b.text),
        body: m.call.requestBody,
      });
    });
  }
  return cases;
}

interface ReplayResult {
  tool: string;
  message: string;
  spoken: string;
  repeatBeforeLedger: boolean;
  hiddenRestatedBeforeLedger: boolean;
  hiddenRestatedAfterLedger: boolean;
}

async function replayOne(c: ReplayCase, hiddenOnce: boolean): Promise<ReplayResult | null> {
  const { planActionWithOpenAI, SUPPORTED_CONVERSATION_LANGUAGES, buildLanguageSection } = await import('./llmPlanner');
  const { toolsFor } = await import('./plannerReplay.regress');
  const input = (c.body.input ?? c.body.messages) as Array<{ content?: unknown }>;
  const system = typeof input?.[0]?.content === 'string' ? (input[0].content as string) : '';
  const user = JSON.parse(String(input?.at(-1)?.content ?? '{}')) as Json;
  const toolNames = ((c.body.tools ?? []) as Array<{ name?: string; function?: { name?: string } }>)
    .map((t) => String(t.name ?? t.function?.name ?? ''))
    .filter(Boolean);
  let language: string | undefined;
  for (const candidate of SUPPORTED_CONVERSATION_LANGUAGES) {
    const section = buildLanguageSection(candidate);
    if (section && system.includes(section)) language = candidate;
  }
  const stageMeta: Array<{ stage: string; goal: string; fieldGuide: string }> = [];
  const start = system.indexOf('Stage goals:\n');
  if (start >= 0) {
    for (const line of system.slice(start + 'Stage goals:\n'.length).split('\n')) {
      const match = /^ {2}(\w+): (.+)$/.exec(line);
      if (!match) break;
      stageMeta.push({ stage: match[1], goal: match[2], fieldGuide: '' });
    }
  }
  const output = await planActionWithOpenAI({
    history: (user.history as unknown[]) ?? [],
    availableTools: toolsFor(toolNames.length ? toolNames : ['respond']),
    workflow: user.workflow as PlannerWorkflow,
    stageMeta,
    ...(user.memory ? { memory: user.memory as PlannerWorkflowMemory } : {}),
    ...(language ? { language } : {}),
    ...(system.includes('Writing for the ear') ? { spokenBrevity: true } : {}),
    demoSession: true,
    decisiveSelection: true,
    requirementConflicts: true,
    openingQuestions: true,
    seatChoices: true,
    ...(hiddenOnce ? { hiddenCountOnce: true } : {}),
  } as Parameters<typeof planActionWithOpenAI>[0]);
  if (!output) return null;
  const tool = output.action.type === 'none' ? 'respond' : output.action.toolName;
  const message = output.assistantMessage.trim();
  const ledger = buildLedger(c);
  const said = ledger.spokenSentences();
  const sentences = splitSentences(message);
  const hiddenSaid = new Set(said.filter(isHiddenCountSentence).map(hiddenCountKey));
  const repeatBeforeLedger = sentences.length > 0 && sentences.every((s) => said.some((e) => isNearRepeat(e, s)));
  const hiddenRestatedBeforeLedger = sentences.some((s) => isHiddenCountSentence(s) && hiddenSaid.has(hiddenCountKey(s)));
  const clearType = typeof output.action.params?.type === 'string' ? String(output.action.params.type) : '';
  if (tool === 'filter' || (tool === 'clearModification' && (clearType === '' || clearType === 'filter' || clearType === 'all'))) {
    ledger.noteFilterChanged();
  }
  const result = ledger.filter({
    stage: c.stage,
    text: message,
    nothingNew: c.nothingNew,
    agreement: c.agreement,
    askedAboutHidden: c.askedAboutHidden,
    keepIfEmptied: !c.nothingNew,
  });
  const hiddenRestatedAfterLedger = splitSentences(result.text).some(
    (s) => isHiddenCountSentence(s) && hiddenSaid.has(hiddenCountKey(s))
  );
  return { tool, message, spoken: result.text, repeatBeforeLedger, hiddenRestatedBeforeLedger, hiddenRestatedAfterLedger };
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await work(items[index]);
      }
    })
  );
  return results;
}

async function replay(sessions: Session[]): Promise<void> {
  const { requireApiKey } = await import('./plannerReplay.regress');
  requireApiKey('noiseRepeat.regress.ts');
  const cases = replayCases(sessions);
  console.log(`\nreplay: ${cases.length} planner requests behind a repeated or hidden-count message, ${RUNS} run(s) per side`);
  const sides = [
    { label: 'BEFORE (Round-2 booth prompt)', hiddenOnce: false },
    { label: 'AFTER (+ hidden count once)', hiddenOnce: true },
  ];
  const jobs = cases.flatMap((c) => sides.flatMap((side) => Array.from({ length: RUNS }, () => ({ c, side }))));
  const results = await pool(jobs, CONCURRENCY, async (job) => ({ ...job, result: await replayOne(job.c, job.side.hiddenOnce) }));
  for (const side of sides) {
    const mine = results.filter((r) => r.side === side);
    const ok = mine.filter((r) => r.result);
    const rep = mine.filter((r) => r.c.labels.some((l) => l === 'exact' || l === 'near'));
    const repOk = rep.filter((r) => r.result);
    const hid = mine.filter((r) => r.c.labels.includes('hidden'));
    const hidOk = hid.filter((r) => r.result);
    const count = (list: typeof mine, f: (x: ReplayResult) => boolean): number => list.filter((r) => r.result && f(r.result)).length;
    console.log(`\n${side.label}: ${ok.length}/${mine.length} answered`);
    console.log(
      `  repeat cases (${repOk.length}): planner repeats what was said ${count(rep, (x) => x.repeatBeforeLedger)}, ` +
        `spoken after the ledger: nothing ${count(rep, (x) => !x.spoken)}, words left ${count(rep, (x) => !!x.spoken)} ` +
        `(of which on nothing-new turns ${rep.filter((r) => r.result && r.result.spoken && r.c.nothingNew).length})`
    );
    console.log(
      `  hidden cases (${hidOk.length}): planner restates the count ${count(hid, (x) => x.hiddenRestatedBeforeLedger)}, ` +
        `after the ledger ${count(hid, (x) => x.hiddenRestatedAfterLedger)}`
    );
    const all = ok.length;
    console.log(
      `  all cases: planner restates a count ${count(mine, (x) => x.hiddenRestatedBeforeLedger)}/${all}; ` +
        `tools ${[...new Set(ok.map((r) => r.result!.tool))].map((t) => `${t} ${ok.filter((r) => r.result!.tool === t).length}`).join(', ')}`
    );
    for (const r of mine) {
      if (!VERBOSE && !(r.result && (r.result.hiddenRestatedBeforeLedger || (r.result.spoken && r.c.nothingNew)))) continue;
      console.log(
        `    ${r.c.session} ${r.c.at} [${r.c.labels.join(',')}] nothingNew=${r.c.nothingNew} logged «${r.c.logged}» -> ` +
          (r.result ? `${r.result.tool} «${r.result.message}» spoken ${r.result.spoken ? `«${r.result.spoken}»` : '(silent)'}` : 'FAILED')
      );
    }
  }
}

async function main(): Promise<void> {
  const ids = SESSIONS.filter((id) => !ONLY || id.includes(ONLY));
  const sessions = ids.map(loadSession).filter((s) => s.messages.length > 0);
  if (sessions.length === 0) {
    console.error(`no poster session logs under ${LOGS} (pass --logs)`);
    process.exit(1);
  }
  console.log(`sessions: ${sessions.map((s) => `${s.id} (${s.turns.length} turns, ${s.messages.length} messages)`).join(', ')}`);
  offline(sessions);
  if (REPLAY) await replay(sessions);
}

void main();
