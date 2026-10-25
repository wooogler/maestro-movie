/**
 * The booth tablet profile: what an unattended tablet needs to know so that a
 * visitor can tap once and talk.
 *
 * A booth tablet is set up once, by the presenter, by opening a profile URL:
 *
 *   /?profile=tablet&code=ABC123&lang=en&idle=180
 *
 * The profile is then stored on the device and the start page becomes a single
 * Start button. Nothing is a separate build: the same app, with a record in
 * localStorage that says "this device is a booth tablet".
 *
 * This module is the pure half: parsing the URL, validating a stored record,
 * filling defaults, and deciding when an idle tablet resets. It is DOM-free on
 * purpose (`tabletProfile.check.ts` runs it under node); the storage and URL
 * side effects live in `tabletProfileStorage.ts`.
 *
 * The access code in the URL is a bearer credential, exactly like the code in a
 * quick-card QR: anyone holding the URL can start sessions on the operator key
 * until the code is revoked. It is stripped from the address bar once read.
 */

import { matchLanguageTag, type Language } from '../i18n/language';

export const TABLET_PROFILE_PARAM = 'profile';
export const TABLET_PROFILE_STORAGE_KEY = 'tuning-movie-tablet-profile';

/** Query parameters the profile URL may carry, apart from `lang`, which the
 *  language provider reads (and strips) itself. */
export const TABLET_PROFILE_URL_PARAMS = ['profile', 'code', 'idle', 'consent', 'motion'] as const;

export const DEFAULT_TABLET_IDLE_SECONDS = 180;
/** Long enough to hold the 15-second "still there?" countdown and a few seconds before it. */
export const MIN_TABLET_IDLE_SECONDS = 20;
export const MAX_TABLET_IDLE_SECONDS = 3600;

/** The countdown shown before an idle reset. */
export const TABLET_IDLE_WARNING_MS = 15_000;
/** How long the booking-complete screen stays up before the tablet starts over. */
export const TABLET_BOOKING_COMPLETE_RESET_MS = 20_000;

export interface TabletProfile {
  version: 1;
  /** Demo access code, uppercased. Empty when the URL carried none. */
  accessCode: string;
  /** The language each new visitor starts in. They can still switch. */
  language: Language;
  /** Always true: a tablet visitor talks. */
  voice: true;
  /** Where the research-recording box starts. It stays visible either way. */
  researchConsent: boolean;
  /** Always false: VAD, no key to hold. */
  pushToTalk: false;
  /** Always false: the phone-as-mic pairing is meaningless on a tablet. */
  companion: false;
  /** No input, no agent activity and no touch for this long resets the session. */
  idleSeconds: number;
  /** True applies the app's reduced-motion CSS path. */
  reduceMotion: boolean;
}

export type TabletProfileUrlAction =
  | { kind: 'none' }
  | { kind: 'clear' }
  | { kind: 'apply'; profile: TabletProfile }
  | { kind: 'invalid'; reason: string };

function normalizeAccessCode(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().slice(0, 32);
}

/** Seconds, clamped to [MIN, MAX]; anything unparseable is the default. */
export function parseIdleSeconds(value: unknown): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TABLET_IDLE_SECONDS;
  return Math.min(MAX_TABLET_IDLE_SECONDS, Math.max(MIN_TABLET_IDLE_SECONDS, Math.round(raw)));
}

/** `on`/`off` style flags; null when absent or unrecognised. */
export function parseOnOff(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['on', '1', 'true', 'yes'].includes(normalized)) return true;
  if (['off', '0', 'false', 'no'].includes(normalized)) return false;
  return null;
}

export function createTabletProfile(input: {
  accessCode?: unknown;
  language?: unknown;
  researchConsent?: unknown;
  idleSeconds?: unknown;
  reduceMotion?: unknown;
}): TabletProfile {
  return {
    version: 1,
    accessCode: normalizeAccessCode(input.accessCode),
    language: matchLanguageTag(input.language) ?? 'en',
    voice: true,
    // Pre-ticked, as on the full demo's setup screen, unless the profile says otherwise.
    researchConsent: parseOnOff(input.researchConsent) ?? true,
    pushToTalk: false,
    companion: false,
    idleSeconds: parseIdleSeconds(input.idleSeconds),
    reduceMotion: parseOnOff(input.reduceMotion) ?? false,
  };
}

/**
 * What a URL's query says about the profile.
 *
 * `profile=tablet` applies (and overwrites) one, `profile=clear` removes it,
 * no `profile` parameter leaves the stored state alone. `motion=off` means
 * reduce motion, so the stored flag is its inverse.
 */
export function parseTabletProfileUrl(search: string): TabletProfileUrlAction {
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  if (!params.has(TABLET_PROFILE_PARAM)) return { kind: 'none' };
  const value = (params.get(TABLET_PROFILE_PARAM) ?? '').trim().toLowerCase();
  if (value === 'clear' || value === 'off' || value === 'none') return { kind: 'clear' };
  if (value !== 'tablet') return { kind: 'invalid', reason: `unknown profile "${value}"` };
  const motion = parseOnOff(params.get('motion'));
  return {
    kind: 'apply',
    profile: createTabletProfile({
      accessCode: params.get('code'),
      language: params.get('lang'),
      researchConsent: params.get('consent'),
      idleSeconds: params.get('idle'),
      reduceMotion: motion === null ? null : !motion,
    }),
  };
}

/** A stored record, validated; null for anything that is not a profile. */
export function parseStoredTabletProfile(raw: string | null | undefined): TabletProfile | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  return createTabletProfile({
    accessCode: record.accessCode,
    language: record.language,
    researchConsent: record.researchConsent,
    idleSeconds: record.idleSeconds,
    reduceMotion: record.reduceMotion,
  });
}

export function serializeTabletProfile(profile: TabletProfile): string {
  return JSON.stringify(profile);
}

/**
 * The same URL without the profile's parameters, or null when it carried none.
 * `lang` is left for the language provider, which reads and strips it itself.
 */
export function stripTabletProfileFromUrl(pathname: string, search: string, hash: string): string | null {
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  if (!params.has(TABLET_PROFILE_PARAM)) return null;
  for (const name of TABLET_PROFILE_URL_PARAMS) params.delete(name);
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}

// ---------------------------------------------------------------------------
// Idle reset
// ---------------------------------------------------------------------------

export type TabletIdleVerdict =
  | { kind: 'active' }
  /** The "still there?" countdown: any touch, input or agent activity cancels it. */
  | { kind: 'warning'; secondsLeft: number }
  /** The booking is done; the tablet starts over for the next visitor shortly. */
  | { kind: 'complete-countdown'; secondsLeft: number }
  | { kind: 'reset'; reason: 'idle' | 'booking-complete' };

export interface TabletIdleInput {
  nowMs: number;
  /** Last visitor input, touch, or agent activity. */
  lastActivityMs: number;
  /**
   * Something is happening right now: the agent is planning or speaking, the
   * visitor is mid-utterance, a stage is loading. Never reset under it.
   */
  busy: boolean;
  idleSeconds: number;
  /** When the booking-complete screen appeared, or null while it is not shown. */
  bookingCompleteSinceMs: number | null;
}

export function decideTabletIdle(input: TabletIdleInput): TabletIdleVerdict {
  if (input.busy) return { kind: 'active' };
  const idleMs = parseIdleSeconds(input.idleSeconds) * 1000;
  if (input.bookingCompleteSinceMs !== null) {
    // Measured from the later of "the screen appeared" and "the agent fell
    // silent", so the confirmation is never cut off mid-sentence.
    const since = Math.max(input.bookingCompleteSinceMs, input.lastActivityMs);
    const shown = input.nowMs - since;
    if (shown >= TABLET_BOOKING_COMPLETE_RESET_MS) return { kind: 'reset', reason: 'booking-complete' };
    return {
      kind: 'complete-countdown',
      secondsLeft: Math.max(1, Math.ceil((TABLET_BOOKING_COMPLETE_RESET_MS - shown) / 1000)),
    };
  }
  const elapsed = input.nowMs - input.lastActivityMs;
  if (elapsed >= idleMs) return { kind: 'reset', reason: 'idle' };
  if (elapsed >= idleMs - TABLET_IDLE_WARNING_MS) {
    return { kind: 'warning', secondsLeft: Math.max(1, Math.ceil((idleMs - elapsed) / 1000)) };
  }
  return { kind: 'active' };
}

/**
 * Whether a session record found at launch should be finished rather than
 * resumed. The installed PWA resumes a running session after a relaunch; on a
 * booth tablet that is only right if the same visitor is still there, which is
 * what a recent activity stamp says. No stamp, or one older than the idle
 * window, means the next visitor would inherit the previous one's booking.
 */
export function shouldDiscardRestoredTabletSession(input: {
  nowMs: number;
  lastActivityMs: number | null;
  idleSeconds: number;
}): boolean {
  if (input.lastActivityMs === null || !Number.isFinite(input.lastActivityMs)) return true;
  if (input.lastActivityMs > input.nowMs + 60_000) return true; // a clock that jumped back
  return input.nowMs - input.lastActivityMs >= parseIdleSeconds(input.idleSeconds) * 1000;
}
