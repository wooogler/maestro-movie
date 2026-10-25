/**
 * The booth reset: when an unattended or presenter-run booth ends one visitor's
 * session and gets the screen ready for the next.
 *
 * Two booths use it. The booth tablet (`tabletProfile.ts`) resets after its
 * profile's idle window and 20 s after a booking completes. The kiosk/desktop
 * demo started from the setup page resets after a long idle window (10 min by
 * default) and ~12 s after the spoken "booking complete" line has finished.
 * The decision is the same function for both; only the numbers differ.
 *
 * DOM-free on purpose, like `tabletProfile.ts`: `boothReset.check.ts` runs it
 * under node. The React half is `useBoothIdleReset` in
 * `components/tablet/TabletSessionControls.tsx`; the kiosk's settings store is
 * `hooks/useBoothResetSettings.ts`.
 */

/** Long enough to hold the 15-second "still there?" countdown and a few seconds before it. */
export const MIN_BOOTH_IDLE_SECONDS = 20;
export const MAX_BOOTH_IDLE_SECONDS = 3600;
/** What an unparseable idle value means. The tablet's own default. */
export const DEFAULT_BOOTH_IDLE_SECONDS = 180;

/** The countdown shown before an idle reset. */
export const BOOTH_IDLE_WARNING_MS = 15_000;

/** Seconds, clamped to [MIN, MAX]; anything unparseable is the default. */
export function parseBoothIdleSeconds(value: unknown): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BOOTH_IDLE_SECONDS;
  return Math.min(MAX_BOOTH_IDLE_SECONDS, Math.max(MIN_BOOTH_IDLE_SECONDS, Math.round(raw)));
}

export type BoothIdleVerdict =
  | { kind: 'active' }
  /** The "still there?" countdown: any touch, input or agent activity cancels it. */
  | { kind: 'warning'; secondsLeft: number }
  /** The booking is done; the booth starts over for the next visitor shortly. */
  | { kind: 'complete-countdown'; secondsLeft: number }
  | { kind: 'reset'; reason: 'idle' | 'booking-complete' };

export interface BoothIdleInput {
  nowMs: number;
  /** Last visitor input, touch, or agent activity. */
  lastActivityMs: number;
  /**
   * Something is happening right now: the agent is planning or speaking, the
   * visitor is mid-utterance, a stage is loading. Never reset under it.
   */
  busy: boolean;
  /** Null: no idle reset at all (the kiosk's "Off"). The completion reset still runs. */
  idleSeconds: number | null;
  /**
   * When the booking-complete countdown may start, or null while it may not.
   *
   * Not "when the screen appeared": the booth waits for the spoken completion
   * line to finish (or for the chime, with voice off), so the countdown never
   * runs under the sentence that announces it.
   */
  bookingCompleteSinceMs: number | null;
  /** How long after that the booth starts over. The tablet's 20 s when omitted. */
  completeResetMs?: number;
}

/** How long the booking-complete screen stays up on the tablet before it starts over. */
export const TABLET_COMPLETE_RESET_MS = 20_000;

export function decideBoothIdle(input: BoothIdleInput): BoothIdleVerdict {
  if (input.busy) return { kind: 'active' };
  const completeResetMs = input.completeResetMs ?? TABLET_COMPLETE_RESET_MS;
  if (input.bookingCompleteSinceMs !== null) {
    // Measured from the later of "the line finished" and "the agent fell
    // silent", so the confirmation is never cut off mid-sentence.
    const since = Math.max(input.bookingCompleteSinceMs, input.lastActivityMs);
    const shown = input.nowMs - since;
    if (shown >= completeResetMs) return { kind: 'reset', reason: 'booking-complete' };
    return {
      kind: 'complete-countdown',
      secondsLeft: Math.max(1, Math.ceil((completeResetMs - shown) / 1000)),
    };
  }
  if (input.idleSeconds === null) return { kind: 'active' };
  const idleMs = parseBoothIdleSeconds(input.idleSeconds) * 1000;
  const elapsed = input.nowMs - input.lastActivityMs;
  if (elapsed >= idleMs) return { kind: 'reset', reason: 'idle' };
  if (elapsed >= idleMs - BOOTH_IDLE_WARNING_MS) {
    return { kind: 'warning', secondsLeft: Math.max(1, Math.ceil((idleMs - elapsed) / 1000)) };
  }
  return { kind: 'active' };
}

/** When the countdown phase that `decideBoothIdle` just reported ends. */
export function boothCompleteDeadlineMs(input: {
  bookingCompleteSinceMs: number;
  lastActivityMs: number;
  completeResetMs?: number;
}): number {
  return (
    Math.max(input.bookingCompleteSinceMs, input.lastActivityMs) +
    (input.completeResetMs ?? TABLET_COMPLETE_RESET_MS)
  );
}

/**
 * How long "busy" may hold off the idle clock with nothing else happening.
 *
 * Busy means the agent is planning or speaking or the visitor is mid-utterance,
 * and none of those lasts a minute and a half on its own. A flag that stays up
 * longer is stuck — a planner request that hung, a voice status that never
 * came back — and an unattended booth must still reach its next visitor.
 * Any real activity (a touch, a message, a screen change) starts the hold over.
 */
export const BOOTH_BUSY_HOLD_MAX_MS = 90_000;

export function boothBusyHolds(input: { busy: boolean; busySinceMs: number | null; nowMs: number }): boolean {
  if (!input.busy) return false;
  if (input.busySinceMs === null) return true;
  return input.nowMs - input.busySinceMs < BOOTH_BUSY_HOLD_MAX_MS;
}

// ---------------------------------------------------------------------------
// The kiosk's settings
// ---------------------------------------------------------------------------

/**
 * The kiosk/desktop demo's two numbers, set in Settings and kept on the device
 * (they belong to the booth, not to a visitor).
 */
export interface KioskResetSettings {
  /** Seconds after the completion line finishes. */
  returnAfterSeconds: number;
  /** Minutes without a touch or any agent activity; null = never. */
  idleMinutes: number | null;
}

export const KIOSK_RETURN_AFTER_CHOICES = [3, 5, 12, 20, 30] as const;
export const DEFAULT_KIOSK_RETURN_AFTER_SECONDS = 12;
export const KIOSK_IDLE_MINUTE_CHOICES = [2, 5, 10, 15, 30] as const;
export const DEFAULT_KIOSK_IDLE_MINUTES = 10;

export const DEFAULT_KIOSK_RESET_SETTINGS: KioskResetSettings = {
  returnAfterSeconds: DEFAULT_KIOSK_RETURN_AFTER_SECONDS,
  idleMinutes: DEFAULT_KIOSK_IDLE_MINUTES,
};

/** Seconds in [1, 120]; anything else is the default. */
export function parseKioskReturnAfterSeconds(value: unknown): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_KIOSK_RETURN_AFTER_SECONDS;
  return Math.min(120, Math.round(raw));
}

/** Minutes in [1, 60], `off` for never; anything unparseable is the default. */
export function parseKioskIdleMinutes(value: unknown): number | null {
  if (value === null || value === 'off' || value === 0 || value === '0') return null;
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_KIOSK_IDLE_MINUTES;
  return Math.min(60, Math.round(raw));
}

/** What `useBoothIdleReset` is handed for the kiosk. */
export function kioskBoothResetTiming(settings: KioskResetSettings): {
  idleSeconds: number | null;
  completeResetMs: number;
} {
  return {
    idleSeconds: settings.idleMinutes === null ? null : settings.idleMinutes * 60,
    completeResetMs: settings.returnAfterSeconds * 1000,
  };
}
