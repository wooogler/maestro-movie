/**
 * The demo start screen's standby session.
 *
 * The start screen shows the "use your phone as the mic" QR, and a pairing
 * token can only be minted against a session that exists. So while the start
 * screen is up and a credential is stored, one demo session is created ahead
 * of the visitor and waits. Start promotes it — the same session, so the phone
 * that scanned the QR is still paired on the booking page and the token is
 * never re-minted (minting revokes the previous pairing; see App.tsx).
 *
 * What makes this safe to hold:
 *  - The research-recording answer is fixed when a session is created (the
 *    backend decides the log file there, once). A visitor who changes the box
 *    gets a new standby with their answer, and the old one is finished. The
 *    replaced session never had a visitor: it holds the session-start line
 *    and nothing else.
 *  - A demo session is reaped after 15 min without an authenticated request,
 *    and ends 60 min after it was created. A heartbeat keeps it alive while
 *    the screen waits, and a standby with less than 25 min left is replaced
 *    (only while nobody is touching the screen), so a visitor always gets a
 *    session with room for a booking.
 *  - Leaving the start screen without Start (the About page, demo mode off,
 *    closing the tab) finishes it, so it never holds a demo slot for nobody.
 *
 * A module-level store rather than component state, so StrictMode's simulated
 * unmount and remount — and the page re-rendering on every keystroke — never
 * create a second session: a release is a short grace timer that the next
 * request cancels.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { DEMO_SCENARIO_ID, DEMO_STUDY_MODE } from '../pages/studyOptions';
import type { StudySessionState } from './sessionStorage';
import { finishStudySessionByToken } from './tabletProfileStorage';

export interface StandbyRequest {
  /** Exactly one credential, as on the session POST. */
  credential: { accessCode: string } | { apiKey: string };
  researchConsent: boolean;
}

export type StandbySnapshot =
  | { status: 'idle' }
  | { status: 'creating' }
  | { status: 'ready'; session: StudySessionState }
  | { status: 'error'; message: string };

const HEARTBEAT_MS = 4 * 60_000;
/** Replace a standby with less than this left before its hard expiry. */
const MIN_REMAINING_MS = 25 * 60_000;
/** Never swap the QR under a visitor's finger. */
const QUIET_BEFORE_REFRESH_MS = 60_000;
/** StrictMode's unmount/remount and a route bounce both land inside this. */
const RELEASE_GRACE_MS = 150;
/** A changed box waits this long, so toggling it twice creates one session, not two. */
const CHANGE_DEBOUNCE_MS = 500;

interface Slot {
  key: string;
  request: StandbyRequest;
  promise: Promise<StudySessionState>;
  session: StudySessionState | null;
  discarded: boolean;
}

let slot: Slot | null = null;
let snapshot: StandbySnapshot = { status: 'idle' };
let releaseTimer: number | null = null;
let requestTimer: number | null = null;
let heartbeatTimer: number | null = null;
let lastInteractionMs = 0;
let pageHooksInstalled = false;
const listeners = new Set<() => void>();

function setSnapshot(next: StandbySnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Holds the credential, so it lives in memory only — like the request itself. */
function requestKey(request: StandbyRequest): string {
  const credential =
    'accessCode' in request.credential
      ? `code:${request.credential.accessCode}`
      : `key:${request.credential.apiKey}`;
  return `${credential}|consent:${request.researchConsent ? 1 : 0}`;
}

function clearTimer(timer: number | null): null {
  if (timer !== null) window.clearTimeout(timer);
  return null;
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function discard(target: Slot): void {
  target.discarded = true;
  // One still being created is finished by its own resolution handler.
  if (target.session) void finishStudySessionByToken(target.session.studyToken);
}

function installPageHooks(): void {
  if (pageHooksInstalled || typeof window === 'undefined') return;
  pageHooksInstalled = true;
  const markInteraction = () => {
    lastInteractionMs = Date.now();
  };
  window.addEventListener('pointerdown', markInteraction, { capture: true, passive: true });
  window.addEventListener('keydown', markInteraction, { capture: true, passive: true });
  // Closing or reloading the tab: nobody will start this one.
  window.addEventListener('pagehide', () => {
    if (slot?.session) void finishStudySessionByToken(slot.session.studyToken);
  });
  // Back from the bfcache, the session finished on the way out is dead.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && slot) replace(slot.request);
  });
}

function heartbeat(): void {
  const current = slot;
  if (!current?.session) return;
  const remaining = Date.parse(current.session.expiresAt) - Date.now();
  if (Number.isFinite(remaining) && remaining < MIN_REMAINING_MS) {
    if (Date.now() - lastInteractionMs >= QUIET_BEFORE_REFRESH_MS) replace(current.request);
    return;
  }
  // An authenticated request is what the backend's idle reaper counts. A 401
  // here names this token, which is not App's current session, so App ignores
  // it; the standby is simply replaced.
  api.getCurrentStudySession(current.session.studyToken).catch(() => {
    if (slot === current) replace(current.request);
  });
}

function create(request: StandbyRequest): Slot {
  const created: Slot = {
    key: requestKey(request),
    request,
    session: null,
    discarded: false,
    promise: Promise.resolve(null as unknown as StudySessionState),
  };
  created.promise = api
    .createStudySession({
      scenarioId: DEMO_SCENARIO_ID,
      studyMode: DEMO_STUDY_MODE,
      ...request.credential,
      researchConsent: request.researchConsent,
    })
    .then(
      (session) => {
        if (created.discarded) {
          void finishStudySessionByToken(session.studyToken);
          throw new Error('standby session replaced');
        }
        created.session = session;
        if (slot === created) {
          setSnapshot({ status: 'ready', session });
          stopHeartbeat();
          heartbeatTimer = window.setInterval(heartbeat, HEARTBEAT_MS);
        }
        return session;
      },
      (error: unknown) => {
        if (slot === created) {
          setSnapshot({
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not prepare the demo session.',
          });
        }
        throw error;
      }
    );
  // Awaited by a Start that may never come; a rejection nobody awaits is not an error.
  created.promise.catch(() => {});
  return created;
}

function replace(request: StandbyRequest): void {
  installPageHooks();
  stopHeartbeat();
  if (slot) discard(slot);
  slot = create(request);
  setSnapshot({ status: 'creating' });
}

function ensure(request: StandbyRequest): void {
  if (slot && slot.key === requestKey(request) && snapshot.status !== 'error') return;
  replace(request);
}

/** Keep a standby for this request: created at once, or after a short debounce when one is already held. */
export function requestStandby(request: StandbyRequest): void {
  releaseTimer = clearTimer(releaseTimer);
  requestTimer = clearTimer(requestTimer);
  if (!slot) {
    ensure(request);
    return;
  }
  if (slot.key === requestKey(request) && snapshot.status !== 'error') return;
  requestTimer = window.setTimeout(() => {
    requestTimer = null;
    ensure(request);
  }, CHANGE_DEBOUNCE_MS);
}

/** The start screen is going away (or has no credential): finish the standby after a short grace. */
export function releaseStandby(): void {
  requestTimer = clearTimer(requestTimer);
  releaseTimer = clearTimer(releaseTimer);
  releaseTimer = window.setTimeout(() => {
    releaseTimer = null;
    stopHeartbeat();
    if (slot) discard(slot);
    slot = null;
    setSnapshot({ status: 'idle' });
  }, RELEASE_GRACE_MS);
}

/**
 * Start: hand over the standby for this request — waiting for it if it is
 * still being created, creating it if there is none or it failed — and stop
 * managing it. From here it is App's session like any other.
 */
export async function takeStandby(request: StandbyRequest): Promise<StudySessionState> {
  releaseTimer = clearTimer(releaseTimer);
  requestTimer = clearTimer(requestTimer);
  ensure(request);
  const taken = slot as Slot;
  const session = await taken.promise;
  if (slot === taken) {
    stopHeartbeat();
    slot = null;
    setSnapshot({ status: 'idle' });
  }
  return session;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): StandbySnapshot {
  return snapshot;
}

/** Holds a standby for `request` while mounted; null holds none. */
export function useDemoStandbySession(request: StandbyRequest | null): StandbySnapshot {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const requestRef = useRef(request);
  requestRef.current = request;
  const key = request ? requestKey(request) : null;
  useEffect(() => {
    const latest = requestRef.current;
    if (latest) requestStandby(latest);
    else releaseStandby();
    return () => releaseStandby();
  }, [key]);
  return current;
}
