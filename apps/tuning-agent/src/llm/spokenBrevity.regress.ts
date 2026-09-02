/**
 * Does asking the planner for a short sentence beat cutting a long one?
 *
 *   OPENAI_API_KEY=... npx tsx apps/tuning-agent/src/llm/spokenBrevity.regress.ts
 *   ... --language ko          replay the same turns in Korean
 *   ... --runs 3               each case N times (LLM output varies)
 *   ... --only sort            narrow to one case
 *
 * Real API calls against real study turns, so this stays out of `npm run check`
 * like the other `*.regress.ts` harnesses. `plannerPrompt.check.ts` is the cheap
 * half — it proves the section is appended for a voice demo and that the study
 * prompt is byte-identical without it. This is the half that cannot be asserted
 * offline, because the question is what a model DOES with a prompt.
 *
 * The comparison is three-way, and that is the point. For every turn:
 *
 *   written  — what the planner writes today, which is also what the transcript
 *              shows and what a text-condition participant reads.
 *   heard    — what the frontend verbosity gate speaks of that sentence today,
 *              after `classifyUtterance` + `decideVoiceOutput` on `balanced`.
 *              This is the regex layer the prompt is meant to replace.
 *   brevity  — what the planner writes when asked to write for the ear.
 *
 * So "did it get shorter" is not the claim under test; the gate already makes it
 * shorter. The claims are that `brevity` is a SENTENCE where `heard` is often a
 * fragment, that it never drops a question the baseline asked, that it reaches
 * the empty string when the screen carries the whole story, and that it does all
 * of that in Korean, where the gate's rules are admittedly unmeasured.
 *
 * The control matters as much as the effect: the same TOOL must still be
 * chosen. This touches the spoken channel and nothing else.
 */
import fs from 'node:fs';
import path from 'node:path';

import { classifyUtterance } from '../../../frontend/src/voice/classifyUtterance';
import { decideVoiceOutput } from '../../../frontend/src/voice/smartSkip';
import {
  DEFAULT_VOICE_VERBOSITY,
  type VoiceVerbositySettings,
} from '../../../frontend/src/voice/verbosity';
import { planActionWithOpenAI } from './llmPlanner';
import {
  TRACE_DIR,
  loadTurn,
  readOnly,
  readRuns,
  requireApiKey,
  toolsFor,
} from './plannerReplay.regress';

const RUNS = readRuns();
const ONLY = readOnly();
/**
 * Run the SAME configuration on both sides.
 *
 * Without this the harness cannot tell "the flag changed the tool" from "this
 * turn is a coin flip". The planner is not deterministic even at a fixed
 * temperature, so a tool disagreement is only evidence against the flag if the
 * control shows agreement on the same turn.
 */
const CONTROL = process.argv.includes('--control');

/**
 * Replay N turns swept off the corpus instead of the seven curated ones.
 *
 * The curated cases are chosen to exercise the two things brevity is FOR, which
 * makes them the wrong sample for asking whether it changes anything else. This
 * mode answers the one question the curated set cannot: over a broad slice of
 * real turns, does the tool the planner picks move? Run it against `--control`
 * on the same N and compare the two disagreement counts — the control is the
 * planner's own run-to-run variance, and only the excess is the flag's doing.
 */
const WIDE = (() => {
  const index = process.argv.indexOf('--wide');
  if (index < 0) return 0;
  const parsed = Number.parseInt(process.argv[index + 1] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
})();

const LANGUAGE = (() => {
  const index = process.argv.indexOf('--language');
  if (index < 0) return 'en';
  return process.argv[index + 1] === 'ko' ? 'ko' : 'en';
})();

/** What the demo actually runs with, so `heard` is the real comparison. */
const GATE: VoiceVerbositySettings = DEFAULT_VOICE_VERBOSITY;

interface Case {
  name: string;
  trace: string;
  requestId: string;
  /** Whether the recorded turn asked the participant something. */
  asksAQuestion: boolean;
}

/*
  Two groups, because brevity has two jobs and they fail differently.

  The first four are GUI adaptations across all four operations: the sentence
  narrates something the participant is looking at, and the right answer is a
  short reason or no sentence at all. The last three are conversation with a
  question in it, where the right answer is the question and the wrong answer is
  anything that loses it.
*/
const CASES: Case[] = [
  {
    name: 'augment/theater — surfacing distance and parking',
    trace: 'P01-C2-S2-easy-20260324-123636.llm-trace.jsonl',
    requestId: 'planner-3',
    asksAQuestion: false,
  },
  {
    name: 'filter/movie — hiding everything over PG-13',
    trace: 'P01-C2-S2-hard-20260324-124119.llm-trace.jsonl',
    requestId: 'planner-3',
    asksAQuestion: false,
  },
  {
    name: 'sort/theater — reordering by distance',
    trace: 'P01-C2-S2-hard-20260324-124119.llm-trace.jsonl',
    requestId: 'planner-8',
    asksAQuestion: false,
  },
  {
    name: 'highlight/movie — marking the kid-friendly options',
    trace: 'P02-C2-S1-easy-20260325-101216.llm-trace.jsonl',
    requestId: 'planner-3',
    asksAQuestion: false,
  },
  {
    // "The free-parking theaters are the highlighted ones. Which do you want to
    // go with?" — a read-back of the screen followed by the question. Exactly
    // what `brief` targets, and the one case the regex handles well.
    name: 'respond/theater — read-back preamble then a question',
    trace: 'P01-C2-S2-easy-20260324-123636.llm-trace.jsonl',
    requestId: 'planner-5',
    asksAQuestion: true,
  },
  {
    name: 'respond/showtime — enumerating the options then asking',
    trace: 'P01-C2-S2-hard-20260324-124119.llm-trace.jsonl',
    requestId: 'planner-12',
    asksAQuestion: true,
  },
  {
    // A dead end. The reason is the whole message and must survive: this is the
    // family the corpus replay caught the first smart-skip version silencing.
    name: 'respond/date — a dead end, explained, then a question',
    trace: 'P01-C2-S2-easy-20260324-123636.llm-trace.jsonl',
    requestId: 'planner-8',
    asksAQuestion: true,
  },
];

/**
 * Turns swept off the corpus, spread across sessions rather than taken in a
 * block: consecutive turns of one booking share a stage, a filter and a mood,
 * and twenty-four of those would measure one situation twenty-four times.
 */
function collectWideCases(limit: number): Case[] {
  const files = fs
    .readdirSync(TRACE_DIR)
    .filter((name) => name.endsWith('.llm-trace.jsonl'))
    .sort();
  const perFile: string[][] = [];
  for (const file of files) {
    let voiceOn: boolean | null = null;
    const ids: string[] = [];
    for (const line of fs.readFileSync(path.join(TRACE_DIR, file), 'utf8').split('\n')) {
      if (!line) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (voiceOn === null) voiceOn = String(event.studyMode ?? '').includes('voice-on');
      if (!voiceOn) break;
      if (event.type !== 'llm.planner.response.raw') continue;
      const payload = event.payload as Record<string, unknown> | undefined;
      const call = payload?.nativeToolCall as Record<string, unknown> | undefined;
      const requestId = payload?.requestId;
      // planner-1 is the opening turn of every session and is always the same
      // shape; skip it so the sweep is not a quarter identical.
      if (!call?.toolName || typeof requestId !== 'string' || requestId === 'planner-1') continue;
      ids.push(requestId);
    }
    if (ids.length > 0) perFile.push(ids.map((id) => `${file}\u0000${id}`));
    if (perFile.length >= limit) break;
  }

  /*
    Spread across turn POSITION as well as across session.

    Taking `ids[round]` from every file looks like a sweep and is not: the first
    pass lifts the same early turn out of all twenty-four bookings, which
    measures one situation twenty-four times. The offset rotates with the file
    index so a first pass already covers early, middle and late turns.
  */
  const picked: Case[] = [];
  const seen = new Set<string>();
  for (let round = 0; picked.length < limit && round < 8; round += 1) {
    for (let fileIndex = 0; fileIndex < perFile.length; fileIndex += 1) {
      if (picked.length >= limit) break;
      const ids = perFile[fileIndex];
      const entry = ids[(fileIndex + round * 3) % ids.length];
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      const [trace, requestId] = entry.split('\u0000');
      picked.push({
        name: `${trace.slice(0, 18)}#${requestId}`,
        trace,
        requestId,
        asksAQuestion: false,
      });
    }
  }
  return picked;
}

/**
 * A SHORTENING that begins on a preposition — the gate's signature failure.
 *
 * Only ever applied to text the shortener actually produced. Applied to whole
 * sentences it is nonsense: "For PG-friendly options, Lantern Bakery and Pocket
 * Parade fit. Which would you like?" opens on a preposition and is perfectly
 * good English. A first pass counted six of those as gate failures when the
 * gate had not touched any of them.
 */
const DANGLING_START = /^(?:to|for|with|from|on|onto|up|back|ahead|so|and|of|at|in|by)\b/i;

/** The on-screen option labels for this turn, for the gate's R3/R5. */
function visibleLabels(workflow: unknown): string[] {
  const view = (workflow as { currentView?: { visibleItems?: unknown } } | null)?.currentView;
  const items = Array.isArray(view?.visibleItems) ? view?.visibleItems : [];
  return items
    .map((item) => String((item as { value?: unknown })?.value ?? ''))
    .filter((value) => value.length > 0);
}

function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

interface Totals {
  runs: number;
  writtenChars: number;
  heardChars: number;
  brevityChars: number;
  brevityEmpty: number;
  gateSilenced: number;
  heardFragments: number;
  brevityFragments: number;
  questionsAsked: number;
  questionsKeptByGate: number;
  questionsKeptByBrevity: number;
  toolChanged: number;
  brevityMultiSentence: number;
}

async function main(): Promise<void> {
  requireApiKey('spokenBrevity.regress.ts');

  const totals: Totals = {
    runs: 0,
    writtenChars: 0,
    heardChars: 0,
    brevityChars: 0,
    brevityEmpty: 0,
    gateSilenced: 0,
    heardFragments: 0,
    brevityFragments: 0,
    questionsAsked: 0,
    questionsKeptByGate: 0,
    questionsKeptByBrevity: 0,
    toolChanged: 0,
    brevityMultiSentence: 0,
  };

  console.log(
    `language: ${LANGUAGE}   runs per case: ${RUNS}   gate preset: ${GATE.preset}` +
      (CONTROL ? '   CONTROL: both sides run with the flag OFF' : '')
  );

  const cases = WIDE > 0 ? collectWideCases(WIDE) : CASES;
  if (WIDE > 0) console.log(`wide sweep: ${cases.length} turns off the corpus`);

  for (const testCase of cases) {
    if (ONLY && !testCase.name.toLowerCase().includes(ONLY)) continue;
    const turn = await loadTurn(testCase.trace, testCase.requestId);
    if (!turn) {
      console.error(
        `  SKIP ${testCase.name} — could not load ${testCase.trace}#${testCase.requestId}`
      );
      continue;
    }

    console.log(`\n${testCase.name}`);
    console.log(`  study run said: "${turn.loggedMessage ?? '(nothing)'}"  [${turn.loggedTool}]`);

    const labels = visibleLabels(turn.workflow);
    const base = {
      history: turn.history,
      availableTools: toolsFor(turn.availableToolNames),
      workflow: turn.workflow,
      stageMeta: turn.stageMeta,
      ...(turn.memory ? { memory: turn.memory } : {}),
      ...(LANGUAGE === 'en' ? {} : { language: LANGUAGE }),
    };

    for (let run = 0; run < RUNS; run += 1) {
      const today = await planActionWithOpenAI(base);
      const brief = await planActionWithOpenAI(
        CONTROL ? { ...base } : { ...base, spokenBrevity: true }
      );
      if (!today || !brief) {
        console.error('  FAIL planner returned nothing');
        continue;
      }

      const written = (today.assistantMessage ?? '').trim();
      const brevity = (brief.assistantMessage ?? '').trim();

      // What the participant would actually hear today, gate and all.
      const classification = classifyUtterance(written);
      const decision = decideVoiceOutput({
        text: written,
        classification,
        settings: GATE,
        visibleLabels: labels,
        screenTitle: turn.stage,
        recentSpoken: [],
        consecutiveCount: 0,
      });
      const heard = decision.spokenText;

      totals.runs += 1;
      totals.writtenChars += written.length;
      totals.heardChars += heard.length;
      totals.brevityChars += brevity.length;
      if (!brevity) totals.brevityEmpty += 1;
      if (decision.mode === 'silent') totals.gateSilenced += 1;
      // `heard !== written` is what makes this a shortening rather than a
      // sentence; `brevity` is never a shortening at all, so it is scored only
      // for symmetry and should be read as "does the planner write like that".
      if (heard && heard !== written && DANGLING_START.test(heard)) totals.heardFragments += 1;
      if (brevity && DANGLING_START.test(brevity)) totals.brevityFragments += 1;
      if (sentenceCount(brevity) > 2) totals.brevityMultiSentence += 1;
      if (today.action.toolName !== brief.action.toolName) {
        totals.toolChanged += 1;
      }

      const askedNow = classifyUtterance(written).hasQuestion;
      if (askedNow) {
        totals.questionsAsked += 1;
        if (classifyUtterance(heard).hasQuestion) totals.questionsKeptByGate += 1;
        if (classifyUtterance(brevity).hasQuestion) totals.questionsKeptByBrevity += 1;
      }

      console.log(
        `  written : "${written}"  [${today.action.toolName || 'none'}] ${written.length}c`
      );
      console.log(
        `  heard   : "${heard}"  [${decision.mode}${decision.rule ? '/' + decision.rule : ''}] ${heard.length}c`
      );
      console.log(
        `  brevity : "${brevity}"  [${brief.action.toolName || 'none'}] ${brevity.length}c`
      );
      if (today.action.toolName !== brief.action.toolName) {
        console.log(
          `  NOTE    : the tool changed (${today.action.toolName} → ${brief.action.toolName})`
        );
      }
      if (askedNow && !classifyUtterance(brevity).hasQuestion) {
        console.log('  REGRESSION: the baseline asked a question and brevity did not');
      }
    }
  }

  const pct = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`runs                          ${totals.runs}`);
  console.log(
    `mean chars  written / heard / brevity   ` +
      `${Math.round(totals.writtenChars / Math.max(1, totals.runs))} / ` +
      `${Math.round(totals.heardChars / Math.max(1, totals.runs))} / ` +
      `${Math.round(totals.brevityChars / Math.max(1, totals.runs))}`
  );
  console.log(
    `questions asked by the baseline        ${totals.questionsAsked}` +
      `   kept by gate ${pct(totals.questionsKeptByGate, totals.questionsAsked)}` +
      `   kept by brevity ${pct(totals.questionsKeptByBrevity, totals.questionsAsked)}`
  );
  console.log(
    `dangling-preposition starts   gate-shortenings ${totals.heardFragments}` +
      `   (planner sentences opening that way: ${totals.brevityFragments})`
  );
  console.log(
    `silence   gate-silenced ${totals.gateSilenced}` +
      `   brevity wrote nothing ${totals.brevityEmpty}`
  );
  console.log(`brevity wrote more than two sentences  ${totals.brevityMultiSentence}`);
  console.log(
    `tool changed (must be 0)               ${totals.toolChanged}` +
      (totals.toolChanged > 0 ? '   <-- the flag is not spoken-channel-only' : '')
  );
}

void main();
