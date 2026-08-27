/**
 * Executable check for the speech barrier. No test runner is configured in this
 * repo, so this is a plain script:
 *
 *   npx tsx apps/tuning-agent/src/core/speechBarrier.check.ts
 *
 * Each case is one of the failure modes observed in, or introduced by, the
 * voice pipeline. Exit code 0 means every case passed.
 */
import { createSpeechBarrier, type SpeechBarrierEvent } from "./speechBarrier";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/** A barrier with a fake clock so timeouts are deterministic. */
function makeBarrier(timeoutMs = 15_000) {
  const events: SpeechBarrierEvent[] = [];
  const timers: Array<{ id: number; fn: () => void }> = [];
  let nextId = 1;
  const barrier = createSpeechBarrier({
    timeoutMs,
    onEvent: (e) => events.push(e),
    setTimeoutFn: ((fn: () => void) => {
      const id = nextId++;
      timers.push({ id, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: unknown) => {
      const idx = timers.findIndex((t) => t.id === (id as number));
      if (idx >= 0) timers.splice(idx, 1);
    }) as unknown as typeof clearTimeout,
  });
  return {
    barrier,
    events,
    /** Fire every pending timer, as a real timeout would. */
    fireTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const t of pending) t.fn();
    },
    pendingTimers: () => timers.length,
  };
}

/** Resolves to 'resolved' if the promise settles this microtask drain. */
async function settledNow(promise: Promise<void> | null): Promise<boolean> {
  if (promise === null) return true;
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return settled;
}

async function main(): Promise<void> {
  section("1. LATCH — completion arrives before the barrier is armed");
  {
    const { barrier } = makeBarrier();
    barrier.noteSpeechSent(); // agent hands an utterance to the host
    barrier.noteCompletion({ messageId: "m1" }); // host finishes it early
    const waited = barrier.wait(); // next cycle arms only now
    check(
      "wait() returns null instead of stalling for the timeout",
      waited === null,
      `got ${waited === null ? "null" : "a pending promise"}`,
    );
    check("nothing is left outstanding", barrier.outstanding === 0);
  }

  section("2. NORMAL — completion arrives while the barrier is armed");
  {
    const { barrier } = makeBarrier();
    barrier.noteSpeechSent();
    const waited = barrier.wait();
    check("barrier is armed", waited !== null && barrier.isArmed);
    check("does not resolve before completion", !(await settledNow(waited)));
    barrier.noteCompletion({ messageId: "m1" });
    check("resolves on completion", await settledNow(waited));
  }

  section("3. WRONG-TURN RELEASE — a stale completion must not open a later barrier");
  {
    const { barrier, events } = makeBarrier();
    barrier.noteSpeechSent();
    barrier.noteCompletion({ messageId: "m1" }); // turn 1 completes
    barrier.wait(); // turn 2 arms: latch, returns null

    // A leftover envelope from turn 1's barge-in arrives late.
    barrier.noteCompletion({ messageId: "m-stale" });
    check(
      "stale completion is recorded as unexpected, not applied",
      events.some((e) => e.type === "unexpected"),
    );

    // Turn 3 speaks and must still wait for its own utterance.
    barrier.noteSpeechSent();
    const waited = barrier.wait();
    check("next turn still arms its own barrier", waited !== null);
    check("and is not already released by the stale envelope", !(await settledNow(waited)));
  }

  section("4. BARGE-IN — realtime emits one completion per dropped queue item");
  {
    const { barrier } = makeBarrier();
    // Agent sent three utterances; a barge-in drops two queued plus the active one.
    barrier.noteSpeechSent();
    barrier.noteSpeechSent();
    barrier.noteSpeechSent();
    const waited = barrier.wait();
    barrier.noteCompletion({ messageId: "m1", interrupted: true });
    check("still waiting after 1 of 3", !(await settledNow(waited)));
    barrier.noteCompletion({ messageId: "m2", interrupted: true });
    check("still waiting after 2 of 3", !(await settledNow(waited)));
    barrier.noteCompletion({ messageId: "m3", interrupted: true });
    check("releases only when all three are accounted for", await settledNow(waited));
  }

  section("5. DUPLICATE — the same messageId reported twice must not double-count");
  {
    const { barrier, events } = makeBarrier();
    barrier.noteSpeechSent();
    barrier.noteSpeechSent();
    const waited = barrier.wait();
    barrier.noteCompletion({ messageId: "m1" });
    barrier.noteCompletion({ messageId: "m1" }); // duplicate
    check("duplicate is flagged", events.some((e) => e.type === "duplicate"));
    check("barrier still waits for the second utterance", !(await settledNow(waited)));
    barrier.noteCompletion({ messageId: "m2" });
    check("releases on the genuine second completion", await settledNow(waited));
  }

  section("6. TIMEOUT — a completion that never arrives still releases the turn");
  {
    const { barrier, events, fireTimers } = makeBarrier(15_000);
    barrier.noteSpeechSent();
    const waited = barrier.wait();
    check("waiting", !(await settledNow(waited)));
    fireTimers();
    check("released by timeout", await settledNow(waited));
    check("timeout is reported", events.some((e) => e.type === "timeout"));
    check("accounting is drained so the next turn is clean", barrier.outstanding === 0);
  }

  section("7. RELEASE — voice mode off / session reset must not leave a stuck waiter");
  {
    const { barrier, events, pendingTimers } = makeBarrier();
    barrier.noteSpeechSent();
    barrier.noteSpeechSent();
    const waited = barrier.wait();
    barrier.release("voice-mode-disabled");
    check("waiter is released", await settledNow(waited));
    check("release is reported", events.some((e) => e.type === "released"));
    check("outstanding is cleared", barrier.outstanding === 0);
    check("no timer is left armed", pendingTimers() === 0);
  }

  section("8. NO SPEECH — a turn that said nothing must not wait at all");
  {
    const { barrier } = makeBarrier();
    check("wait() returns null with nothing outstanding", barrier.wait() === null);
  }

  section("9. LATCH ACROSS TURNS — fast playback repeatedly beats the arm");
  {
    const { barrier } = makeBarrier();
    for (let turn = 1; turn <= 5; turn += 1) {
      barrier.noteSpeechSent();
      barrier.noteCompletion({ messageId: `t${turn}` });
      const waited = barrier.wait();
      check(`turn ${turn} proceeds immediately`, waited === null);
    }
  }

  console.log(
    failures === 0
      ? "\nAll speech-barrier checks passed."
      : `\n${failures} speech-barrier check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
