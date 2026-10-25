/**
 * Offline checks for the booth tablet profile: the URL, the stored record and
 * its defaults, and the idle-reset decisions.
 *
 *   npx tsx --tsconfig apps/frontend/tsconfig.node.json \
 *     apps/frontend/src/study/tabletProfile.check.ts
 *
 * The tablet runs unattended, so the two ways this goes wrong are silent: a
 * profile URL that parses to something other than what the presenter typed
 * (wrong language for the event, a typo'd idle that resets every few seconds),
 * and an idle rule that either never fires — the next visitor inherits the
 * last one's booking — or fires on someone who is still thinking.
 */
import {
  DEFAULT_TABLET_IDLE_SECONDS,
  MAX_TABLET_IDLE_SECONDS,
  MIN_TABLET_IDLE_SECONDS,
  TABLET_BOOKING_COMPLETE_RESET_MS,
  TABLET_IDLE_WARNING_MS,
  createTabletProfile,
  decideTabletIdle,
  parseStoredTabletProfile,
  parseTabletProfileUrl,
  serializeTabletProfile,
  shouldDiscardRestoredTabletSession,
  stripTabletProfileFromUrl,
  type TabletIdleInput,
} from './tabletProfile';
import { readLanguageFromUrl, stripLanguageFromUrl } from '../i18n/language';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// -----------------------------------------------------------------------------
section('1. the profile URL');
// -----------------------------------------------------------------------------
{
  const full = parseTabletProfileUrl('?profile=tablet&code=abc123&lang=ko&idle=240&consent=off&motion=off');
  check('profile=tablet applies', full.kind === 'apply');
  if (full.kind === 'apply') {
    const p = full.profile;
    check('the code is uppercased', p.accessCode === 'ABC123');
    check('lang=ko is the default language', p.language === 'ko');
    check('idle=240 is kept', p.idleSeconds === 240);
    check('consent=off unticks the box by default', p.researchConsent === false);
    check('motion=off reduces motion', p.reduceMotion === true);
    check('voice is on, PTT off, companion hidden', p.voice === true && p.pushToTalk === false && p.companion === false);
  }

  const bare = parseTabletProfileUrl('?profile=tablet&code=XYZ789');
  check('a bare profile URL applies', bare.kind === 'apply');
  if (bare.kind === 'apply') {
    const p = bare.profile;
    check('English when lang is absent', p.language === 'en');
    check(`idle defaults to ${DEFAULT_TABLET_IDLE_SECONDS} s`, p.idleSeconds === DEFAULT_TABLET_IDLE_SECONDS);
    check('consent is pre-ticked by default, as on the setup page', p.researchConsent === true);
    check('motion is on by default', p.reduceMotion === false);
  }

  const noCode = parseTabletProfileUrl('?profile=tablet&lang=en');
  check('a profile without a code still applies, with an empty code', noCode.kind === 'apply' && noCode.profile.accessCode === '');

  check('profile=clear clears', parseTabletProfileUrl('?profile=clear').kind === 'clear');
  check('profile=CLEAR clears too', parseTabletProfileUrl('?profile=CLEAR').kind === 'clear');
  check('no profile parameter leaves the stored state alone', parseTabletProfileUrl('?lang=ko&code=ABC123').kind === 'none');
  check('an empty query is none', parseTabletProfileUrl('').kind === 'none');
  check('an unknown profile is reported, not applied', parseTabletProfileUrl('?profile=kiosk').kind === 'invalid');

  const tags = parseTabletProfileUrl('?profile=tablet&code=A&lang=zh-TW');
  check('lang takes the same tags as ?lang= (zh-TW → zh-Hant)', tags.kind === 'apply' && tags.profile.language === 'zh-Hant');
  const junkLang = parseTabletProfileUrl('?profile=tablet&code=A&lang=klingon');
  check('an unknown lang falls back to English', junkLang.kind === 'apply' && junkLang.profile.language === 'en');
  check(
    'the language provider reads the same lang from the profile URL',
    readLanguageFromUrl('?profile=tablet&code=A&lang=ko', '') === 'ko'
  );
}

// -----------------------------------------------------------------------------
section('2. idle seconds are clamped, never trusted');
// -----------------------------------------------------------------------------
{
  const idle = (value: string) => {
    const action = parseTabletProfileUrl(`?profile=tablet&code=A&idle=${value}`);
    return action.kind === 'apply' ? action.profile.idleSeconds : -1;
  };
  check(`idle=5 is raised to ${MIN_TABLET_IDLE_SECONDS} (room for the 15 s countdown)`, idle('5') === MIN_TABLET_IDLE_SECONDS);
  check(`idle=99999 is capped at ${MAX_TABLET_IDLE_SECONDS}`, idle('99999') === MAX_TABLET_IDLE_SECONDS);
  check('idle=abc is the default', idle('abc') === DEFAULT_TABLET_IDLE_SECONDS);
  check('idle=-3 is the default', idle('-3') === DEFAULT_TABLET_IDLE_SECONDS);
  check('idle=90.6 rounds', idle('90.6') === 91);
  check('the minimum leaves at least 5 s before the countdown', MIN_TABLET_IDLE_SECONDS * 1000 - TABLET_IDLE_WARNING_MS >= 5000);
}

// -----------------------------------------------------------------------------
section('3. the stored record');
// -----------------------------------------------------------------------------
{
  const profile = createTabletProfile({ accessCode: 'abc123', language: 'ko', idleSeconds: 120 });
  const roundTrip = parseStoredTabletProfile(serializeTabletProfile(profile));
  check('a record round-trips', JSON.stringify(roundTrip) === JSON.stringify(profile));
  check('null storage is no profile', parseStoredTabletProfile(null) === null);
  check('malformed JSON is no profile', parseStoredTabletProfile('{nope') === null);
  check('an array is no profile', parseStoredTabletProfile('[]') === null);
  check('a record of another version is no profile', parseStoredTabletProfile('{"version":2,"accessCode":"A"}') === null);
  const hand = parseStoredTabletProfile('{"version":1,"accessCode":"a","idleSeconds":"7","pushToTalk":true,"companion":true,"voice":false}');
  check('a hand-edited record is re-validated', hand?.idleSeconds === MIN_TABLET_IDLE_SECONDS && hand.accessCode === 'A');
  check('the fixed fields cannot be edited on', hand?.pushToTalk === false && hand.companion === false && hand.voice === true);
}

// -----------------------------------------------------------------------------
section('4. the access code leaves the address bar');
// -----------------------------------------------------------------------------
{
  const stripped = stripTabletProfileFromUrl('/', '?profile=tablet&code=ABC123&idle=60&consent=on&motion=off&lang=ko', '');
  check('code, idle, consent, motion and profile are removed', stripped === '/?lang=ko', String(stripped));
  check(
    'lang is left for the language provider, which then removes it',
    stripLanguageFromUrl('/', '?lang=ko', '') === '/'
  );
  check('other parameters survive', stripTabletProfileFromUrl('/', '?profile=clear&layout=compact', '#x') === '/?layout=compact#x');
  check('a URL without a profile is left alone', stripTabletProfileFromUrl('/', '?code=ABC123', '') === null);
}

// -----------------------------------------------------------------------------
section('5. the idle reset');
// -----------------------------------------------------------------------------
{
  const base: TabletIdleInput = {
    nowMs: 1_000_000,
    lastActivityMs: 1_000_000,
    busy: false,
    idleSeconds: 180,
    bookingCompleteSinceMs: null,
  };
  const at = (secondsIdle: number, extra: Partial<TabletIdleInput> = {}) =>
    decideTabletIdle({ ...base, nowMs: base.lastActivityMs + secondsIdle * 1000, ...extra });

  check('fresh activity is active', at(0).kind === 'active');
  check('164 s idle is still active', at(164).kind === 'active');
  const warn = at(165);
  check('165 s idle shows the 15 s countdown', warn.kind === 'warning' && warn.secondsLeft === 15, JSON.stringify(warn));
  const warnLate = at(179.2);
  check('the countdown rounds up, never shows 0', warnLate.kind === 'warning' && warnLate.secondsLeft === 1);
  const reset = at(180);
  check('180 s idle resets', reset.kind === 'reset' && reset.reason === 'idle');
  check('an agent that is still talking is never reset', at(600, { busy: true }).kind === 'active');
  check('a visitor mid-utterance is never reset', at(600, { busy: true }).kind === 'active');
  check('a short profile idle resets on time', at(30, { idleSeconds: 30 }).kind === 'reset');
  check('a short profile idle warns 15 s before', at(15, { idleSeconds: 30 }).kind === 'warning');

  const completeAt = base.lastActivityMs;
  const shown = (seconds: number, extra: Partial<TabletIdleInput> = {}) =>
    decideTabletIdle({ ...base, bookingCompleteSinceMs: completeAt, nowMs: completeAt + seconds * 1000, ...extra });
  const justDone = shown(1);
  check(
    'the complete screen counts down from 20 s',
    justDone.kind === 'complete-countdown' && justDone.secondsLeft === TABLET_BOOKING_COMPLETE_RESET_MS / 1000 - 1,
    JSON.stringify(justDone)
  );
  const done = shown(20);
  check('20 s on the complete screen resets', done.kind === 'reset' && done.reason === 'booking-complete');
  check('the complete reset waits for the agent to finish speaking', shown(25, { busy: true }).kind === 'active');
  check(
    'and counts its 20 s from when the agent fell silent',
    shown(25, { lastActivityMs: completeAt + 10_000 }).kind === 'complete-countdown'
  );
  check(
    'the complete reset does not wait for the full idle window',
    shown(21, { idleSeconds: MAX_TABLET_IDLE_SECONDS }).kind === 'reset'
  );
}

// -----------------------------------------------------------------------------
section('6. a session found at launch (installed-PWA relaunch)');
// -----------------------------------------------------------------------------
{
  const now = 5_000_000;
  check(
    'resumed when the same visitor was active a moment ago',
    !shouldDiscardRestoredTabletSession({ nowMs: now, lastActivityMs: now - 20_000, idleSeconds: 180 })
  );
  check(
    'finished when nobody has touched the tablet for the idle window',
    shouldDiscardRestoredTabletSession({ nowMs: now, lastActivityMs: now - 180_000, idleSeconds: 180 })
  );
  check(
    'finished when there is no activity stamp at all',
    shouldDiscardRestoredTabletSession({ nowMs: now, lastActivityMs: null, idleSeconds: 180 })
  );
  check(
    'finished when the stamp is in the future (a clock that jumped)',
    shouldDiscardRestoredTabletSession({ nowMs: now, lastActivityMs: now + 3_600_000, idleSeconds: 180 })
  );
}

console.log(failures === 0 ? '\nall tablet profile checks passed' : `\n${failures} tablet profile check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
