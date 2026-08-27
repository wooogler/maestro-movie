/**
 * The agent's "wait until the host has finished speaking" barrier.
 *
 * The user-study build released this barrier on a bare edge:
 *
 *     case 'tts.playback.complete':
 *       if (ttsPlaybackResolve) { ttsPlaybackResolve(); ttsPlaybackResolve = null; }
 *
 * Two failures follow from that, and both get worse as the voice pipeline gets
 * faster — so the realtime migration makes fixing this load-bearing rather than
 * optional:
 *
 *  1. LOST COMPLETION. The barrier is armed at the start of the *next* planning
 *     cycle, after the utterance was already handed to the host. A completion
 *     that arrives in between finds `ttsPlaybackResolve === null` and is
 *     discarded, so the agent then waits out the full timeout for playback that
 *     has already finished. Short utterances hit this most often.
 *
 *  2. WRONG-TURN RELEASE. The realtime hook reports one completion per queue
 *     item plus one for the item being spoken, so a single barge-in can emit
 *     several envelopes. Any leftover envelope released whatever barrier
 *     happened to be armed next, letting the agent act before its own current
 *     utterance had played.
 *
 * This module fixes both by counting outstanding utterances instead of
 * listening for an edge. Arming when the count is already zero returns
 * immediately (that is the latch), and a completion that arrives with nothing
 * outstanding is recorded as spurious rather than releasing a future turn.
 */

export type SpeechBarrierEvent =
  | { type: "duplicate"; messageId: string | null; interrupted: boolean }
  | { type: "unexpected"; messageId: string | null; interrupted: boolean }
  | { type: "timeout"; outstanding: number; timeoutMs: number }
  | { type: "released"; reason: string };

export interface SpeechBarrierOptions {
  timeoutMs: number;
  onEvent?: (event: SpeechBarrierEvent) => void;
  /** Injectable for tests. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface SpeechBarrier {
  /** Record that an `agent.message` was accepted by the host. */
  noteSpeechSent(): void;
  /**
   * Arm the barrier. Returns null when nothing is outstanding — the latch case,
   * where playback already finished before this cycle got around to arming.
   */
  wait(): Promise<void> | null;
  /** Handle a `tts.playback.complete` envelope from the host. */
  noteCompletion(info: { messageId?: string | null; interrupted?: boolean }): void;
  /** Drop all accounting and release any waiter (voice off, session reset). */
  release(reason: string): void;
  /** Test/diagnostic view. */
  readonly outstanding: number;
  readonly isArmed: boolean;
}

export function createSpeechBarrier(options: SpeechBarrierOptions): SpeechBarrier {
  const {
    timeoutMs,
    onEvent,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  let outstanding = 0;
  let resolveWaiter: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const seenMessageIds = new Set<string>();

  function clearArmed(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    resolveWaiter = null;
  }

  function drain(): void {
    outstanding = 0;
    seenMessageIds.clear();
  }

  return {
    noteSpeechSent(): void {
      outstanding += 1;
    },

    wait(): Promise<void> | null {
      if (outstanding <= 0) return null;
      return new Promise<void>((resolve) => {
        resolveWaiter = resolve;
        timer = setTimeoutFn(() => {
          if (resolveWaiter !== resolve) return;
          onEvent?.({ type: "timeout", outstanding, timeoutMs });
          drain();
          clearArmed();
          resolve();
        }, timeoutMs);
      });
    },

    noteCompletion(info): void {
      const messageId = typeof info.messageId === "string" ? info.messageId : null;
      const interrupted = info.interrupted === true;

      if (messageId && seenMessageIds.has(messageId)) {
        onEvent?.({ type: "duplicate", messageId, interrupted });
        return;
      }
      if (outstanding <= 0) {
        onEvent?.({ type: "unexpected", messageId, interrupted });
        return;
      }

      if (messageId) seenMessageIds.add(messageId);
      outstanding -= 1;

      if (outstanding === 0) {
        seenMessageIds.clear();
        const resolve = resolveWaiter;
        clearArmed();
        resolve?.();
      }
    },

    release(reason: string): void {
      drain();
      const resolve = resolveWaiter;
      clearArmed();
      if (resolve) {
        onEvent?.({ type: "released", reason });
        resolve();
      }
    },

    get outstanding(): number {
      return outstanding;
    },
    get isArmed(): boolean {
      return resolveWaiter !== null;
    },
  };
}
