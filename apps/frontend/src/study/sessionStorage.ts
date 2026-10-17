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

const STUDY_SESSION_STORAGE_KEY = 'tuning-movie-study-session';
// The visitor's credentials -- their own OpenAI key, or the booth's access code
// -- live in localStorage, not sessionStorage.
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
const OPENAI_API_KEY_STORAGE_KEY = 'tuning-movie-openai-key';
const DEMO_ACCESS_CODE_STORAGE_KEY = 'tuning-movie-demo-access-code';
const DEMO_MODE_STORAGE_KEY = 'tuning-movie-demo-mode';

/**
 * Reads a credential, preferring localStorage and falling back to the
 * sessionStorage slot it used to live in. The fallback is for a tab that was
 * open across the deploy that moved these: without it that visitor's typed
 * credential would vanish on the first reload after the change. Whatever it
 * finds in the old slot is promoted and the old slot is emptied.
 */
function readPersistentCredential(storageKey: string): string {
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

function writePersistentCredential(storageKey: string, value: string): void {
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

export function getStoredStudySession(): StudySessionState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STUDY_SESSION_STORAGE_KEY);
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

export function setStoredStudySession(session: StudySessionState): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STUDY_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Ignore storage failures.
  }
}

export interface ClearStoredStudySessionOptions {
  /**
   * Keep whichever credential the visitor typed -- the OpenAI key or the booth
   * access code. Used on every path that ends a session and sends the visitor
   * back to the start page: finishing a task, and a study token going stale on a
   * backend restart. In both cases the credential is still good, so re-typing it
   * would be pure friction.
   */
  keepCredentials?: boolean;
}

export function clearStoredStudySession(options?: ClearStoredStudySessionOptions): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STUDY_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
  if (!options?.keepCredentials) {
    clearStoredApiKey();
    clearStoredAccessCode();
  }
}

export function getStoredApiKey(): string {
  return readPersistentCredential(OPENAI_API_KEY_STORAGE_KEY);
}

export function setStoredApiKey(value: string): void {
  writePersistentCredential(OPENAI_API_KEY_STORAGE_KEY, value);
}

export function clearStoredApiKey(): void {
  writePersistentCredential(OPENAI_API_KEY_STORAGE_KEY, '');
}

export function getStoredAccessCode(): string {
  return readPersistentCredential(DEMO_ACCESS_CODE_STORAGE_KEY);
}

export function setStoredAccessCode(value: string): void {
  writePersistentCredential(DEMO_ACCESS_CODE_STORAGE_KEY, value);
}

export function clearStoredAccessCode(): void {
  writePersistentCredential(DEMO_ACCESS_CODE_STORAGE_KEY, '');
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
