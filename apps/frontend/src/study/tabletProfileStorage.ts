/**
 * The DOM half of the tablet profile: localStorage, the address bar, the
 * reduced-motion flag on <html>, and the boot-time decision about a session
 * found in storage. The parsing and every decision are in `tabletProfile.ts`.
 */

import { useSyncExternalStore } from 'react';
import { LANGUAGE_STORAGE_KEY } from '../i18n/language';
import {
  TABLET_PROFILE_STORAGE_KEY,
  parseStoredTabletProfile,
  parseTabletProfileUrl,
  serializeTabletProfile,
  shouldDiscardRestoredTabletSession,
  stripTabletProfileFromUrl,
  type TabletProfile,
} from './tabletProfile';
import {
  clearStoredStudySession,
  getStoredStudySession,
  setStoredDemoMode,
} from './sessionStorage';
import { isDemoStudyMode } from '../pages/studyOptions';

const REDUCE_MOTION_STORAGE_KEY = 'tuning-movie-reduce-motion';
const TABLET_ACTIVITY_STORAGE_KEY = 'tuning-movie-tablet-last-activity';
/** The same header `api/client.ts` sends; duplicated so boot needs no client import cycle. */
const STUDY_TOKEN_HEADER = 'x-study-session-token';
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

function readLocal(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage disabled: the setting holds for this page only.
  }
}

// ---------------------------------------------------------------------------
// The profile record
// ---------------------------------------------------------------------------

/**
 * Read once per page load. The profile changes only through a profile URL,
 * which is handled before the first render, so nothing needs to subscribe.
 */
let cachedProfile: TabletProfile | null | undefined;

export function getTabletProfile(): TabletProfile | null {
  if (cachedProfile === undefined) {
    cachedProfile = parseStoredTabletProfile(readLocal(TABLET_PROFILE_STORAGE_KEY));
  }
  return cachedProfile;
}

function setTabletProfile(profile: TabletProfile | null): void {
  cachedProfile = profile;
  writeLocal(TABLET_PROFILE_STORAGE_KEY, profile ? serializeTabletProfile(profile) : null);
}

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

const motionListeners = new Set<() => void>();

export function readReduceMotion(): boolean {
  return readLocal(REDUCE_MOTION_STORAGE_KEY) === '1';
}

/**
 * `<html data-motion="reduced">` is what the CSS keys on, next to the
 * `prefers-reduced-motion` media query; `prefersReducedMotion()` reads it too.
 */
export function applyReduceMotion(reduce: boolean): void {
  if (typeof document === 'undefined') return;
  if (reduce) document.documentElement.dataset.motion = 'reduced';
  else delete document.documentElement.dataset.motion;
}

export function setReduceMotion(reduce: boolean): void {
  writeLocal(REDUCE_MOTION_STORAGE_KEY, reduce ? '1' : null);
  applyReduceMotion(reduce);
  for (const listener of motionListeners) listener();
}

function subscribeMotion(listener: () => void): () => void {
  motionListeners.add(listener);
  return () => motionListeners.delete(listener);
}

/** The Settings sheet's switch. */
export function useReduceMotionSetting(): [boolean, (reduce: boolean) => void] {
  const value = useSyncExternalStore(subscribeMotion, readReduceMotion, () => false);
  return [value, setReduceMotion];
}

// ---------------------------------------------------------------------------
// The activity stamp
// ---------------------------------------------------------------------------

let lastStampWrittenMs = 0;

/**
 * Written as the visitor and the agent do things, at most every few seconds,
 * so that a relaunch can tell "the same visitor, a moment ago" from "a tablet
 * nobody has touched for ten minutes".
 */
export function stampTabletActivity(nowMs: number = Date.now(), force = false): void {
  if (!force && nowMs - lastStampWrittenMs < 5_000) return;
  lastStampWrittenMs = nowMs;
  writeLocal(TABLET_ACTIVITY_STORAGE_KEY, String(nowMs));
}

export function clearTabletActivity(): void {
  lastStampWrittenMs = 0;
  writeLocal(TABLET_ACTIVITY_STORAGE_KEY, null);
}

function readTabletActivity(): number | null {
  const raw = readLocal(TABLET_ACTIVITY_STORAGE_KEY);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Finishing a session from outside the booking page
// ---------------------------------------------------------------------------

/**
 * POST /study/sessions/finish with an explicit token, keepalive so it survives
 * the page being torn down. Resolves whatever happens: a tablet reset must
 * never wait on, or fail because of, the network.
 */
export async function finishStudySessionByToken(studyToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/study/sessions/finish`, {
      method: 'POST',
      headers: { [STUDY_TOKEN_HEADER]: studyToken },
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export interface TabletBootResult {
  profile: TabletProfile | null;
  /** What the URL did, for a console line during setup. */
  urlAction: 'none' | 'applied' | 'cleared' | 'invalid';
  /** A stored session was finished instead of resumed. */
  discardedSession: boolean;
}

/**
 * Runs once, before React renders: applies or clears a profile carried by the
 * URL, strips the profile's parameters (the access code among them) from the
 * address bar, applies the reduced-motion flag, and decides whether a session
 * left in storage by an earlier launch may be resumed.
 */
export function bootTabletProfile(): TabletBootResult {
  if (typeof window === 'undefined') {
    return { profile: null, urlAction: 'none', discardedSession: false };
  }
  const { pathname, search, hash } = window.location;
  const action = parseTabletProfileUrl(search);
  let urlAction: TabletBootResult['urlAction'] = 'none';

  if (action.kind === 'apply') {
    setTabletProfile(action.profile);
    // The visitor-facing language starts at the profile's. `?lang=` is also
    // read by the language provider; writing it here covers a URL without it.
    writeLocal(LANGUAGE_STORAGE_KEY, action.profile.language);
    setReduceMotion(action.profile.reduceMotion);
    setStoredDemoMode(true);
    stampTabletActivity(Date.now(), true);
    urlAction = 'applied';
  } else if (action.kind === 'clear') {
    setTabletProfile(null);
    setReduceMotion(false);
    clearTabletActivity();
    urlAction = 'cleared';
  } else if (action.kind === 'invalid') {
    urlAction = 'invalid';
  }

  const stripped = stripTabletProfileFromUrl(pathname, search, hash);
  if (stripped !== null) window.history.replaceState(window.history.state, '', stripped);

  applyReduceMotion(readReduceMotion());

  const profile = getTabletProfile();
  let discardedSession = false;
  if (profile) {
    const stored = getStoredStudySession();
    if (
      stored &&
      isDemoStudyMode(stored.studyMode) &&
      shouldDiscardRestoredTabletSession({
        nowMs: Date.now(),
        lastActivityMs: readTabletActivity(),
        idleSeconds: profile.idleSeconds,
      })
    ) {
      void finishStudySessionByToken(stored.studyToken);
      clearStoredStudySession({ keepCredentials: true });
      clearTabletActivity();
      discardedSession = true;
    }
  }

  return { profile, urlAction, discardedSession };
}
