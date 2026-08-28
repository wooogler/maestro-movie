/**
 * Regression harness for the preference-extraction prompt.
 *
 *   OPENAI_API_KEY=... npx tsx apps/tuning-agent/src/llm/extractorPrompt.regress.ts
 *
 * The other check scripts in this repo are pure and free to run. This one is
 * not: it replays real turns from the March 2026 study through the CURRENT
 * prompt and makes real API calls, so it is deliberately kept out of
 * `npm run check`. A full run is a couple of dozen requests.
 *
 * Every case is a turn that actually went wrong in the study. The trace files
 * carry the complete extractor input — userMessage, currentStage, state,
 * compactUi, recentDialogue, existingPreferences — so each replay is the exact
 * situation the model faced, with only the prompt changed.
 *
 * Pass `--verbose` to print the full returned list for each case.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { extractStructuredPreferences } from './llmExtractor';
import type { Preference } from '../types';

const VERBOSE = process.argv.includes('--verbose');
const TRACE_DIR = path.resolve(process.cwd(), 'logs/trace');

interface Expectation {
  /** Descriptions that must still be present (substring match, case-insensitive). */
  retained?: string[];
  /** Descriptions that must be gone. */
  dropped?: string[];
  /** A description that must come back at this strength. */
  strength?: { match: string; expect: Preference['strength'] };
}

interface Case {
  name: string;
  why: string;
  trace: string;
  requestId: string;
  expect: Expectation;
}

const CASES: Case[] = [
  {
    name: 'dormant branch — Sunday pivot must not delete the Saturday window',
    why:
      'The scenario imposes a permanent either/or: Saturday 4pm-9pm, or a Sunday morning show. ' +
      'Saying "for Sunday, I require a morning show" made the model retract all three ' +
      'Saturday-scoped hard requirements at once.',
    trace: 'P08-C4-S2-hard-20260326-111413.llm-trace.jsonl',
    requestId: 'preferences-8',
    expect: {
      retained: ['starts at or after 4:00 PM', 'ends before 9:00 PM'],
    },
  },
  {
    name: 'collateral loss — a new time constraint must not clear the movie requirement',
    why:
      'The user narrowed the showtime and the model returned a list missing four unrelated ' +
      'entries, including the hard "Needs an action movie" and "Can only do Saturday".',
    trace: 'P04-C4-S1-hard-20260325-163844.llm-trace.jsonl',
    requestId: 'preferences-6',
    expect: {
      retained: ['action movie'],
    },
  },
  {
    name: 'strength — a concrete time window is hard whatever verb introduces it',
    why:
      'One utterance carries two structurally identical date-scoped windows: "14th works best ' +
      'between 7-10 PM" and "15th ... needs to end by 6 PM". The old cue list put "want"/"works ' +
      'best" in the soft column, so the model split them on the verb alone and the 7-10 PM ' +
      'window was stored soft — which routes it to sort/highlight instead of filter, leaving ' +
      'violating options on screen and clickable.',
    trace: 'P10-C2-S3-easy-20260326-131236.llm-trace.jsonl',
    requestId: 'preferences-6',
    expect: {
      strength: { match: 'between 7', expect: 'hard' },
    },
  },
  {
    name: 'date switch — the old date preference may go, the rest may not',
    why:
      'Choosing Sunday legitimately replaces "Wants to go on Saturday". Nothing else should ' +
      'move. This case guards against the fix over-correcting into never retracting anything.',
    trace: 'P03-C4-S2-hard-20260325-125809.llm-trace.jsonl',
    requestId: 'preferences-8',
    expect: {},
  },
];

interface ReplayInput {
  userMessage: string;
  currentStage: string;
  state: Record<string, unknown> | null;
  compactUi: unknown;
  recentDialogue: Array<{ type: 'user' | 'agent'; text: string }>;
  existingPreferences: Array<{
    description: string;
    strength: Preference['strength'];
    relevantStages: Preference['relevantStages'];
  }>;
}

/** Streams one trace file and returns the extractor input for a request id. */
async function loadTurn(trace: string, requestId: string): Promise<ReplayInput | null> {
  const filePath = path.join(TRACE_DIR, trace);
  if (!fs.existsSync(filePath)) return null;
  const stream = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of stream) {
      if (!line.includes(requestId)) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type !== 'llm.extractor.request') continue;
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload || payload.requestId !== requestId) continue;
      const body = payload.body as { input?: Array<{ content?: unknown }> } | undefined;
      for (const message of body?.input ?? []) {
        const content = message.content;
        if (typeof content !== 'string' || !content.trim().startsWith('{')) continue;
        try {
          return JSON.parse(content) as ReplayInput;
        } catch {
          return null;
        }
      }
    }
  } finally {
    stream.close();
  }
  return null;
}

function has(list: Preference[], needle: string): Preference | undefined {
  const target = needle.toLowerCase();
  return list.find((item) => item.description.toLowerCase().includes(target));
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY?.trim() && !process.env.AGENT_OPENAI_API_KEY?.trim()) {
    console.error(
      'No OpenAI key in the environment. This harness makes real API calls:\n' +
        '  OPENAI_API_KEY=... npx tsx apps/tuning-agent/src/llm/extractorPrompt.regress.ts'
    );
    process.exit(2);
  }

  let failures = 0;
  let skipped = 0;

  for (const testCase of CASES) {
    console.log(`\n${testCase.name}`);
    console.log(`  ${testCase.why}`);

    const turn = await loadTurn(testCase.trace, testCase.requestId);
    if (!turn) {
      console.log(`  SKIP  could not load ${testCase.trace} ${testCase.requestId}`);
      skipped += 1;
      continue;
    }

    console.log(`  user: "${turn.userMessage}"`);
    console.log(`  memory in: ${turn.existingPreferences.length} preferences`);

    let result: Preference[];
    try {
      result = await extractStructuredPreferences({
        userMessage: turn.userMessage,
        currentStage: turn.currentStage,
        state: turn.state ?? null,
        compactUi: turn.compactUi,
        recentDialogue: turn.recentDialogue ?? [],
        existingPreferences: turn.existingPreferences.map((item) => ({
          // The id is derived from the description, so rebuilding it here
          // reproduces what the agent would have held in memory.
          id: '',
          ...item,
        })) as Preference[],
      });
    } catch (error) {
      console.error(`  FAIL  extraction threw: ${error instanceof Error ? error.message : error}`);
      failures += 1;
      continue;
    }

    console.log(`  memory out: ${result.length} preferences`);
    if (VERBOSE) {
      for (const item of result) console.log(`    [${item.strength}] ${item.description}`);
    }

    for (const needle of testCase.expect.retained ?? []) {
      const found = has(result, needle);
      if (found) {
        console.log(`  ok    retained "${needle}" → [${found.strength}] ${found.description}`);
      } else {
        console.error(`  FAIL  lost "${needle}"`);
        failures += 1;
      }
    }
    for (const needle of testCase.expect.dropped ?? []) {
      if (has(result, needle)) {
        console.error(`  FAIL  "${needle}" should have been retracted`);
        failures += 1;
      } else {
        console.log(`  ok    retracted "${needle}"`);
      }
    }
    if (testCase.expect.strength) {
      const { match, expect } = testCase.expect.strength;
      const found = has(result, match);
      if (!found) {
        console.error(`  FAIL  "${match}" missing, cannot check strength`);
        failures += 1;
      } else if (found.strength !== expect) {
        console.error(`  FAIL  "${match}" is ${found.strength}, expected ${expect}`);
        failures += 1;
      } else {
        console.log(`  ok    "${match}" is ${expect}`);
      }
    }

    // Always report collateral loss, even where the case does not assert on it.
    const lost = turn.existingPreferences.filter(
      (item) => !has(result, item.description.replace(/\.$/, ''))
    );
    if (lost.length > 0) {
      console.log('  note: entries not returned this turn —');
      for (const item of lost) console.log(`        [${item.strength}] ${item.description}`);
    }
  }

  console.log(
    failures === 0
      ? `\nAll extractor-prompt regressions passed${skipped ? ` (${skipped} skipped)` : ''}.`
      : `\n${failures} extractor-prompt regression(s) FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
