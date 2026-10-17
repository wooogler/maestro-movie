/**
 * Executable check for the LLM trace's independence from the agent monitor:
 *
 *   npx tsx apps/tuning-agent/src/llm/llmTrace.check.ts
 *
 * One claim to defend. The `*.llm-trace.jsonl` file is the research record of
 * every planner and extractor exchange, and it is supposed to exist exactly
 * when the visitor consented. On 2026-10-17 it was found to be silently gated
 * by AGENT_MONITOR_LLM_TRACE as well: the emitters returned before calling any
 * listener, so the study writer in index.ts never heard a thing and a backend
 * started from the .env default (false) produced consented demo sessions with
 * no trace file. The flag now belongs to the monitor alone.
 *
 * So: with the flag false, a subscribed listener must still receive the
 * planner's (and the extractor's) request event. No network is involved —
 * `fetch` is replaced with a stub that refuses, which is enough because the
 * request event is emitted before the first attempt.
 *
 * Exit code 0 means every case passed.
 */

// The emitters used to read the flag at module load, so it has to be in place
// before the modules are imported, hence the dynamic imports below.
process.env.AGENT_MONITOR_LLM_TRACE = 'false';
process.env.AGENT_OPENAI_API_KEY = 'check-only-not-a-real-key';
process.env.AGENT_OPENAI_MAX_ATTEMPTS = '1';
delete process.env.AGENT_ENABLE_OPENAI;

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  throw new Error('llmTrace.check: network refused on purpose');
}) as typeof fetch;

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

interface SeenEvent {
  component?: string;
  type: string;
  payload: unknown;
}

async function main(): Promise<void> {
  const { planActionWithOpenAI, subscribeLlmTrace: subscribePlanner } = await import('./llmPlanner');
  const { extractStructuredPreferences, subscribeLlmTrace: subscribeExtractor } = await import(
    './llmExtractor'
  );

  const seen: SeenEvent[] = [];
  const unsubscribePlanner = subscribePlanner((event) => seen.push(event));
  const unsubscribeExtractor = subscribeExtractor((event) => seen.push(event));

  function requestEvents(component: string): SeenEvent[] {
    return seen.filter((event) => event.component === component && event.type === 'request');
  }

  function headersOf(event: SeenEvent): Record<string, unknown> {
    const payload = event.payload as { headers?: Record<string, unknown> } | null;
    return payload && payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
  }

  console.log('\n1. The planner still reports its request with the monitor flag off');
  let plannerThrew = false;
  try {
    await planActionWithOpenAI({
      history: [],
      availableTools: [{ name: 'respond', parameters: { type: 'object', properties: {} } }],
      workflow: {
        currentStage: 'movie',
        previousStage: null,
        nextStage: 'theater',
        proceedRule: 'Call next only when selectedId exists (current: null).',
        availableToolNames: ['respond'],
      },
      stageMeta: [{ stage: 'movie', goal: 'pick a film', fieldGuide: 'title, genre' }],
    });
  } catch {
    plannerThrew = true;
  }
  check('the stubbed fetch was reached, so the planner really ran', fetchCalls >= 1);
  check('the refused fetch surfaced as an error rather than a silent null', plannerThrew);
  const plannerRequests = requestEvents('planner');
  check('a listener received exactly one planner request event', plannerRequests.length === 1, `got ${plannerRequests.length}`);
  check(
    'the planner also reported the failed attempt',
    seen.some((event) => event.component === 'planner' && event.type === 'error')
  );
  check(
    'the request payload carries no Authorization header',
    plannerRequests.every((event) => !('Authorization' in headersOf(event)) && !('authorization' in headersOf(event)))
  );

  console.log('\n2. The extractor does the same');
  const fetchCallsBeforeExtractor = fetchCalls;
  try {
    await extractStructuredPreferences({
      userMessage: 'something quiet, not a horror film',
      currentStage: 'movie',
      state: null,
      compactUi: null,
      recentDialogue: [],
      existingPreferences: [],
    });
  } catch {
    // expected: the stub refuses, and the extractor rethrows
  }
  check('the stubbed fetch was reached for the extractor too', fetchCalls > fetchCallsBeforeExtractor);
  const extractorRequests = requestEvents('extractor');
  check('a listener received exactly one extractor request event', extractorRequests.length === 1, `got ${extractorRequests.length}`);

  console.log('\n3. Unsubscribing really stops delivery');
  unsubscribePlanner();
  unsubscribeExtractor();
  const seenBefore = seen.length;
  try {
    await planActionWithOpenAI({
      history: [],
      availableTools: [],
      workflow: {
        currentStage: 'movie',
        previousStage: null,
        nextStage: null,
        proceedRule: '',
        availableToolNames: [],
      },
    });
  } catch {
    // expected: the stub refuses
  }
  check('no event reached a listener after unsubscribe', seen.length === seenBefore, `${seen.length - seenBefore} extra`);
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll LLM trace checks passed.');
}, (error) => {
  console.error('llmTrace.check crashed:', error);
  process.exit(1);
});
