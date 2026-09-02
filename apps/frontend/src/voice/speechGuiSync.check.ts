/**
 * Executable check for the speech/GUI sync:
 *
 *   npx tsx --tsconfig apps/frontend/tsconfig.node.json \
 *     apps/frontend/src/voice/speechGuiSync.check.ts
 *
 * The happy path is the boring one — audio starts, the screen follows. What is
 * worth checking is every way audio can fail to arrive, because each of them
 * ends with a visitor staring at a screen that will not move: a barge-in that
 * kills an utterance before its first audio buffer, a realtime session that
 * dies mid-request, an autoplay rejection nobody reports, a second sentence
 * overtaking the first. All of them have to end the hold.
 *
 * Time is injected rather than waited on, so the timeout case is exercised
 * exactly instead of being approximated with a sleep.
 *
 * Exit code 0 means every case passed.
 */
import { createSpeechGuiSync, type SpeechGuiSyncEvent } from './speechGuiSync';

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

/** A clock that only moves when the check says so. */
function harness(timeoutMs = 2500) {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const events: SpeechGuiSyncEvent[] = [];
  const sync = createSpeechGuiSync({
    timeoutMs,
    onEvent: (event) => events.push(event),
    setTimeoutFn: ((fn: () => void) => {
      const id = (nextTimer += 1);
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: unknown) => {
      timers.delete(id as number);
    }) as unknown as typeof clearTimeout,
  });
  return {
    sync,
    events,
    /** Fire every armed timer, as the real clock eventually would. */
    fireTimeouts() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
    liveTimers: () => timers.size,
  };
}

/** Did a promise settle by the next macrotask? */
async function settled(promise: Promise<void> | null): Promise<boolean> {
  if (!promise) return true;
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

// ---------------------------------------------------------------------------
section('1. nothing held — every other surface is untouched');
// ---------------------------------------------------------------------------
{
  const { sync, events } = harness();
  check('wait() returns null rather than a promise', sync.wait() === null);
  check('...so the caller applies in the same tick', events.some((e) => e.type === 'passthrough'));
  check('and nothing is pending', sync.pendingMessageId === null);
  /*
    Load-bearing, not a formality. A promise resolving on the next microtask
    would still defer the tool past the current frame for EVERY session — the
    study conditions and the full demo included — which is exactly the change
    this must not make.
  */
}

// ---------------------------------------------------------------------------
section('2. audio starts — the screen follows it');
// ---------------------------------------------------------------------------
{
  const { sync, events } = harness();
  sync.arm('agt-1');
  const waiting = sync.wait();
  check('a GUI change is held', waiting !== null);
  check('the hold names its utterance', sync.pendingMessageId === 'agt-1');
  check('and it is counted', sync.waiterCount === 1);

  check('still held before audio', !(await settled(waiting)));
  sync.release('playback-started');
  check('released when audio starts', await settled(waiting));
  check('the reason is recorded', events.some((e) => e.type === 'released' && e.reason === 'playback-started'));
  check('and nothing stays pending', sync.pendingMessageId === null);
}

// ---------------------------------------------------------------------------
section('3. audio never starts — the screen must move anyway');
// ---------------------------------------------------------------------------
{
  const { sync, fireTimeouts, events } = harness();
  sync.arm('agt-2');
  const waiting = sync.wait();
  check('held while the session hangs', !(await settled(waiting)));
  fireTimeouts();
  check('the timeout lets it through', await settled(waiting));
  check('and says so', events.some((e) => e.type === 'released' && e.reason === 'timeout'));
}

// ---------------------------------------------------------------------------
section('4. a barge-in kills the utterance before its first audio buffer');
// ---------------------------------------------------------------------------
{
  const { sync, liveTimers } = harness();
  sync.arm('agt-3');
  const waiting = sync.wait();
  // The queue reports the utterance complete having never reported it started.
  sync.release('playback-complete');
  check('completion without a start still releases', await settled(waiting));
  check('and the timer is cleared, not left to fire later', liveTimers() === 0);
}

// ---------------------------------------------------------------------------
section('5. a newer sentence overtakes the one being held');
// ---------------------------------------------------------------------------
{
  const { sync, events } = harness();
  sync.arm('agt-4');
  const first = sync.wait();
  sync.arm('agt-5');
  check('the stranded change is let through', await settled(first));
  check('it is reported as superseded', events.some((e) => e.type === 'released' && e.reason === 'superseded'));
  check('and the newer utterance is the one held now', sync.pendingMessageId === 'agt-5');

  const second = sync.wait();
  check('which still holds', !(await settled(second)));
  sync.release('playback-started');
  check('until its own audio starts', await settled(second));
}

// ---------------------------------------------------------------------------
section('6. several changes behind one sentence, and a release with none');
// ---------------------------------------------------------------------------
{
  const { sync } = harness();
  sync.arm('agt-6');
  const a = sync.wait();
  const b = sync.wait();
  check('both are held', sync.waiterCount === 2);
  sync.release('playback-started');
  check('and both are let through by one release', (await settled(a)) && (await settled(b)));

  // Idempotence: the host releases on start AND on completion, so the second
  // call is the normal case, not an error path.
  sync.release('playback-complete');
  check('releasing with nothing held is a no-op', sync.pendingMessageId === null);
}

// ---------------------------------------------------------------------------
section('7. a waiter that arms again does not double-resolve');
// ---------------------------------------------------------------------------
{
  /*
    Real shape: a held tool call applies, the agent narrates the next step, and
    that arms a fresh hold from inside the waiter. If `release` cleared its
    state after running waiters instead of before, this would wipe the new hold
    the waiter just armed.
  */
  const { sync } = harness();
  sync.arm('agt-7');
  const waiting = sync.wait();
  void waiting?.then(() => sync.arm('agt-8'));
  sync.release('playback-started');
  await settled(waiting);
  check('the hold armed from inside the waiter survives', sync.pendingMessageId === 'agt-8');
}

console.log(
  failures === 0 ? '\nall speech/GUI sync checks passed' : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
