/**
 * The booth tablet's in-session controls: the idle-reset clock, the "still
 * there?" countdown, the booking-complete countdown, and the Start over button.
 *
 * The decisions are `decideTabletIdle` in `study/tabletProfile.ts`; this file
 * only feeds it and draws what it says. Every countdown ticks inside its own
 * small component, so the 3,700-line booking page re-renders when the phase
 * changes and never once a second (on a slow tablet CPU that tick is the
 * difference between idle and busy; see the 2026-10-17 tablet profile).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from '../../i18n';
import {
  TABLET_BOOKING_COMPLETE_RESET_MS,
  decideTabletIdle,
  parseIdleSeconds,
  tabletBusyHolds,
} from '../../study/tabletProfile';
import { stampTabletActivity } from '../../study/tabletProfileStorage';

export type TabletResetReason = 'idle' | 'booking-complete' | 'start-over' | 'finish';

export interface TabletResetRequest {
  reason: TabletResetReason;
  /** Settles once the booking page's last log line is written; the finish waits for it. */
  beforeFinish: Promise<unknown>;
}

type IdlePhase =
  | { phase: 'active' }
  | { phase: 'warning'; deadlineMs: number }
  | { phase: 'complete'; deadlineMs: number };

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export interface TabletIdleOptions {
  enabled: boolean;
  idleSeconds: number;
  /** The agent is planning or speaking, the visitor is mid-utterance, a stage is loading. */
  busy: boolean;
  /**
   * Changes whenever the conversation or the screen changes — a message, a
   * stage, a highlight. Any change counts as activity.
   */
  activitySignal: unknown;
  bookingComplete: boolean;
  onReset: (reason: 'idle' | 'booking-complete') => void;
}

export function useTabletIdleReset({
  enabled,
  idleSeconds,
  busy,
  activitySignal,
  bookingComplete,
  onReset,
}: TabletIdleOptions): { state: IdlePhase; stay: () => void } {
  const lastActivityRef = useRef(Date.now());
  const completeSinceRef = useRef<number | null>(null);
  const busySinceRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;
  const [state, setState] = useState<IdlePhase>({ phase: 'active' });

  const evaluate = useCallback(() => {
    if (!enabled || firedRef.current) return;
    const nowMs = Date.now();
    if (!busyRef.current) busySinceRef.current = null;
    else if (busySinceRef.current === null) busySinceRef.current = nowMs;
    // Busy holds the clock, but not forever: see TABLET_BUSY_HOLD_MAX_MS.
    const holding = tabletBusyHolds({ busy: busyRef.current, busySinceMs: busySinceRef.current, nowMs });
    if (holding) {
      lastActivityRef.current = nowMs;
      stampTabletActivity(nowMs);
    }
    const verdict = decideTabletIdle({
      nowMs,
      lastActivityMs: lastActivityRef.current,
      busy: holding,
      idleSeconds,
      bookingCompleteSinceMs: completeSinceRef.current,
    });
    if (verdict.kind === 'reset') {
      firedRef.current = true;
      onResetRef.current(verdict.reason);
      return;
    }
    let next: IdlePhase;
    if (verdict.kind === 'warning') {
      next = { phase: 'warning', deadlineMs: lastActivityRef.current + parseIdleSeconds(idleSeconds) * 1000 };
    } else if (verdict.kind === 'complete-countdown') {
      const since = Math.max(completeSinceRef.current ?? nowMs, lastActivityRef.current);
      next = { phase: 'complete', deadlineMs: since + TABLET_BOOKING_COMPLETE_RESET_MS };
    } else {
      next = { phase: 'active' };
    }
    setState((previous) =>
      previous.phase === next.phase &&
      (previous.phase === 'active' || (next.phase !== 'active' && previous.deadlineMs === next.deadlineMs))
        ? previous
        : next
    );
  }, [enabled, idleSeconds]);

  const bump = useCallback(() => {
    const nowMs = Date.now();
    lastActivityRef.current = nowMs;
    // Real activity: a busy stretch that is still going starts its hold over.
    if (busySinceRef.current !== null) busySinceRef.current = nowMs;
    stampTabletActivity(nowMs);
    evaluate();
  }, [evaluate]);

  // Touch, keys, scrolling: anything a person does to the glass.
  useEffect(() => {
    if (!enabled) return;
    const options: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, bump, options);
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, bump, options);
    };
  }, [bump, enabled]);

  // The conversation and the screen moving, from either side.
  const firstSignalRef = useRef(true);
  useEffect(() => {
    if (firstSignalRef.current) {
      firstSignalRef.current = false;
      return;
    }
    bump();
  }, [activitySignal, bump]);

  useEffect(() => {
    completeSinceRef.current = bookingComplete ? Date.now() : null;
    evaluate();
  }, [bookingComplete, evaluate]);

  useEffect(() => {
    evaluate();
  }, [busy, evaluate]);

  // One cheap check a second; it sets state only when the phase changes.
  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(evaluate, 1000);
    // A screen that slept: check the moment it is visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') evaluate();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, evaluate]);

  return { state, stay: bump };
}

function useSecondsLeft(deadlineMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

/** "Still there?" with a countdown. Any touch anywhere cancels it. */
export function TabletIdleWarning({ deadlineMs, onStay }: { deadlineMs: number; onStay: () => void }) {
  const { s } = useLanguage();
  const secondsLeft = useSecondsLeft(deadlineMs);
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="tablet-idle-title"
    >
      <div className="w-full max-w-sm rounded-2xl border border-dark-border bg-dark-light p-6 text-center shadow-2xl">
        <p id="tablet-idle-title" className="text-xl font-semibold text-fg-strong">
          {s.tabletStillThere}
        </p>
        <p className="mt-2 text-sm text-fg-muted" aria-live="polite">
          {s.tabletIdleCountdown.replace('{seconds}', String(secondsLeft))}
        </p>
        <button
          type="button"
          onClick={onStay}
          className="mt-5 min-h-12 w-full rounded-xl bg-primary px-4 py-3 text-base font-semibold text-primary-fg transition-colors hover:bg-primary-hover"
        >
          {s.tabletImHere}
        </button>
      </div>
    </div>,
    document.body
  );
}

/**
 * The booking is done: say so and count down, next to the Start over button
 * that would do it now. Inline in the tablet toolbar rather than floating, so
 * it never covers the confirmation the visitor is reading.
 */
export function TabletCompleteNotice({ deadlineMs, className = '' }: { deadlineMs: number; className?: string }) {
  const { s } = useLanguage();
  const secondsLeft = useSecondsLeft(deadlineMs);
  return (
    <p
      className={`whitespace-normal text-xs font-medium leading-snug text-primary-text ${className}`}
      role="status"
    >
      {s.tabletCompleteCountdown.replace('{seconds}', String(secondsLeft))}
    </p>
  );
}

/**
 * "Start over" / "처음부터". One tap when there is nothing to lose; one more
 * tap, on a confirmation, when a booking is under way.
 */
export function TabletStartOverButton({
  needsConfirm,
  onStartOver,
}: {
  needsConfirm: boolean;
  onStartOver: () => void;
}) {
  const { s } = useLanguage();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => (needsConfirm ? setConfirming(true) : onStartOver())}
        className="h-11 rounded-xl border border-primary bg-primary/12 px-4 text-sm font-semibold text-primary-text hover:bg-primary/20"
      >
        {s.tabletStartOver}
      </button>
      {confirming
        ? createPortal(
            <div
              className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="tablet-start-over-title"
              onClick={() => setConfirming(false)}
            >
              <div
                className="w-full max-w-sm rounded-2xl border border-dark-border bg-dark-light p-6 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              >
                <p id="tablet-start-over-title" className="text-base font-semibold text-fg-strong">
                  {s.tabletStartOverConfirm}
                </p>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="min-h-12 rounded-xl border border-dark-border px-4 text-sm font-medium text-fg hover:border-primary hover:text-fg-strong"
                  >
                    {s.tabletKeepGoing}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(false);
                      onStartOver();
                    }}
                    className="min-h-12 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-fg hover:bg-primary-hover"
                  >
                    {s.tabletStartOver}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
