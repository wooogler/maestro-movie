/**
 * Holds a GUI change until the sentence describing it is audible.
 *
 * The agent already sends its narration BEFORE the tool call that changes the
 * view, so the wire order is right. What is wrong is the latency either side:
 * applying a tool takes a millisecond, and starting speech takes a realtime
 * round trip plus audio buffering — most of a second. The screen moves, and
 * then the explanation arrives.
 *
 * On a kiosk that is invisible: the transcript prints the sentence the instant
 * it arrives, so the two channels agree. On a phone with the conversation
 * collapsed — every scanned quick-demo card — audio is the only channel, and
 * the visitor watches a list rearrange itself in silence before hearing why.
 *
 * Pure and free of React, like `speechBarrier.ts` in the agent, and for the
 * same reason: the interesting behaviour is all in the paths where audio does
 * NOT arrive on time, and those are worth exercising rather than eyeballing.
 * `speechGuiSync.check.ts` runs them.
 *
 * The rule it implements is one line: at most one utterance is held at a time,
 * and it is released by whichever of these happens first — audio starting,
 * the utterance finishing without ever starting (a barge-in), a newer
 * utterance superseding it, or the timeout.
 */

export type SpeechGuiSyncEvent =
  /** A GUI change was held. */
  | { type: 'armed'; messageId: string }
  /** The hold ended. `waiters` is how many changes were let through. */
  | { type: 'released'; messageId: string; reason: string; waiters: number }
  /** Something asked to wait while nothing was held — it proceeds at once. */
  | { type: 'passthrough' };

export interface SpeechGuiSync {
  /**
   * An utterance has been handed to the speaker: hold the next GUI change for
   * it. Arming while another utterance is held supersedes that one — it either
   * started already or never will, and holding the screen for it would strand
   * the newer sentence.
   */
  arm(messageId: string): void;
  /** Let everything held through, and forget the utterance. */
  release(reason: string): void;
  /**
   * Resolves once the held sentence is audible. Returns null when nothing is
   * held, which callers should treat as "apply now" — a promise that resolves
   * on the next microtask would still push the change past the current frame.
   */
  wait(): Promise<void> | null;
  readonly pendingMessageId: string | null;
  readonly waiterCount: number;
}

export interface SpeechGuiSyncOptions {
  /**
   * The backstop, and it is not optional. Audio can fail to start for reasons
   * the host never hears about — a rejected autoplay, a dead realtime session,
   * a phone switched to silent. The screen must move anyway: being a beat early
   * is a blemish, being frozen is a broken demo.
   *
   * Keep it well under the agent's own request timeout (12s), so a fallthrough
   * can never reach the agent as a dropped tool call.
   */
  timeoutMs: number;
  onEvent?: (event: SpeechGuiSyncEvent) => void;
  /** Injectable for the check. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function createSpeechGuiSync(options: SpeechGuiSyncOptions): SpeechGuiSync {
  const {
    timeoutMs,
    onEvent,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  let pending: {
    messageId: string;
    waiters: Array<() => void>;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function release(reason: string): void {
    const held = pending;
    if (!held) return;
    // Cleared BEFORE the waiters run: a waiter may apply a tool that produces
    // another utterance, and re-entering here with `pending` still set would
    // release it twice and double-resolve.
    pending = null;
    clearTimeoutFn(held.timer);
    onEvent?.({
      type: 'released',
      messageId: held.messageId,
      reason,
      waiters: held.waiters.length,
    });
    for (const waiter of held.waiters) waiter();
  }

  return {
    arm(messageId: string): void {
      release('superseded');
      pending = {
        messageId,
        waiters: [],
        timer: setTimeoutFn(() => release('timeout'), timeoutMs),
      };
      onEvent?.({ type: 'armed', messageId });
    },

    release,

    wait(): Promise<void> | null {
      const held = pending;
      if (!held) {
        onEvent?.({ type: 'passthrough' });
        return null;
      }
      return new Promise<void>((resolve) => {
        held.waiters.push(resolve);
      });
    },

    get pendingMessageId() {
      return pending?.messageId ?? null;
    },
    get waiterCount() {
      return pending?.waiters.length ?? 0;
    },
  };
}
