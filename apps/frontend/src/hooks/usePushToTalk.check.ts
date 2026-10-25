/**
 * Executable check for push-to-talk's pure parts: the key-event filter, the
 * transcript gate and the press → commit → transcript state machine. No test
 * runner is configured in this repo, so this is a plain script:
 *
 *   npx tsx apps/frontend/src/hooks/usePushToTalk.check.ts
 *
 * The browser half (the window listener, the mic track, the Realtime events)
 * was verified with a fake mic in headless Chromium; see
 * docs/scenarios/booth-ptt-setup.md. Exit code 0 means every case passed.
 */
import {
  DEFAULT_PTT_KEY_CODE,
  PTT_MIN_PRESS_MS,
  PTT_RELEASE_TAIL_MS,
  PTT_TRANSCRIPT_TIMEOUT_MS,
  PttMachine,
  classifyPttKeyEvent,
  isTypingTarget,
  normalizePttKeyCode,
  pttTranscriptToDeliver,
  type PttEffect,
  type PttKeyEventLike,
} from '../voice/pushToTalk';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const BODY = { tagName: 'BODY' };
const BUTTON = { tagName: 'BUTTON' };
const COMPOSER_VOICE = { tagName: 'TEXTAREA', readOnly: true };
const COMPOSER_TYPING = { tagName: 'TEXTAREA', readOnly: false };

function key(type: 'keydown' | 'keyup', code: string, extra: Partial<PttKeyEventLike> = {}): PttKeyEventLike {
  return { type, code, target: BODY, ...extra };
}

const types = (effects: PttEffect[]) => effects.map((effect) => effect.type).join(',');
const statusOf = (effects: PttEffect[]) =>
  effects.filter((effect): effect is Extract<PttEffect, { type: 'status' }> => effect.type === 'status').at(-1)?.status;
const commits = (effects: PttEffect[]) =>
  effects.filter((effect): effect is Extract<PttEffect, { type: 'commit' }> => effect.type === 'commit');

// -----------------------------------------------------------------------------
section('1. key codes');
// -----------------------------------------------------------------------------
check('default is Space', DEFAULT_PTT_KEY_CODE === 'Space' && normalizePttKeyCode(undefined) === 'Space');
check('F13 and ControlLeft survive', normalizePttKeyCode('F13') === 'F13' && normalizePttKeyCode(' ControlLeft ') === 'ControlLeft');
check(
  'junk falls back to Space',
  ['', ' ', 'a', 'Ctrl+Space', '<script>', 42].every((value) => normalizePttKeyCode(value) === 'Space')
);

// -----------------------------------------------------------------------------
section('2. key-event filtering');
// -----------------------------------------------------------------------------
check('a fresh Space down presses', classifyPttKeyEvent(key('keydown', 'Space'), 'Space', 'up') === 'press');
check('its key-up releases', classifyPttKeyEvent(key('keyup', 'Space'), 'Space', 'down') === 'release');
check('another key is ignored', classifyPttKeyEvent(key('keydown', 'KeyA'), 'Space', 'up') === 'ignore');
check(
  'auto-repeat while held is swallowed, never a second press',
  classifyPttKeyEvent(key('keydown', 'Space', { repeat: true }), 'Space', 'down') === 'swallow'
);
check(
  'auto-repeat with no live press (key held across a reconnect or blur) is swallowed, not a press',
  classifyPttKeyEvent(key('keydown', 'Space', { repeat: true }), 'Space', 'up') === 'swallow'
);
check(
  'the key-up of a press already ended by blur / the hold cap is swallowed',
  classifyPttKeyEvent(key('keyup', 'Space'), 'Space', 'stale') === 'swallow'
);
check(
  'a focused button still has its Space swallowed (no click, no scroll)',
  classifyPttKeyEvent(key('keydown', 'Space', { target: BUTTON }), 'Space', 'up') === 'press' &&
    classifyPttKeyEvent(key('keyup', 'Space', { target: BUTTON }), 'Space', 'up') === 'swallow'
);
check(
  'typing in an editable field types: the PTT key is ignored there',
  classifyPttKeyEvent(key('keydown', 'Space', { target: COMPOSER_TYPING }), 'Space', 'up') === 'ignore' &&
    classifyPttKeyEvent(key('keyup', 'Space', { target: COMPOSER_TYPING }), 'Space', 'up') === 'ignore'
);
check(
  'the read-only voice composer is not a typing target',
  !isTypingTarget(COMPOSER_VOICE) &&
    classifyPttKeyEvent(key('keydown', 'Space', { target: COMPOSER_VOICE }), 'Space', 'up') === 'press'
);
check(
  'a press that began outside a field still releases if focus moved into one',
  classifyPttKeyEvent(key('keyup', 'Space', { target: COMPOSER_TYPING }), 'Space', 'down') === 'release'
);
check(
  'checkbox / radio inputs are not typing targets; text, search and select are',
  !isTypingTarget({ tagName: 'INPUT', type: 'checkbox' }) &&
    isTypingTarget({ tagName: 'INPUT', type: 'search' }) &&
    isTypingTarget({ tagName: 'INPUT' }) &&
    isTypingTarget({ tagName: 'SELECT' }) &&
    isTypingTarget({ tagName: 'DIV', isContentEditable: true })
);
check(
  'Cmd+Space (Spotlight) and Ctrl+Space are left to the OS',
  classifyPttKeyEvent(key('keydown', 'Space', { metaKey: true }), 'Space', 'up') === 'ignore' &&
    classifyPttKeyEvent(key('keydown', 'Space', { ctrlKey: true }), 'Space', 'up') === 'ignore'
);
check(
  'a modifier used as the key presses despite reporting its own flag',
  classifyPttKeyEvent(key('keydown', 'ControlLeft', { ctrlKey: true }), 'ControlLeft', 'up') === 'press' &&
    classifyPttKeyEvent(key('keydown', 'ShiftLeft', { shiftKey: true } as Partial<PttKeyEventLike>), 'ShiftLeft', 'up') === 'press'
);
check('F13 presses', classifyPttKeyEvent(key('keydown', 'F13'), 'F13', 'up') === 'press');
check(
  'IME composition is left alone',
  classifyPttKeyEvent(key('keydown', 'Space', { isComposing: true }), 'Space', 'up') === 'ignore'
);

// -----------------------------------------------------------------------------
section('3. transcript gate');
// -----------------------------------------------------------------------------
check(
  'empty, whitespace and punctuation-only transcripts are dropped',
  ['', '   ', '\n\t', '.', '…', ' ?! ', null, undefined, 3].every((text) => pttTranscriptToDeliver(text) === null)
);
check('a real transcript is trimmed and kept', pttTranscriptToDeliver('  오늘 밤에 클라라와 태양 보고 싶어요 ') === '오늘 밤에 클라라와 태양 보고 싶어요');
check('a digit alone is content', pttTranscriptToDeliver('2') === '2');

// -----------------------------------------------------------------------------
section('4. press → release → commit → transcript');
// -----------------------------------------------------------------------------
{
  const machine = new PttMachine();
  check('mic starts shut', !machine.micOpen());
  const press = machine.press(0, { ready: true, speaking: false });
  check('a press clears the buffer, opens the mic, shows capturing', types(press).startsWith('clear-buffer,mic,status') && statusOf(press) === 'capturing' && machine.micOpen());
  check('a second press while held does nothing', machine.press(10, { ready: true, speaking: false }).length === 0);
  const release = machine.release(2_000, 'key-up');
  check('a release schedules the tail and shows transcribing, mic still open', types(release).includes('schedule-tail') && statusOf(release) === 'transcribing' && machine.micOpen());
  check('nothing is committed before the tail', commits(release).length === 0);
  const tail = machine.tailElapsed();
  const [commit] = commits(tail);
  check('the tail shuts the mic and commits once', Boolean(commit) && commits(tail).length === 1 && !machine.micOpen());
  check('…with a transcript timeout', tail.some((effect) => effect.type === 'schedule-timeout' && effect.ms === PTT_TRANSCRIPT_TIMEOUT_MS));
  check('a late tail timer is a no-op', machine.tailElapsed().length === 0);
  check('committed() files held + tail as the duration', machine.committed('item_1') === 2_000 + PTT_RELEASE_TAIL_MS);
  const done = machine.transcribed('item_1');
  check('the transcript resolves it and returns to idle', done.known && statusOf(done.effects) === 'listening' && machine.pendingCount() === 0);
  check('its timeout then does nothing', machine.timedOut(commit.eventId).length === 0);
}

// -----------------------------------------------------------------------------
section('5. edge cases');
// -----------------------------------------------------------------------------
{
  const machine = new PttMachine();
  check('the measured 234 ms press that hallucinated "그걸로 할게요." counts as a tap', 234 < PTT_MIN_PRESS_MS);
  machine.press(0, { ready: true, speaking: false });
  const tap = machine.release(100, 'key-up');
  check('a 100 ms tap clears instead of committing', commits(tap).length === 0 && types(tap).includes('clear-buffer') && !types(tap).includes('schedule-tail'));
  check('…and is logged as ignored', tap.some((effect) => effect.type === 'log' && effect.payload.reason === 'ptt_tap'));
  check('…back to idle, mic shut', statusOf(tap) === 'listening' && !machine.micOpen());
}
{
  const machine = new PttMachine();
  const press = machine.press(0, { ready: true, speaking: true });
  check('a press while the agent speaks cuts it first', types(press).startsWith('cut-speech,clear-buffer'));
}
{
  const machine = new PttMachine();
  const notReady = machine.press(0, { ready: false, speaking: false });
  check('a press before the channel is open is ignored', !machine.micOpen() && !types(notReady).includes('clear-buffer'));
  check('…so its release cannot commit an uncleared buffer', machine.release(3_000, 'key-up').length === 0);
}
{
  // Second press before the first transcript lands.
  const machine = new PttMachine();
  machine.press(0, { ready: true, speaking: false });
  machine.release(1_500, 'key-up');
  const first = commits(machine.tailElapsed());
  machine.press(1_900, { ready: true, speaking: false });
  machine.release(3_500, 'key-up');
  const second = commits(machine.tailElapsed());
  check('two presses, two commits with distinct ids', first.length === 1 && second.length === 1 && first[0].eventId !== second[0].eventId);
  check('both are pending', machine.pendingCount() === 2);
  check('acks bind in order', machine.committed('item_a') === 1_500 + PTT_RELEASE_TAIL_MS && machine.committed('item_b') === 1_600 + PTT_RELEASE_TAIL_MS);
  const a = machine.transcribed('item_a');
  check('the first transcript leaves the second pending (still transcribing)', statusOf(a.effects) === 'transcribing');
  check('then idle', statusOf(machine.transcribed('item_b').effects) === 'listening');
}
{
  // Second press INSIDE the release tail: the first commit is flushed, not lost
  // or merged, and the new press's clear comes after it.
  const machine = new PttMachine();
  machine.press(0, { ready: true, speaking: false });
  machine.release(1_000, 'key-up');
  const press = machine.press(1_100, { ready: true, speaking: false });
  const order = types(press);
  check('a press in the tail commits the first press before clearing', order.indexOf('commit') >= 0 && order.indexOf('commit') < order.indexOf('clear-buffer'));
  check('the tail timer then does nothing', machine.tailElapsed().length === 0);
  machine.release(2_000, 'key-up');
  check('the second press commits on its own tail', commits(machine.tailElapsed()).length === 1 && machine.pendingCount() === 2);
}
{
  // No two commits without a clear between them, over a random run.
  const machine = new PttMachine();
  let lastWasCommit = false;
  let doubleCommit = false;
  let now = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let step = 0; step < 2_000; step += 1) {
    now += Math.floor(rand() * 400);
    const roll = rand();
    const effects =
      roll < 0.3
        ? machine.press(now, { ready: rand() > 0.1, speaking: rand() > 0.5 })
        : roll < 0.6
        ? machine.release(now, 'key-up')
        : roll < 0.8
        ? machine.tailElapsed()
        : machine.timedOut(`ptt-commit-${Math.floor(rand() * 20)}`);
    for (const effect of effects) {
      if (effect.type === 'commit') {
        if (lastWasCommit) doubleCommit = true;
        lastWasCommit = true;
      } else if (effect.type === 'clear-buffer') {
        lastWasCommit = false;
      }
    }
  }
  check('2,000 random steps: never two commits without a clear between them', !doubleCommit);
}
{
  const machine = new PttMachine();
  machine.press(0, { ready: true, speaking: false });
  machine.release(1_000, 'key-up');
  const [commit] = commits(machine.tailElapsed());
  const timeout = machine.timedOut(commit.eventId);
  check('no transcript in time: clear, idle, logged', types(timeout).includes('clear-buffer') && statusOf(timeout) === 'listening' && timeout.some((effect) => effect.type === 'log'));
  check('a late transcript is reported as unknown (delivered, flagged late)', !machine.transcribed('item_late').known);
}
{
  const machine = new PttMachine();
  machine.press(0, { ready: true, speaking: false });
  machine.release(1_000, 'key-up');
  const [commit] = commits(machine.tailElapsed());
  machine.press(2_000, { ready: true, speaking: false });
  const timeout = machine.timedOut(commit.eventId);
  check('a timeout during a new press does not clear the new speech', !types(timeout).includes('clear-buffer') && statusOf(timeout) === 'capturing');
}
{
  const machine = new PttMachine();
  machine.press(0, { ready: true, speaking: false });
  machine.release(1_000, 'key-up');
  const [commit] = commits(machine.tailElapsed());
  check('a rejected commit (buffer too small) returns to idle', statusOf(machine.commitRejected(commit.eventId)) === 'listening' && machine.pendingCount() === 0);
}
{
  const machine = new PttMachine();
  machine.press(0, { ready: true, speaking: false });
  machine.reset();
  check('reset (teardown / reconnect) shuts the mic and forgets the press', !machine.micOpen() && machine.release(5_000, 'key-up').length === 0);
}

console.log(failures === 0 ? '\nall push-to-talk checks passed' : `\n${failures} push-to-talk check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
