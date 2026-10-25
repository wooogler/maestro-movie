/**
 * Push-to-talk, the parts that do not need a browser.
 *
 * Booth only. In a loud hall the server VAD heard the room: at the KSEA poster
 * session (2026-10-24) 30 of 102 visitor turns were noise, bystanders or the
 * kiosk's own voice, and 40 of 128 agent sentences were cut by a VAD barge-in.
 * With push-to-talk the session is minted with `turn_detection: null`, the mic
 * track is disabled except while a key is held, and the audio buffer is
 * committed by hand on release, so nothing reaches the transcriber that the
 * presenter did not mean to send.
 *
 * Two pieces live here so `usePushToTalk.check.ts` can run them in plain Node:
 *
 *  - `classifyPttKeyEvent`: which keyboard events press, release, are swallowed
 *    (preventDefault and nothing else: auto-repeat, the key-up of a press that
 *    was already released by a blur) or are none of our business (another key,
 *    typing in a text field).
 *  - `PttMachine`: the press → release → commit → transcript bookkeeping, as a
 *    pure state machine that returns the side effects for the hook to run. The
 *    rule it exists to keep: one press commits at most once, and only a press
 *    that cleared the buffer when it began can commit it.
 */

/** `KeyboardEvent.code`, not `key`: layout-independent, and F13 has no `key` worth reading. */
export const DEFAULT_PTT_KEY_CODE = 'Space';

/** The picker's presets. Anything else goes through the free-text field. */
export const PTT_KEY_PRESETS = ['Space', 'F13', 'ControlLeft', 'ShiftLeft'] as const;

/**
 * Shorter than this is a tap, not speech: the buffer is cleared rather than
 * committed. A 100 ms tap plus the release tail is ~300 ms of whatever the
 * room was saying, which the transcriber happily turns into a word.
 */
export const PTT_MIN_PRESS_MS = 150;

/**
 * The mic stays open this long after the key comes up. People let go on their
 * last syllable, and the commit travels on the data channel while the audio's
 * final frames are still in the RTP path; committing the instant the key rises
 * would clip the end of the sentence.
 */
export const PTT_RELEASE_TAIL_MS = 200;

/** No transcript this long after the commit: give up, clear, show idle. */
export const PTT_TRANSCRIPT_TIMEOUT_MS = 4_000;

/**
 * A key held this long is treated as released. A taped-down key or a HID
 * button stuck closed would otherwise hold the mic open for the hall.
 */
export const PTT_MAX_HOLD_MS = 60_000;

const KEY_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,31}$/;

/**
 * A stored or typed code, or the default. Only the shape is checked — the set
 * of `KeyboardEvent.code` values is open-ended (F13–F24, IntlBackslash, a
 * vendor's media key) and the picker shows the live press anyway.
 */
export function normalizePttKeyCode(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PTT_KEY_CODE;
  const trimmed = value.trim();
  return KEY_CODE_PATTERN.test(trimmed) ? trimmed : DEFAULT_PTT_KEY_CODE;
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

export function isModifierKeyCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** What the event's target is, as far as the typing rule cares. */
export interface PttTargetInfo {
  tagName: string;
  /** `<input type>`; ignored for other elements. */
  type?: string | null;
  readOnly?: boolean;
  disabled?: boolean;
  isContentEditable?: boolean;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * True when the key would type into a field. The rule chosen for the composer:
 * **while focus is in an editable text field, the PTT key types and does not
 * talk.** The voice composer itself is read-only and refuses focus while voice
 * is live (ChatInput), so this only ever bites in a field that is really
 * taking text — the settings sheet's free-text key box, or the composer after
 * the mic failed, where there is no voice to push anyway.
 */
export function isTypingTarget(target: PttTargetInfo | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return !target.readOnly && !target.disabled;
  if (tag === 'INPUT') {
    const type = (target.type ?? 'text').toLowerCase();
    if (NON_TEXT_INPUT_TYPES.has(type)) return false;
    return !target.readOnly && !target.disabled;
  }
  // A <select> takes Space to open itself.
  if (tag === 'SELECT') return !target.disabled;
  return false;
}

export interface PttKeyEventLike {
  type: 'keydown' | 'keyup';
  code: string;
  repeat?: boolean;
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?: PttTargetInfo | null;
}

/**
 * - `press` / `release`: start or end talking (and preventDefault).
 * - `swallow`: preventDefault only. Auto-repeat keydowns, the key-up of a press
 *   that a blur or the hold cap already ended, and a stray key-up — so Space
 *   never scrolls the page or clicks a focused button behind the presenter.
 * - `ignore`: not ours; let it through untouched.
 */
export type PttKeyDecision = 'press' | 'release' | 'swallow' | 'ignore';

/**
 * `held` is the listener's own view: `down` while a press is live, `stale`
 * when the key is still physically down but its press was already ended (blur,
 * hold cap), `up` otherwise.
 */
export type PttListenerState = 'up' | 'down' | 'stale';

export function classifyPttKeyEvent(
  event: PttKeyEventLike,
  code: string,
  state: PttListenerState
): PttKeyDecision {
  if (event.code !== code) return 'ignore';

  if (event.type === 'keyup') {
    if (state === 'down') return 'release';
    if (state === 'stale') return 'swallow';
    return isTypingTarget(event.target) ? 'ignore' : 'swallow';
  }

  // keydown
  if (state !== 'up') return 'swallow';
  if (event.isComposing) return 'ignore';
  if (isTypingTarget(event.target)) return 'ignore';
  // Cmd+Space is Spotlight, Ctrl+Space an input-source switch. A modifier used
  // AS the key (ControlLeft) necessarily reports its own flag, so the check
  // applies only to a non-modifier key.
  if (!isModifierKeyCode(code) && (event.metaKey || event.ctrlKey || event.altKey)) {
    return 'ignore';
  }
  // A repeat with no live press: the key went down before this listener
  // existed (or before a reconnect reset it). Talking starts on a fresh press,
  // never on an auto-repeat.
  if (event.repeat) return 'swallow';
  return 'press';
}

/**
 * The text a transcript contributes, or null when it carries nothing. Empty,
 * whitespace and punctuation-only results are what the transcriber returns for
 * a silent or near-silent buffer, and must never become a `user.message`.
 */
export function pttTranscriptToDeliver(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;
  return trimmed;
}

export type PttInputStatus = 'capturing' | 'transcribing' | 'listening';

export type PttEffect =
  /** Cut the agent's current sentence and drop its queue, as a barge-in does. */
  | { type: 'cut-speech' }
  | { type: 'clear-buffer' }
  /** Re-apply the mic gate: the track is enabled iff `micOpen()`. */
  | { type: 'mic' }
  | { type: 'commit'; eventId: string }
  | { type: 'status'; status: PttInputStatus }
  | { type: 'schedule-tail'; ms: number }
  | { type: 'schedule-timeout'; eventId: string; ms: number }
  | { type: 'log'; event: string; payload: Record<string, unknown> };

interface PendingCommit {
  eventId: string;
  itemId: string | null;
  /** Held time plus the release tail: the audio the commit actually carries. */
  durationMs: number;
}

/**
 * The press lifecycle for one connection. `reset()` on every teardown, so a
 * reconnect starts with the mic shut until the next fresh press.
 *
 * A second press before the previous transcript lands is allowed: the earlier
 * audio is already a committed item, so clearing the (new, empty) buffer
 * cannot touch it, and its transcript is still delivered when it arrives. A
 * second press inside the release tail flushes the first commit before it
 * clears, so the two presses stay two commits.
 */
export class PttMachine {
  private held = false;
  private pressedAt = 0;
  private tail: { heldMs: number } | null = null;
  private pending: PendingCommit[] = [];
  private seq = 0;

  /** Whether the mic track should be enabled right now. */
  micOpen(): boolean {
    return this.held || this.tail !== null;
  }

  isHeld(): boolean {
    return this.held;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  private status(): PttEffect {
    return {
      type: 'status',
      status: this.held ? 'capturing' : this.tail || this.pending.length > 0 ? 'transcribing' : 'listening',
    };
  }

  /**
   * `ready`: the data channel is open and the session is not suspended. A
   * press that is not ready is ignored outright — its release is then a no-op,
   * so it can never commit a buffer it did not clear.
   */
  press(now: number, { ready, speaking }: { ready: boolean; speaking: boolean }): PttEffect[] {
    if (this.held) return [];
    if (!ready) {
      return [{ type: 'log', event: 'chat.voice_input.ptt_ignored', payload: { reason: 'not-ready' } }];
    }
    const effects: PttEffect[] = [];
    if (this.tail) effects.push(...this.flushTail());
    if (speaking) effects.push({ type: 'cut-speech' });
    this.held = true;
    this.pressedAt = now;
    effects.push({ type: 'clear-buffer' }, { type: 'mic' }, this.status());
    effects.push({ type: 'log', event: 'chat.voice_input.ptt_pressed', payload: { interruptedSpeech: speaking } });
    return effects;
  }

  release(now: number, reason: string): PttEffect[] {
    if (!this.held) return [];
    this.held = false;
    const heldMs = Math.max(0, now - this.pressedAt);
    if (heldMs < PTT_MIN_PRESS_MS) {
      return [
        { type: 'mic' },
        { type: 'clear-buffer' },
        this.status(),
        { type: 'log', event: 'chat.voice_input.ignored', payload: { reason: 'ptt_tap', durationMs: heldMs, releaseReason: reason } },
      ];
    }
    this.tail = { heldMs };
    return [
      this.status(),
      { type: 'schedule-tail', ms: PTT_RELEASE_TAIL_MS },
      { type: 'log', event: 'chat.voice_input.ptt_released', payload: { heldMs, reason } },
    ];
  }

  /** The tail timer fired. A no-op if a new press already flushed it. */
  tailElapsed(): PttEffect[] {
    if (!this.tail) return [];
    return [...this.flushTail(), this.status()];
  }

  private flushTail(): PttEffect[] {
    const tail = this.tail;
    if (!tail) return [];
    this.tail = null;
    this.seq += 1;
    const eventId = `ptt-commit-${this.seq}`;
    this.pending.push({ eventId, itemId: null, durationMs: tail.heldMs + PTT_RELEASE_TAIL_MS });
    return [
      { type: 'mic' },
      { type: 'commit', eventId },
      { type: 'schedule-timeout', eventId, ms: PTT_TRANSCRIPT_TIMEOUT_MS },
    ];
  }

  /**
   * `input_audio_buffer.committed`. It carries no client event id, but the
   * data channel is ordered, so commits are acknowledged in the order sent.
   * Returns the audio duration to file under the item for the transcript gate.
   */
  committed(itemId: string): number | null {
    const entry = this.pending.find((candidate) => candidate.itemId === null);
    if (!entry) return null;
    entry.itemId = itemId;
    return entry.durationMs;
  }

  /** A transcript (or a transcription failure) for `itemId`. */
  transcribed(itemId: string | null): { known: boolean; effects: PttEffect[] } {
    const index = itemId ? this.pending.findIndex((candidate) => candidate.itemId === itemId) : -1;
    if (index >= 0) this.pending.splice(index, 1);
    return { known: index >= 0, effects: [this.status()] };
  }

  /** The server refused a commit (e.g. less than 100 ms of audio). */
  commitRejected(eventId: string): PttEffect[] {
    const index = this.pending.findIndex((candidate) => candidate.eventId === eventId);
    if (index < 0) return [];
    this.pending.splice(index, 1);
    return [this.status()];
  }

  /** The transcript timeout for `eventId` fired. */
  timedOut(eventId: string): PttEffect[] {
    const index = this.pending.findIndex((candidate) => candidate.eventId === eventId);
    if (index < 0) return [];
    const [entry] = this.pending.splice(index, 1);
    const effects: PttEffect[] = [];
    // Clearing during a live press or its tail would erase speech in progress.
    if (!this.micOpen()) effects.push({ type: 'clear-buffer' });
    effects.push(this.status(), {
      type: 'log',
      event: 'chat.voice_input.ptt_timeout',
      payload: { eventId, itemId: entry.itemId, durationMs: entry.durationMs },
    });
    return effects;
  }

  reset(): void {
    this.held = false;
    this.tail = null;
    this.pending = [];
  }
}
