import {
  getStudyModeConfig,
  normalizeStudyMode,
  type StudyModeConfig,
  type StudyModeId,
} from '../pages/studyOptions';

export interface StudyScenarioStepBriefs {
  movie?: string;
  theater?: string;
  date?: string;
  time?: string;
  seat?: string;
  confirm?: string;
}

export interface StudyScenarioSummary {
  id: string;
  title: string;
  background?: string;
  story?: string;
  stepBriefs?: StudyScenarioStepBriefs;
  narratorPreferenceTypes?: string[];
  seatRows?: string[];
  /**
   * The day this scenario's world is set on. Absent for the study scenarios,
   * which are built against FIXED_CURRENT_DATE.
   */
  todayIso?: string;
  dateWindowDays?: number;
}

export interface StudyScenarioDetail extends StudyScenarioSummary {
  background: string;
  story: string;
  stepBriefs: StudyScenarioStepBriefs;
  narratorPreferenceTypes: string[];
  seatRows: string[];
}

export interface StudySessionState {
  sessionId: string;
  relaySessionId: string;
  participantId: string;
  loggingParticipantId: string | null;
  interactionLogFile: string | null;
  /**
   * Whether this session has an LLM trace to download. Tracked separately from
   * `interactionLogFile` because they are separate decisions for a study
   * session; a demo session has both or neither, depending on consent.
   */
  hasLlmTrace?: boolean;
  conditionLabel: string;
  studyToken: string;
  /**
   * Read-only pairing token for a second device, rendered as a QR in the demo.
   * Distinct from `studyToken` on purpose: that one authorises the host role,
   * the trace download and finishing the session.
   */
  viewToken?: string;
  expiresAt: string;
  studyMode: StudyModeId;
  studyModeConfig: StudyModeConfig;
  scenario: StudyScenarioSummary;
}

// The running session and the visitor's credentials -- their own OpenAI key,
// or the booth's access code -- live in localStorage, not sessionStorage.
//
// They used to be sessionStorage so that they died with the tab. That was fine
// in a browser tab, but the booth runs as an installed PWA, and closing an
// installed app ends its browsing session: every reopen came back with an empty
// code field and the presenter had to hand the card over again. Codes are
// reusable by design (see `demoAccessCodes.ts`) and one code runs a whole event,
// so the code is simply the kind of thing that should survive a relaunch.
//
// The key gets the same treatment because the same relaunch wiped it, and
// because a visitor who typed their own key did so on their own device. The
// trade-off is real, so it is stated: a key pasted into a shared tablet now
// outlives the session until the field is cleared or the storage is wiped. It
// still never reaches a request log, and clearing the field removes it.
//
// The session record is the third thing the relaunch wiped, and the most
// visible: a visitor who closed the app mid-booking came back to the start page
// while their backend session and its agent process lived on, unreachable,
// until the idle reaper took them. Persisting the record is only half of the
// fix, though. A stored record is a CLAIM that a session is running, not
// proof, and the booth runs one stranger after another: a finished, expired or
// reaped session must never resurrect for the next visitor. So the record is
// dropped here the moment its own `expiresAt` has passed, and App.tsx confirms
// every restored record against GET /study/sessions/me before it shows the
// booking page, clearing it on anything but a live answer.
const STUDY_SESSION_STORAGE_KEY = 'tuning-movie-study-session';
const OPENAI_API_KEY_STORAGE_KEY = 'tuning-movie-openai-key';
const DEMO_ACCESS_CODE_STORAGE_KEY = 'tuning-movie-demo-access-code';
const DEMO_MODE_STORAGE_KEY = 'tuning-movie-demo-mode';

/**
 * Reads a persisted value, preferring localStorage and falling back to the
 * sessionStorage slot it used to live in. The fallback is for a tab that was
 * open across the deploy that moved these: without it that visitor's typed
 * credential, or their running session, would vanish on the first reload after
 * the change. Whatever it finds in the old slot is promoted and the old slot is
 * emptied.
 */
function readPersistentValue(storageKey: string): string {
  if (typeof window === 'undefined') return '';
  try {
    const value = window.localStorage.getItem(storageKey);
    if (typeof value === 'string' && value) return value;
  } catch {
    // Fall through to the legacy slot.
  }
  try {
    const legacy = window.sessionStorage.getItem(storageKey);
    if (typeof legacy === 'string' && legacy) {
      try {
        window.localStorage.setItem(storageKey, legacy);
        window.sessionStorage.removeItem(storageKey);
      } catch {
        // Promotion is best-effort; the value is still returned.
      }
      return legacy;
    }
  } catch {
    // Ignore storage failures.
  }
  return '';
}

function writePersistentValue(storageKey: string, value: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = value.trim();
  try {
    if (!trimmed) {
      window.localStorage.removeItem(storageKey);
    } else {
      window.localStorage.setItem(storageKey, trimmed);
    }
  } catch {
    // Ignore storage failures.
  }
  try {
    // Never leave a stale copy in the old slot: it would shadow a later clear.
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Whether a session record is past its own `expiresAt`.
 *
 * The client-side half of the resurrection guard: a record that is obviously
 * dead is not worth a request, and sending one would also hand the dead token
 * to every request header until the 401 came back. An `expiresAt` that does
 * not parse is left to the backend to judge -- that is a malformed record, not
 * an expired one, and the backend's own check reads it the same way.
 */
export function isStudySessionExpired(
  session: Pick<StudySessionState, 'expiresAt'>,
  nowMs: number = Date.now()
): boolean {
  const expiresAtMs = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

function readStoredStudySessionRecord(): StudySessionState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = readPersistentValue(STUDY_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StudySessionState>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.relaySessionId !== 'string' ||
      typeof parsed.participantId !== 'string' ||
      typeof parsed.conditionLabel !== 'string' ||
      typeof parsed.studyToken !== 'string' ||
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.studyMode !== 'string' ||
      !parsed.studyModeConfig ||
      typeof parsed.studyModeConfig !== 'object' ||
      !parsed.scenario ||
      typeof parsed.scenario !== 'object' ||
      typeof parsed.scenario.id !== 'string' ||
      typeof parsed.scenario.title !== 'string'
    ) {
      return null;
    }
    const studyMode = normalizeStudyMode(parsed.studyMode);
    return {
      ...(parsed as Omit<StudySessionState, 'studyMode' | 'studyModeConfig' | 'loggingParticipantId' | 'interactionLogFile'>),
      loggingParticipantId:
        typeof parsed.loggingParticipantId === 'string' && parsed.loggingParticipantId.trim()
          ? parsed.loggingParticipantId.trim()
          : null,
      interactionLogFile:
        typeof parsed.interactionLogFile === 'string' && parsed.interactionLogFile.trim()
          ? parsed.interactionLogFile.trim()
          : null,
      studyMode,
      studyModeConfig: getStudyModeConfig(studyMode),
    };
  } catch {
    return null;
  }
}

/**
 * The stored session, or null if there is none or the stored one has expired.
 *
 * An expired record is reported as absent rather than removed here: this is
 * read from several state initialisers in one render and from every API
 * request's header builder, and none of those is the place for a storage
 * write. `clearExpiredStoredStudySession` is, once, at mount.
 */
export function getStoredStudySession(): StudySessionState | null {
  const session = readStoredStudySessionRecord();
  if (!session || isStudySessionExpired(session)) return null;
  return session;
}

/**
 * Whether storage holds a record whose `expiresAt` has passed. A pure read, so
 * it can answer from a state initialiser: the visitor is told their session
 * ended rather than silently shown the start page.
 */
export function hasExpiredStoredStudySession(): boolean {
  const session = readStoredStudySessionRecord();
  return Boolean(session && isStudySessionExpired(session));
}

/**
 * Removes that expired record. Credentials are left alone: they are still
 * good, and this is exactly the "came back later" path they were persisted for.
 */
export function clearExpiredStoredStudySession(): void {
  if (!hasExpiredStoredStudySession()) return;
  clearStoredStudySession({ keepCredentials: true });
}

export function setStoredStudySession(session: StudySessionState): void {
  writePersistentValue(STUDY_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export interface ClearStoredStudySessionOptions {
  /**
   * Keep whichever credential the visitor typed -- the OpenAI key or the booth
   * access code. Used on every path that ends a session and sends the visitor
   * back to the start page: finishing a task, a study token going stale on a
   * backend restart, and a stored session that turned out to be expired or
   * unknown when the app came back. In all of these the credential is still
   * good, so re-typing it would be pure friction.
   */
  keepCredentials?: boolean;
}

export function clearStoredStudySession(options?: ClearStoredStudySessionOptions): void {
  if (typeof window === 'undefined') return;
  // Empties both the current slot and the legacy sessionStorage one.
  writePersistentValue(STUDY_SESSION_STORAGE_KEY, '');
  if (!options?.keepCredentials) {
    clearStoredApiKey();
    clearStoredAccessCode();
  }
}

export function getStoredApiKey(): string {
  return readPersistentValue(OPENAI_API_KEY_STORAGE_KEY);
}

export function setStoredApiKey(value: string): void {
  writePersistentValue(OPENAI_API_KEY_STORAGE_KEY, value);
}

export function clearStoredApiKey(): void {
  writePersistentValue(OPENAI_API_KEY_STORAGE_KEY, '');
}

export function getStoredAccessCode(): string {
  return readPersistentValue(DEMO_ACCESS_CODE_STORAGE_KEY);
}

export function setStoredAccessCode(value: string): void {
  writePersistentValue(DEMO_ACCESS_CODE_STORAGE_KEY, value);
}

export function clearStoredAccessCode(): void {
  writePersistentValue(DEMO_ACCESS_CODE_STORAGE_KEY, '');
}

/**
 * Tri-state: null means the visitor has never chosen, which lets the app open in
 * demo mode by default without overriding someone who deliberately left it.
 */
export function getStoredDemoModePreference(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(DEMO_MODE_STORAGE_KEY);
    if (raw === null) return null;
    return raw === '1';
  } catch {
    return null;
  }
}

export function getStoredDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(DEMO_MODE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setStoredDemoMode(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      window.sessionStorage.setItem(DEMO_MODE_STORAGE_KEY, '1');
    } else {
      window.sessionStorage.removeItem(DEMO_MODE_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}
