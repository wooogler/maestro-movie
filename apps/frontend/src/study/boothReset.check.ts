/**
 * Offline checks for the booth reset's timing: the kiosk's return to the start
 * screen after a completed booking, its long idle reset, and the settings that
 * set both.
 *
 *   npx tsx --tsconfig apps/frontend/tsconfig.node.json \
 *     apps/frontend/src/study/boothReset.check.ts
 *
 * The kiosk runs between visitors with nobody watching the clock, so the two
 * ways this goes wrong are both silent: a countdown that starts under the
 * spoken "your booking is complete" and cuts it off, and an idle rule that
 * fires on a visitor who is still reading — or never fires, so the next one
 * inherits the last one's booking. The tablet's own numbers are checked in
 * tabletProfile.check.ts; this file holds the kiosk's.
 */
import {
  BOOTH_BUSY_HOLD_MAX_MS,
  BOOTH_IDLE_WARNING_MS,
  DEFAULT_KIOSK_IDLE_MINUTES,
  DEFAULT_KIOSK_RESET_SETTINGS,
  DEFAULT_KIOSK_RETURN_AFTER_SECONDS,
  KIOSK_IDLE_MINUTE_CHOICES,
  KIOSK_RETURN_AFTER_CHOICES,
  TABLET_COMPLETE_RESET_MS,
  boothBusyHolds,
  boothCompleteDeadlineMs,
  decideBoothIdle,
  kioskBoothResetTiming,
  parseKioskIdleMinutes,
  parseKioskReturnAfterSeconds,
  type BoothIdleInput,
} from './boothReset';
import { decideTabletIdle, TABLET_BOOKING_COMPLETE_RESET_MS } from './tabletProfile';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const kiosk = kioskBoothResetTiming(DEFAULT_KIOSK_RESET_SETTINGS);
const T0 = 1_800_000_000_000;

function at(overrides: Partial<BoothIdleInput>): BoothIdleInput {
  return {
    nowMs: T0,
    lastActivityMs: T0,
    busy: false,
    idleSeconds: kiosk.idleSeconds,
    bookingCompleteSinceMs: null,
    completeResetMs: kiosk.completeResetMs,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
section('1. the defaults the user asked for');
// -----------------------------------------------------------------------------
{
  check('return after 12 s by default', DEFAULT_KIOSK_RETURN_AFTER_SECONDS === 12 && kiosk.completeResetMs === 12_000);
  check('idle reset after 10 min by default', DEFAULT_KIOSK_IDLE_MINUTES === 10 && kiosk.idleSeconds === 600);
  check('the defaults are among the Settings choices',
    (KIOSK_RETURN_AFTER_CHOICES as readonly number[]).includes(DEFAULT_KIOSK_RETURN_AFTER_SECONDS) &&
      (KIOSK_IDLE_MINUTE_CHOICES as readonly number[]).includes(DEFAULT_KIOSK_IDLE_MINUTES));
  check('the warning is the tablet\'s 15 s countdown', BOOTH_IDLE_WARNING_MS === 15_000);
}

// -----------------------------------------------------------------------------
section('2. booking complete: the countdown waits for the spoken line');
// -----------------------------------------------------------------------------
{
  // The screen is up, the line is still playing: bookingCompleteSinceMs is
  // null until the announcement hook reports it settled.
  const speaking = decideBoothIdle(at({ nowMs: T0 + 30_000, bookingCompleteSinceMs: null, busy: true }));
  check('nothing happens while the line plays (busy)', speaking.kind === 'active');
  const unsettled = decideBoothIdle(at({ nowMs: T0 + 5_000, bookingCompleteSinceMs: null }));
  check('no countdown before the line has settled', unsettled.kind === 'active');

  const settledAt = T0 + 4_000;
  const justAfter = decideBoothIdle(at({ nowMs: settledAt + 100, lastActivityMs: settledAt, bookingCompleteSinceMs: settledAt }));
  check('the countdown starts when the line settles', justAfter.kind === 'complete-countdown' && justAfter.secondsLeft === 12,
    JSON.stringify(justAfter));
  const almost = decideBoothIdle(at({ nowMs: settledAt + 11_900, lastActivityMs: settledAt, bookingCompleteSinceMs: settledAt }));
  check('still counting 11.9 s after the line', almost.kind === 'complete-countdown' && almost.secondsLeft === 1);
  const due = decideBoothIdle(at({ nowMs: settledAt + 12_000, lastActivityMs: settledAt, bookingCompleteSinceMs: settledAt }));
  check('returns to start 12 s after the line', due.kind === 'reset' && due.reason === 'booking-complete');

  // The agent said something after the line (a late planner turn): the
  // countdown is measured from the later of the two, never under speech.
  const late = decideBoothIdle(at({ nowMs: settledAt + 12_000, lastActivityMs: settledAt + 6_000, bookingCompleteSinceMs: settledAt }));
  check('later activity pushes the return out', late.kind === 'complete-countdown' && late.secondsLeft === 6);
  check('the deadline the countdown shows is the same rule',
    boothCompleteDeadlineMs({ bookingCompleteSinceMs: settledAt, lastActivityMs: settledAt + 6_000, completeResetMs: 12_000 }) ===
      settledAt + 18_000);

  const busyAtDeadline = decideBoothIdle(at({ nowMs: settledAt + 60_000, lastActivityMs: settledAt, bookingCompleteSinceMs: settledAt, busy: true }));
  check('never resets while something is happening', busyAtDeadline.kind === 'active');

  // A short timer for a browser check.
  const quick = kioskBoothResetTiming({ returnAfterSeconds: 3, idleMinutes: 10 });
  const quickDue = decideBoothIdle(at({ ...quick, nowMs: settledAt + 3_000, lastActivityMs: settledAt, bookingCompleteSinceMs: settledAt }));
  check('a 3 s setting returns after 3 s', quickDue.kind === 'reset');

  // The completion countdown runs even with the idle reset off.
  const off = kioskBoothResetTiming({ returnAfterSeconds: 12, idleMinutes: null });
  const offDue = decideBoothIdle(at({ ...off, nowMs: settledAt + 12_000, lastActivityMs: settledAt, bookingCompleteSinceMs: settledAt }));
  check('idle Off still returns after a booking', offDue.kind === 'reset' && offDue.reason === 'booking-complete');
}

// -----------------------------------------------------------------------------
section('3. the kiosk idle reset');
// -----------------------------------------------------------------------------
{
  const nine = decideBoothIdle(at({ nowMs: T0 + 9 * 60_000 }));
  check('9 min untouched is still active', nine.kind === 'active');
  const warn = decideBoothIdle(at({ nowMs: T0 + 10 * 60_000 - 10_000 }));
  check('10 s before 10 min: "still there?"', warn.kind === 'warning' && warn.secondsLeft === 10, JSON.stringify(warn));
  const warnStart = decideBoothIdle(at({ nowMs: T0 + 10 * 60_000 - BOOTH_IDLE_WARNING_MS }));
  check('the warning opens 15 s before', warnStart.kind === 'warning' && warnStart.secondsLeft === 15);
  const reset = decideBoothIdle(at({ nowMs: T0 + 10 * 60_000 }));
  check('10 min untouched resets', reset.kind === 'reset' && reset.reason === 'idle');
  const off = decideBoothIdle(at({ idleSeconds: null, nowMs: T0 + 10 * 3600_000 }));
  check('Off never resets for idleness', off.kind === 'active');
  const busy = decideBoothIdle(at({ nowMs: T0 + 20 * 60_000, busy: true }));
  check('busy holds the idle clock', busy.kind === 'active');
  check('but a stuck busy flag lets go after 90 s',
    !boothBusyHolds({ busy: true, busySinceMs: T0, nowMs: T0 + BOOTH_BUSY_HOLD_MAX_MS }) &&
      boothBusyHolds({ busy: true, busySinceMs: T0, nowMs: T0 + BOOTH_BUSY_HOLD_MAX_MS - 1 }));
}

// -----------------------------------------------------------------------------
section('4. the Settings values');
// -----------------------------------------------------------------------------
{
  check('return: a number string', parseKioskReturnAfterSeconds('20') === 20);
  check('return: garbage is the default', parseKioskReturnAfterSeconds('soon') === 12 && parseKioskReturnAfterSeconds(null) === 12);
  check('return: zero or negative is the default', parseKioskReturnAfterSeconds(0) === 12 && parseKioskReturnAfterSeconds(-5) === 12);
  check('return: capped at 2 min', parseKioskReturnAfterSeconds(9999) === 120);
  check('idle: "off" is never', parseKioskIdleMinutes('off') === null && parseKioskIdleMinutes(null) === null);
  check('idle: nothing stored is the default, not off', parseKioskIdleMinutes(undefined) === 10);
  check('idle: garbage is the default', parseKioskIdleMinutes('later') === 10);
  check('idle: capped at an hour', parseKioskIdleMinutes(500) === 60);
}

// -----------------------------------------------------------------------------
section('5. the tablet keeps its numbers through the shared rule');
// -----------------------------------------------------------------------------
{
  check('the tablet\'s 20 s is the shared default', TABLET_BOOKING_COMPLETE_RESET_MS === TABLET_COMPLETE_RESET_MS && TABLET_COMPLETE_RESET_MS === 20_000);
  const tabletDue = decideTabletIdle({
    nowMs: T0 + 20_000,
    lastActivityMs: T0,
    busy: false,
    idleSeconds: 180,
    bookingCompleteSinceMs: T0,
  });
  check('a tablet without completeResetMs still waits 20 s', tabletDue.kind === 'reset');
  const tabletNot = decideTabletIdle({
    nowMs: T0 + 12_000,
    lastActivityMs: T0,
    busy: false,
    idleSeconds: 180,
    bookingCompleteSinceMs: T0,
  });
  check('and is not cut to the kiosk\'s 12 s', tabletNot.kind === 'complete-countdown');
}

console.log(failures === 0 ? '\nall booth reset checks passed' : `\n${failures} booth reset check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
