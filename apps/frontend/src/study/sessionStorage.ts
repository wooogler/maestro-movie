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
  conditionLabel: string;
  studyToken: string;
  expiresAt: string;
  studyMode: StudyModeId;
  studyModeConfig: StudyModeConfig;
  scenario: StudyScenarioSummary;
}

const STUDY_SESSION_STORAGE_KEY = 'tuning-movie-study-session';
// Visitor-supplied OpenAI key. sessionStorage ONLY: it must never outlive the
// browser session, and must never reach localStorage or any request log.
const OPENAI_API_KEY_STORAGE_KEY = 'tuning-movie-openai-key';
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
   * Keep the visitor-supplied OpenAI key in sessionStorage. Used when a session
   * token went stale (backend restart) and we send the visitor back to the start
   * page: the key is still theirs, so re-typing it would be pure friction.
   */
  keepApiKey?: boolean;
}

export function clearStoredStudySession(options?: ClearStoredStudySessionOptions): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STUDY_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
  if (!options?.keepApiKey) {
    clearStoredApiKey();
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
