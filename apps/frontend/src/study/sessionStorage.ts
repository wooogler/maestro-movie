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
// Visitor-supplied OpenAI key. sessionStorage ONLY: it must never outlive the
// browser session, and must never reach localStorage or any request log.
const OPENAI_API_KEY_STORAGE_KEY = 'tuning-movie-openai-key';
// The booth's access code. Held on the same terms as the key above --
// sessionStorage, so it dies with the tab -- but for a different reason. Codes
// are reusable by design (see `demoAccessCodes.ts`), and one code runs a whole
// event, so a visitor finishing a demo must not leave the next one staring at an
// empty field with the card already back in the presenter's hand.
const DEMO_ACCESS_CODE_STORAGE_KEY = 'tuning-movie-demo-access-code';
const DEMO_MODE_STORAGE_KEY = 'tuning-movie-demo-mode';

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
  if (typeof window === 'undefined') return '';
  try {
    const value = window.sessionStorage.getItem(OPENAI_API_KEY_STORAGE_KEY);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export function setStoredApiKey(value: string): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = value.trim();
    if (!trimmed) {
      window.sessionStorage.removeItem(OPENAI_API_KEY_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(OPENAI_API_KEY_STORAGE_KEY, trimmed);
  } catch {
    // Ignore storage failures.
  }
}

export function clearStoredApiKey(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(OPENAI_API_KEY_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function getStoredAccessCode(): string {
  if (typeof window === 'undefined') return '';
  try {
    const value = window.sessionStorage.getItem(DEMO_ACCESS_CODE_STORAGE_KEY);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export function setStoredAccessCode(value: string): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = value.trim();
    if (!trimmed) {
      window.sessionStorage.removeItem(DEMO_ACCESS_CODE_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(DEMO_ACCESS_CODE_STORAGE_KEY, trimmed);
  } catch {
    // Ignore storage failures.
  }
}

export function clearStoredAccessCode(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(DEMO_ACCESS_CODE_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
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
