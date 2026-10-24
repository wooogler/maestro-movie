#!/usr/bin/env node
// Play a printed demo card against the running dev stack, as a visitor would,
// and print what the agent did with it.
//
// The booth's cards are scripts: a visitor reads a line, the agent answers and
// rearranges the GUI, the visitor reads the next. Whether the booking then
// lands where the card promises is a property of the live planner, which is
// stochastic, so the only way to know is to play the card — repeatedly — and
// read back every tool call. This does that in the SERVER's Chromium (the same
// CDP-over-`ws` route as scripts/drive.mjs; no playwright).
//
//   node scripts/simulate-cards.mjs A --voice --code=ABC123      # card A, Korean, as at the booth
//   node scripts/simulate-cards.mjs B --code=ABC123              # voice off (text-mode planner)
//   node scripts/simulate-cards.mjs seat --voice --code=ABC123   # quick card 5 (/demo/card)
//   node scripts/simulate-cards.mjs C --voice --code=ABC123 --lang=en --json=/tmp/c.json
//
// Run from a worktree against the main checkout's stack, point it at the trace
// directory the stack writes to: DEMO_TRACE_DIR=<main checkout>/logs/demo/trace.
// docs/scenarios/ksea2026-korean-simulation.md is the report these runs made.
//
// Cards: A (오늘 밤), B (IMAX 밤), C (가족 낮 상영), and the five quick cards by
// id — movie, theater, date, time, seat — whose lines are read straight out of
// apps/frontend/src/study/quickDemoCards.ts so they cannot drift from print.
//
// The code is a demo access code (`npm run codes:generate -- --batch <name>`
// against a backend with DEMO_ACCESS_CODES_ENABLED=true); pass it with --code=
// or DEMO_ACCESS_CODE. A full card starts at `/` with no preset memory and the
// consent box left ticked, so its planner trace lands in logs/demo/trace/ and
// is named in the output. A quick card is never recorded (DemoCardPage sends
// researchConsent:false), so for those the tool calls come only from the relay
// frames, which are captured for every card either way. Every run finishes its
// session on the way out: an abandoned one holds a slot of
// DEMO_MAX_CONCURRENT_SESSIONS for the 15-minute idle timeout, and a handful of
// back-to-back runs is enough to fill it.
//
// How the visitor "speaks": the demo composer is read-only whenever voice is
// available (ChatInput's isVoiceComposer) — voice on or off — so there is no
// textbox to type in. Each line goes in through ChatInput's own `onSubmit`
// prop, reached through the React fiber: handleChatInputSubmit →
// submitChatInput, the same funnel a voice transcript ends in. The source tag
// never reaches the agent, so a line put in this way is exactly a perfect
// transcript: this measures the planner on the card's own words, not the
// speech recogniser.
//
// Voice off (the default) vs --voice: they are NOT the same planner. With
// voice on, the demo sends `spokenBrevity` (ChatPage's plannerWritesForTheEar)
// and the planner writes for the ear — shorter, and silent where the screen
// says it all; with voice off it narrates every step, and an empty narration
// falls back to "I will run <tool> next. Reason: …" in English. The booth runs
// with voice on, so --voice is the run that predicts the booth. It keeps the
// voice session up on a fake microphone fed from a silent WAV (a real one
// would put words in the visitor's mouth: Chromium's default fake mic beeps,
// and the recogniser hears "네."), so the Realtime voice really speaks each
// reply and the run waits for every playback to finish, as the agent does.
//
// When each line is said: a full card's line waits until the GUI has reached
// the stage it belongs to (FULL_CARDS[].stages — "when the stage calls for
// it"); --eager reads the card straight through instead. In between, and once
// the card runs out, the visitor answers what the agent asks the way a
// cooperative visitor would (FOLLOWUPS: a pick for a which-one question, "you
// choose" on the seat map, a yes to anything else), at most --max-followups
// times (default 8 for a full card, 0 for a quick card, whose whole job is one
// sentence). Those turns are marked as follow-ups: they are the driver's
// words, not the card's.
//
// Other flags: --turn-timeout= (ms per turn before giving up, default 90000),
// --settle= (ms of relay silence that counts as "the agent is waiting" when
// the agent sends no status, default 4000), --size=WxH (default 1280x900),
// --json= (the whole run, frames included), --shot= (final screenshot).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROMIUM = process.env.CHROMIUM_BIN || '/usr/bin/chromium-browser';
const HOST = process.env.FRONTEND_HOST || '127.0.0.1';
const PORT = Number(process.env.FRONTEND_PORT || 5173);
const ORIGIN = `http://${HOST}:${PORT}`;
// The running stack writes traces relative to ITS checkout, which need not be
// this one (a worktree drives the main checkout's dev server).
const TRACE_DIR = process.env.DEMO_TRACE_DIR || path.join(ROOT, 'logs/demo/trace');

const flag = (name, fallback) => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const cardId = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const lang = flag('lang', 'ko');
const code = flag('code', process.env.DEMO_ACCESS_CODE ?? '');
const maxFollowupsFlag = flag('max-followups', null);
const turnTimeout = Number(flag('turn-timeout', '90000'));
const settleMs = Number(flag('settle', '4000'));
const [width, height] = flag('size', '1280x900').split('x').map(Number);
const jsonOut = flag('json', null);
const voice = process.argv.includes('--voice');
const eager = process.argv.includes('--eager');
const STAGE_ORDER = ['movie', 'theater', 'date', 'time', 'seat', 'confirm'];
const shotOut = flag('shot', null);

// =============================================================================
// The cards
// =============================================================================

// The three full cards, line for line as printed. English is here so the same
// run can be made as a control; the Korean lines are the ones under test.
// `stages` says when the presenter prompts each line: it is said once the GUI
// has reached that stage ("when the stage calls for it"), and until then the
// visitor only answers what the agent asks (FOLLOWUPS). --eager instead reads
// the whole card in a row, the way a visitor who ignores the presenter would.
const FULL_CARDS = {
  A: {
    stages: ['movie', 'theater', 'time', 'seat'],
    title: '오늘 밤 (Tonight)',
    lines: {
      ko: [
        '오늘 밤에 클라라와 태양 보고 싶어요. 다운타운에서 가까운 곳으로요.',
        '15마일 넘는 데는 안 돼요.',
        '8시 이후에 시작해야 하고, 자정 전에는 돌아와야 해요.',
        '한 자리만요. 가운데쯤으로, 앞줄은 말고요.',
      ],
      en: [
        "I'd like to see Klara and the Sun tonight, somewhere close to downtown.",
        'Nothing more than 15 miles away.',
        'It has to start after 8, and I need to be home before midnight.',
        'Just one seat. Somewhere in the middle, not the front rows.',
      ],
    },
  },
  B: {
    stages: ['movie', 'theater', 'time', 'seat'],
    title: 'IMAX 밤 (IMAX night)',
    lines: {
      ko: [
        '공저자랑 같이 목요일 밤에 스트리트 파이터를 IMAX로 보려고요.',
        '15마일 넘게는 운전 안 할 거예요.',
        '6시 반 이후에 시작해서 11시까지는 끝나야 해요.',
        '두 자리 붙어서요. 앞줄은 말고요.',
      ],
      en: [
        "My co-author and I want to see Street Fighter in IMAX on Thursday night.",
        "I won't drive more than 15 miles.",
        'It should start after 6:30 and be over by 11.',
        'Two seats together. Not the front rows.',
      ],
    },
  },
  C: {
    stages: ['movie', 'movie', 'time', 'seat'],
    title: '가족 낮 상영 (Family matinee)',
    lines: {
      ko: [
        '목요일 오후에 아이 둘 데리고 영화 보러 가려고요.',
        'PG 이하여야 하고, 짧을수록 좋아요.',
        '비행기 때문에 5시까지는 나와야 해요.',
        '세 자리 붙어서요. 앞줄은 말고요.',
      ],
      en: [
        "I'm taking my two kids to a movie on Thursday afternoon.",
        'It has to be PG or under, and the shorter the better.',
        'I have a flight, so we need to be out by 5.',
        'Three seats together. Not the front rows.',
      ],
    },
  },
};

const QUICK_IDS = ['movie', 'theater', 'date', 'time', 'seat'];

// What the visitor says between card lines, keyed on the agent's last
// sentence: a which-one question gets a pick (on the seat map, "you choose" —
// "the first one" means nothing there), anything else gets a yes. Only a
// QUESTION word counts: "선택할 수 없어요" is not asking for a pick.
const FOLLOWUPS = {
  ko: { choice: /어느|어떤|몇 시|몇시|어디/, pick: '첫 번째 걸로 할게요.', seat: '추천해 주시는 자리로 할게요.', yes: '네, 좋아요.' },
  en: { choice: /\bwhich\b|\bwhat time\b|\bwhere\b/i, pick: 'The first one, please.', seat: 'Whichever seats you recommend.', yes: 'Yes, sounds good.' },
};

// The quick-card lines live in a TypeScript module that also pulls in the i18n
// barrel, so rather than transpile it, read the one string out of its source.
function quickCardLine(id, language) {
  const source = fs.readFileSync(path.join(ROOT, 'apps/frontend/src/study/quickDemoCards.ts'), 'utf8');
  const block = source.split(/\n  \{\n    id: '/).find((chunk) => chunk.startsWith(`${id}'`));
  const opener = block?.split(/\n    opener: \{/)[1]?.split(/\n    \},/)[0];
  const quoted = opener?.match(new RegExp(`\\n\\s+${language === 'en' ? 'en' : `'?${language}'?`}: (['"])(.*)\\1,`));
  if (!quoted) throw new Error(`no ${language} opener for quick card "${id}" in quickDemoCards.ts`);
  return quoted[2].replace(/\\'/g, "'");
}

// Button labels the run clicks, from apps/frontend/src/i18n/strings.ts. Only
// the two languages the cards were written for.
const LABELS = {
  ko: { start: '데모 시작', blank: '빈 상태로 시작', go: '예매 시작하기', voiceOff: '음성 모드 끄기', quickStart: '시작하고 말하기' },
  en: { start: 'Start Demo', blank: 'Start empty', go: 'Start booking', voiceOff: 'Turn off voice mode', quickStart: 'Start and talk' },
};

// =============================================================================
// Chromium over CDP
// =============================================================================

async function launchBrowser() {
  const debugPort = 9500 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'simulate-cards-'));
  // Without --voice, no media device at all: Chromium's fake mic plays a beep,
  // and the realtime recogniser hears it as a word ("네.") nobody said.
  const extraFlags = (process.env.CHROMIUM_EXTRA_FLAGS ?? '').split(' ').filter(Boolean);
  if (voice) {
    const silence = path.join(profile, 'silence.wav');
    fs.writeFileSync(silence, silentWav(5));
    extraFlags.push(
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', `--use-file-for-fake-audio-capture=${silence}`
    );
  }
  const child = spawn(
    CHROMIUM,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`, ...extraFlags, 'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  child.stderr.on('data', () => {});
  const close = () => {
    child.kill('SIGKILL');
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // Chromium still writing as it dies; a stray temp dir is harmless.
    }
  };

  for (let attempt = 0; ; attempt += 1) {
    const open = await new Promise((resolve) => {
      const probe = net.connect(debugPort, '127.0.0.1');
      probe.on('connect', () => { probe.end(); resolve(true); });
      probe.on('error', () => resolve(false));
    });
    if (open) break;
    if (attempt > 100) { close(); throw new Error('Chromium never opened its debug port'); }
    await sleep(200);
  }

  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = targets.find((entry) => entry.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject); });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = (nextId += 1);
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, listener) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(listener);
  };
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const failure = reply.result?.exceptionDetails;
    if (failure) throw new Error(failure.exception?.description ?? failure.text ?? 'evaluate failed');
    return reply.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });

  return {
    send, on, evaluate, close: () => { socket.close(); close(); },
    navigate: (url) => send('Page.navigate', { url }),
    screenshot: async (file) => {
      const reply = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(reply.result.data, 'base64'));
    },
  };
}

/** `seconds` of 16-bit 48 kHz stereo silence, the format Chromium's fake mic reads. */
function silentWav(seconds) {
  const rate = 48000;
  const channels = 2;
  const data = rate * channels * 2 * seconds;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.alloc(data)]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function click(browser, label) {
  const result = await browser.evaluate(`(() => {
    const needle = ${JSON.stringify(label)};
    const el = [...document.querySelectorAll('button, a, label')]
      .find((node) => (node.textContent || '').includes(needle) || node.getAttribute('aria-label') === needle);
    if (!el) return 'NOT FOUND';
    if (el.disabled) return 'DISABLED';
    el.click();
    return 'ok';
  })()`);
  if (result !== 'ok') throw new Error(`click "${label}": ${result}`);
}

async function waitFor(browser, expression, timeoutMs, what) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await browser.evaluate(expression).catch(() => false)) return;
    await sleep(250);
  }
  const screen = await browser.evaluate('document.body.innerText.replace(/\\n+/g, " | ").slice(0, 600)').catch(() => '');
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; screen: ${screen}`);
}

/*
  The line goes in through ChatInput's own onSubmit prop. In the demo the
  composer is a voice transcript display (readOnly, and its handleSubmit returns
  early while voice is available), so there is no DOM route to a typed message;
  the prop is the same handleChatInputSubmit → submitChatInput(text, 'text')
  that a non-voice build's Enter key reaches.
*/
async function say(browser, text) {
  const result = await browser.evaluate(`((text) => {
    const textarea = document.querySelector('textarea');
    if (!textarea) return 'no composer';
    const key = Object.keys(textarea).find((k) => k.startsWith('__reactFiber'));
    let fiber = textarea[key];
    while (fiber && !(fiber.memoizedProps && typeof fiber.memoizedProps.onSubmit === 'function'
      && 'voiceModeAvailable' in fiber.memoizedProps)) fiber = fiber.return;
    if (!fiber) return 'no ChatInput above the composer';
    if (fiber.memoizedProps.disabled) return 'composer disabled';
    fiber.memoizedProps.onSubmit(text);
    return 'ok';
  })(${JSON.stringify(text)})`);
  if (result !== 'ok') throw new Error(`could not submit "${text}": ${result}`);
}

// =============================================================================
// Relay frames: what the agent actually sent the GUI
// =============================================================================

function watchRelay(browser) {
  const frames = [];
  const sockets = new Map();
  browser.on('Network.webSocketCreated', ({ requestId, url }) => sockets.set(requestId, url));
  const record = (direction) => ({ requestId, timestamp, response }) => {
    if (!String(sockets.get(requestId) ?? '').includes('/agent/ws')) return;
    let data;
    try {
      data = JSON.parse(response.payloadData);
    } catch {
      return;
    }
    frames.push({ at: Date.now(), cdpTime: timestamp, direction, data });
  };
  browser.on('Network.webSocketFrameReceived', record('in'));
  browser.on('Network.webSocketFrameSent', record('out'));
  return frames;
}

/** A compact one-line rendering of an agent→GUI frame, or null for noise. */
function describeFrame(frame) {
  const { data } = frame;
  const type = data?.type ?? '';
  const payload = data?.payload ?? data?.data ?? {};
  if (type === 'tool.call') {
    const name = payload.toolName ?? payload.name ?? '?';
    const params = payload.params ?? payload.arguments ?? {};
    return `tool ${name} ${JSON.stringify(params)}`;
  }
  if (type === 'agent.message') return `say "${payload.text ?? payload.message ?? ''}"`;
  return null;
}

// =============================================================================
// Planner trace (full cards only, consent on)
// =============================================================================

function readTrace(sessionId) {
  if (!sessionId || !fs.existsSync(TRACE_DIR)) return { file: null, events: [] };
  const name = fs.readdirSync(TRACE_DIR).find((entry) => entry.includes(sessionId) && entry.endsWith('.llm-trace.jsonl'));
  if (!name) return { file: null, events: [] };
  const file = path.join(TRACE_DIR, name);
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { file, events };
}

function plannerSteps(events, fromMs, toMs) {
  return events
    .filter((event) => event.type === 'llm.planner.response.parsed')
    .map((event) => ({ at: Date.parse(event.timestamp), ...event.payload.parsed }))
    .filter((step) => step.at >= fromMs && step.at <= toMs)
    .map((step) => ({
      at: step.at,
      tool: step.action?.type === 'tool.call' ? step.action.toolName : 'respond',
      params: step.action?.params ?? {},
      reason: step.action?.reason ?? '',
      message: step.assistantMessage ?? '',
    }));
}

/** What the agent last saw: the workflow block of the newest planner request. */
function lastWorkflow(events, toMs) {
  const requests = events.filter((event) => event.type === 'llm.planner.request' && Date.parse(event.timestamp) <= toMs);
  const last = requests.at(-1);
  if (!last) return null;
  try {
    const content = last.payload.body.input.at(-1).content;
    const parsed = JSON.parse(typeof content === 'string' ? content : content[0].text);
    return { workflow: parsed.workflow, memory: parsed.memory };
  } catch {
    return null;
  }
}

// =============================================================================
// The run
// =============================================================================

async function waitForAgentTurn(browser, frames, since) {
  /*
    "The agent is done" means: it has spoken since the visitor did, its last
    `agent.status` says idle, and the relay has then been quiet for a moment.
    The status alone is not enough — it flips to idle between a tool call and
    the planner round trip that follows it — so the quiet window is what
    separates "between steps" from "waiting for you". A turn with no settled
    reply inside the timeout is a stall and is reported as one.
  */
  const start = Date.now();
  while (Date.now() - start < turnTimeout) {
    const inbound = frames.filter((frame) => frame.at >= since && frame.direction === 'in');
    const spoke = inbound.some((frame) => frame.data.type === 'agent.message');
    const statuses = inbound.filter((frame) => frame.data.type === 'agent.status');
    const idle = statuses.length === 0 || statuses.at(-1).data.payload?.phase === 'idle';
    const lastAt = inbound.at(-1)?.at ?? 0;
    const quiet = Date.now() - lastAt >= (statuses.length ? 2500 : settleMs);
    // With voice on, also every sentence has finished playing: the agent holds
    // its next step until it has, so "quiet" mid-sentence is not "done".
    const said = inbound.filter((frame) => frame.data.type === 'agent.message').length;
    const played = frames.filter((frame) => frame.at >= since && frame.direction === 'out' && frame.data.type === 'tts.playback.complete').length;
    const heard = !voice || played >= said;
    if (spoke && idle && quiet && heard) return { stalled: false };
    // Confirming the booking ends the conversation without a closing sentence.
    if (idle && quiet && (await readGui(browser)).done) return { stalled: false };
    await sleep(300);
  }
  return { stalled: true };
}

/** The GUI as the frontend last reported it to the agent (tool.result / snapshot.state). */
function lastUiSpec(frames, toMs = Infinity) {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i];
    if (frame.at > toMs || frame.direction !== 'out') continue;
    const spec = frame.data?.payload?.uiSpec ?? (frame.data?.type === 'snapshot.state' ? frame.data.payload?.uiSpec ?? frame.data.payload : null);
    if (spec && spec.stage) return spec;
  }
  return null;
}

/** The parts of a UI spec a card's promise is about. */
function summariseSpec(spec) {
  if (!spec) return null;
  const workflow = spec.state?.workflow ?? {};
  const label = (entry) => (entry && typeof entry === 'object' ? entry.value ?? entry.title ?? entry.id : entry);
  return {
    stage: spec.stage,
    visible: (spec.visibleItems ?? []).map(label),
    highlighted: (spec.state?.highlighted ?? []).map(label),
    selected: label(spec.state?.selected ?? spec.state?.selectedItem ?? null) ?? null,
    workflow: Object.fromEntries(Object.entries(workflow).map(([stage, value]) => [stage, label(value)])),
  };
}

function lastMemory(frames) {
  const memory = frames.filter((frame) => frame.direction === 'in' && frame.data.type === 'agent.memory').at(-1);
  return memory?.data.payload ?? null;
}

async function readGui(browser) {
  return browser.evaluate(`(() => {
    const text = document.body.innerText;
    const done = /예매가 확정되었습니다|Booking Confirmed!/.test(text) || location.pathname === '/end';
    return { url: location.pathname, done, text: text.replace(/\\n+/g, ' | ').slice(0, 4000) };
  })()`);
}

async function main() {
  if (!cardId) throw new Error('usage: simulate-cards.mjs <A|B|C|movie|theater|date|time|seat> --code=XXXXXX [--lang=ko]');
  if (!code) throw new Error('no access code: pass --code= or set DEMO_ACCESS_CODE');
  if (!LABELS[lang]) throw new Error(`--lang must be one of ${Object.keys(LABELS).join(', ')}`);
  const labels = LABELS[lang];
  const full = FULL_CARDS[cardId.toUpperCase()];
  const quick = QUICK_IDS.includes(cardId);
  if (!full && !quick) throw new Error(`unknown card "${cardId}"`);
  const lines = full ? full.lines[lang] : [quickCardLine(cardId, lang)];
  const maxFollowups = Number(maxFollowupsFlag ?? (full ? 8 : 0));

  const browser = await launchBrowser();
  const frames = watchRelay(browser);
  const report = { card: cardId, lang, startedAt: new Date().toISOString(), turns: [] };
  try {
    if (full) {
      await browser.navigate(`${ORIGIN}/?lang=${lang}`);
      await waitFor(browser, `!!document.body && document.body.innerText.includes(${JSON.stringify(labels.start)})`, 20000, 'start page');
      // The code goes where the credential dialog would have saved it.
      await browser.evaluate(`localStorage.setItem('tuning-movie-demo-access-code', ${JSON.stringify(code)})`);
      await browser.navigate(`${ORIGIN}/?lang=${lang}`);
      await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(labels.blank)})`, 20000, 'start page reload');
      await click(browser, labels.blank);
      await sleep(300);
      await click(browser, labels.start);
      await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(labels.go)})`, 45000, 'pairing screen');
      await click(browser, labels.go);
    } else {
      await browser.navigate(`${ORIGIN}/demo/card#c=${cardId}&k=${code}&lang=${lang}`);
      await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(labels.quickStart)})`, 20000, 'quick card');
      report.cardPage = (await readGui(browser)).text;
      await click(browser, labels.quickStart);
    }

    await waitFor(browser, `location.pathname === '/booking' && !!document.querySelector('textarea')`, 30000, 'booking page');
    const opened = Date.now();
    // The opening question, before anything is said.
    await waitForAgentTurn(browser, frames, opened - 1000);
    if (!voice) {
      await browser.evaluate(`document.querySelector('[aria-label=${JSON.stringify(labels.voiceOff)}]')?.click()`);
      await sleep(1000);
    }
    report.voice = voice;
    const session = await browser.evaluate(`(() => {
      try { return JSON.parse(localStorage.getItem('tuning-movie-study-session') || 'null'); } catch { return null; }
    })()`);
    report.sessionId = session?.sessionId ?? null;
    report.opening = frames.filter((frame) => frame.direction === 'in').map(describeFrame).filter(Boolean);
    console.log(`[sim] card ${cardId} (${lang}, voice ${voice ? 'on' : 'off'}) session ${report.sessionId}`);
    for (const line of report.opening) console.log(`      agent  ${line}`);

    const cardLines = lines.map((text, index) => ({ text, stage: full ? full.stages[index] : null }));
    let followups = 0;
    let lastReply = report.opening.filter((line) => line.startsWith('say ')).at(-1) ?? '';
    for (;;) {
      const stageNow = lastUiSpec(frames)?.stage ?? 'movie';
      const due = cardLines[0] && (eager || !cardLines[0].stage
        || STAGE_ORDER.indexOf(stageNow) >= STAGE_ORDER.indexOf(cardLines[0].stage));
      let text;
      let kind;
      if (due) {
        ({ text } = cardLines.shift());
        kind = 'card';
      } else if (followups < maxFollowups && (cardLines.length > 0 || report.turns.length > 0)) {
        followups += 1;
        const policy = FOLLOWUPS[lang];
        text = !policy.choice.test(lastReply) ? policy.yes : stageNow === 'seat' ? policy.seat : policy.pick;
        kind = 'followup';
      } else {
        break;
      }
      const before = await readGui(browser);
      if (before.done) break;
      const sentAt = Date.now();
      await say(browser, text);
      console.log(`\n[sim] visitor${kind === 'card' ? '' : ' (follow-up)'}: ${text}`);
      const { stalled } = await waitForAgentTurn(browser, frames, sentAt);
      const turnFrames = frames.filter((frame) => frame.at >= sentAt && frame.direction === 'in');
      const actions = turnFrames.map((frame) => ({ ms: frame.at - sentAt, line: describeFrame(frame) })).filter((a) => a.line);
      const firstSay = turnFrames.find((frame) => frame.data.type === 'agent.message');
      const gui = await readGui(browser);
      const spec = lastUiSpec(frames);
      const turn = {
        kind, visitor: text, stalled,
        replies: turnFrames.filter((frame) => frame.data.type === 'agent.message').map((frame) => frame.data.payload?.text ?? ''),
        view: summariseSpec(spec),
        secondsToFirstReply: firstSay ? (firstSay.at - sentAt) / 1000 : null,
        secondsToSettle: actions.length ? actions.at(-1).ms / 1000 : null,
        actions, done: gui.done, url: gui.url, sentAt,
      };
      report.turns.push(turn);
      for (const action of actions) console.log(`      +${(action.ms / 1000).toFixed(1)}s ${action.line}`);
      if (turn.view) console.log(`      = ${turn.view.stage}: ${turn.view.visible.length} shown${turn.view.highlighted.length ? `, ${turn.view.highlighted.length} lit` : ''}${turn.view.selected ? `, selected ${turn.view.selected}` : ''}`);
      if (stalled) console.log(`      !! no settled reply within ${turnTimeout} ms`);
      if (gui.done) { console.log('      ** booking complete'); break; }
      if (stalled) break;
      lastReply = turn.replies.at(-1) ?? lastReply;
    }

    const final = await readGui(browser);
    report.final = final;
    report.finalView = summariseSpec(lastUiSpec(frames));
    report.memory = lastMemory(frames);
    report.frames = frames.map((frame) => ({ at: frame.at, direction: frame.direction, data: frame.data }));
    if (shotOut) await browser.screenshot(shotOut);

    // The trace is flushed by the agent process, a moment after the frame.
    await sleep(1500);
    const trace = readTrace(report.sessionId);
    report.traceFile = trace.file;
    if (trace.events.length) {
      for (const turn of report.turns) {
        const next = report.turns[report.turns.indexOf(turn) + 1]?.sentAt ?? Date.now();
        turn.planner = plannerSteps(trace.events, turn.sentAt, next);
      }
      report.lastSeen = lastWorkflow(trace.events, Date.now());
    }
    console.log(`\n[sim] final ${final.url} done=${final.done}`);
    if (report.finalView) {
      console.log(`[sim] view ${report.finalView.stage}: ${JSON.stringify(report.finalView.visible)}`);
      if (report.finalView.highlighted.length) console.log(`[sim] lit ${JSON.stringify(report.finalView.highlighted)}`);
      console.log(`[sim] selections ${JSON.stringify(report.finalView.workflow)}`);
    }
    console.log(`[sim] memory ${JSON.stringify(report.memory?.preferences?.map((p) => `${p.strength}: ${p.description}`) ?? [])}`);
    console.log(`[sim] trace ${report.traceFile ?? '(none — quick cards are not recorded)'}`);
    console.log(`[sim] screen ${final.text.slice(0, 1500)}`);
  } finally {
    /*
      End the session on the server. A demo session otherwise stays "active"
      until its 15-minute idle timeout, and the backend caps concurrent demo
      sessions (DEMO_MAX_CONCURRENT_SESSIONS) — a few back-to-back runs fill it
      and the next start page just sits there.
    */
    report.finished = await browser.evaluate(`(async () => {
      const session = JSON.parse(localStorage.getItem('tuning-movie-study-session') || 'null');
      if (!session?.studyToken) return 'no session';
      const response = await fetch('/study/sessions/finish', {
        method: 'POST', headers: { 'x-study-session-token': session.studyToken },
      });
      return response.status;
    })()`).catch((error) => String(error));
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    browser.close();
  }
}

main().catch((error) => {
  console.error(`[sim] ${error.message}`);
  process.exit(1);
});
