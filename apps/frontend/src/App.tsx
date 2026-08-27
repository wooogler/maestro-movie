import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ChatPage } from './pages/ChatPage';
import { StudyStartPage } from './pages/StudyStartPage';
import { ScenarioReviewPage } from './pages/ScenarioReviewPage';
import { StudyEndPage } from './pages/StudyEndPage';
import { PerTrialSurveyPage } from './pages/PerTrialSurveyPage';
import { PostStudySurveyPage } from './pages/PostStudySurveyPage';
import { DemoMemoryMirrorPage } from './pages/DemoMemoryMirrorPage';
import {
  DEFAULT_STUDY_MODE,
  DEMO_STUDY_MODE,
  isDemoStudyMode,
  sanitizeSetupStudyMode,
  type StudyModeId,
} from './pages/studyOptions';
import { api, describeApiErrorCode, STUDY_SESSION_INVALID_EVENT } from './api/client';
import {
  clearStoredStudySession,
  getStoredApiKey,
  getStoredDemoModePreference,
  getStoredStudySession,
  setStoredApiKey,
  setStoredDemoMode,
  setStoredStudySession,
  type StudySessionState,
} from './study/sessionStorage';
import { DevToolsProvider } from './components/DevToolsContext';
import { DevTools } from './components/DevTools';
import './App.css';

type Theme = 'dark' | 'light';

const THEME_STORAGE_KEY = 'tuning-movie-theme';
const PID_LOGGING_STORAGE_KEY = 'tuning-movie-logging-participant-id';
const STUDY_MODE_STORAGE_KEY = 'tuning-movie-study-mode-selection';
const SCENARIO_SELECTION_STORAGE_KEY = 'tuning-movie-scenario-selection';
const AGENT_CONSOLE_ENABLED = !import.meta.env.PROD;

function getInitialTheme(): Theme {
  return 'light';
}

function getStoredLoggingParticipantId(): string {
  if (typeof window === 'undefined') return '';
  try {
    const value = window.localStorage.getItem(PID_LOGGING_STORAGE_KEY);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function getStoredStudyModeSelection(): StudyModeId | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(STUDY_MODE_STORAGE_KEY);
    return value ? (value as StudyModeId) : null;
  } catch {
    return null;
  }
}

function getStoredScenarioSelection(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(SCENARIO_SELECTION_STORAGE_KEY);
  } catch {
    return null;
  }
}

const SESSION_ENDED_MESSAGE =
  describeApiErrorCode('STUDY_SESSION_UNAUTHORIZED') ??
  'This session has ended. Please start again from the beginning.';

function DemoModeEntry({ onEnter }: { onEnter: () => void }) {
  useEffect(() => {
    onEnter();
  }, [onEnter]);
  return <Navigate to="/" replace />;
}

function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  // The booth is the common case, so the app opens in demo mode unless a session
  // is already running as a study condition or the visitor deliberately left it.
  const [demoMode, setDemoMode] = useState<boolean>(() => {
    const session = getStoredStudySession();
    if (session) return isDemoStudyMode(session.studyMode);
    return getStoredDemoModePreference() ?? true;
  });
  const [apiKey, setApiKey] = useState<string>(() => getStoredApiKey());
  // Deliberately not persisted: an access code is single-use, so restoring one
  // from a previous visit would only ever produce "already used".
  const [accessCode, setAccessCode] = useState<string>('');
  const [demoCredentialMode, setDemoCredentialMode] = useState<'code' | 'key'>('code');
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  // `studyMode` only ever holds a real study condition. Demo is tracked separately
  // through `demoMode` so entering/leaving the demo never rewrites the persisted
  // study condition selection.
  const [studyMode, setStudyMode] = useState<StudyModeId>(() => {
    const storedSessionMode = getStoredStudySession()?.studyMode;
    const candidate =
      (storedSessionMode && !isDemoStudyMode(storedSessionMode) ? storedSessionMode : null) ??
      getStoredStudyModeSelection() ??
      DEFAULT_STUDY_MODE;
    return sanitizeSetupStudyMode(isDemoStudyMode(candidate) ? DEFAULT_STUDY_MODE : candidate);
  });
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(() =>
    getStoredStudySession()?.scenario.id ?? getStoredScenarioSelection()
  );
  const [selectedScenarioTitle, setSelectedScenarioTitle] = useState<string | null>(() =>
    getStoredStudySession()?.scenario.title ?? null
  );
  const [loggingParticipantId, setLoggingParticipantId] = useState<string>(() => {
    const storedPid = getStoredLoggingParticipantId();
    if (storedPid) return storedPid;
    return getStoredStudySession()?.loggingParticipantId ?? '';
  });
  const [studySession, setStudySession] = useState<StudySessionState | null>(() =>
    getStoredStudySession()
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    // Demo visitors have no participant ID, and nothing about them is persisted.
    if (demoMode) return;
    try {
      window.localStorage.setItem(PID_LOGGING_STORAGE_KEY, loggingParticipantId);
    } catch {
      // Ignore storage write failures.
    }
  }, [demoMode, loggingParticipantId]);

  // sessionStorage only, and never localStorage: the key must die with the tab.
  useEffect(() => {
    setStoredApiKey(apiKey);
  }, [apiKey]);

  useEffect(() => {
    setStoredDemoMode(demoMode);
  }, [demoMode]);

  useEffect(() => {
    if (studyMode !== sanitizeSetupStudyMode(studyMode)) {
      setStudyMode(sanitizeSetupStudyMode(studyMode));
      return;
    }
    try {
      window.localStorage.setItem(STUDY_MODE_STORAGE_KEY, studyMode);
    } catch {
      // Ignore storage write failures.
    }
  }, [studyMode]);

  useEffect(() => {
    try {
      if (selectedScenarioId) {
        window.localStorage.setItem(SCENARIO_SELECTION_STORAGE_KEY, selectedScenarioId);
      }
    } catch {
      // Ignore storage write failures.
    }
  }, [selectedScenarioId]);

  const handleThemeToggle = () => {
    setTheme('light');
  };

  // Ending a task drops the visitor back on setup, but the key they pasted is
  // theirs for the whole browser session: clearing it here would force a
  // re-entry on the most common post-task path.
  const handleStudyReset = () => {
    clearStoredStudySession({ keepApiKey: true });
    setSelectedScenarioTitle(null);
    setStudySession(null);
    setSessionNotice(null);
  };

  // A stale study token (typically a backend restart: demo sessions live in memory
  // by design) should drop the user back on the start page with an explanation --
  // but keep the key they already typed.
  const handleStaleStudySession = useCallback(() => {
    clearStoredStudySession({ keepApiKey: true });
    setSelectedScenarioTitle(null);
    setStudySession(null);
    setSessionNotice(SESSION_ENDED_MESSAGE);
  }, []);

  useEffect(() => {
    const handleSessionInvalid = () => {
      handleStaleStudySession();
    };
    window.addEventListener(STUDY_SESSION_INVALID_EVENT, handleSessionInvalid);
    return () => {
      window.removeEventListener(STUDY_SESSION_INVALID_EVENT, handleSessionInvalid);
    };
  }, [handleStaleStudySession]);

  const handleEnterDemoMode = useCallback(() => {
    setDemoMode(true);
    setSessionNotice(null);
  }, []);

  const handleDemoModeChange = (enabled: boolean) => {
    setDemoMode(enabled);
    setSessionNotice(null);
  };

  const handleStudySessionCreated = (session: StudySessionState) => {
    setStoredStudySession(session);
    setStudySession(session);
    setSessionNotice(null);
    if (isDemoStudyMode(session.studyMode)) {
      setDemoMode(true);
    } else {
      setDemoMode(false);
      setStudyMode(session.studyMode);
    }
    setSelectedScenarioId(session.scenario.id);
    setSelectedScenarioTitle(session.scenario.title);
    setLoggingParticipantId(session.loggingParticipantId ?? '');
  };

  useEffect(() => {
    if (!studySession) return;
    api.getCurrentStudySession()
      .then((sessionInfo) => {
        setStudySession((prev) => {
          if (!prev || prev.sessionId !== sessionInfo.sessionId) return prev;
          const prevBackground = prev.scenario.background ?? '';
          const nextBackground = sessionInfo.scenario.background;
          const prevStory = prev.scenario.story ?? '';
          const nextStory = sessionInfo.scenario.story;
          const prevStepBriefs = prev.scenario.stepBriefs ?? {};
          const nextStepBriefs = sessionInfo.scenario.stepBriefs;
          const prevPrefs = prev.scenario.narratorPreferenceTypes ?? [];
          const nextPrefs = sessionInfo.scenario.narratorPreferenceTypes;
          const prevSeatRows = prev.scenario.seatRows ?? [];
          const nextSeatRows = sessionInfo.scenario.seatRows ?? [];
          const sameBackground = prevBackground === nextBackground;
          const sameStory = prevStory === nextStory;
          const sameStepBriefs =
            JSON.stringify(prevStepBriefs) === JSON.stringify(nextStepBriefs);
          const samePrefs =
            prevPrefs.length === nextPrefs.length &&
            prevPrefs.every((value, index) => value === nextPrefs[index]);
          const sameSeatRows =
            prevSeatRows.length === nextSeatRows.length &&
            prevSeatRows.every((value, index) => value === nextSeatRows[index]);
          if (sameBackground && sameStory && sameStepBriefs && samePrefs && sameSeatRows) {
            return prev;
          }

          const nextSession: StudySessionState = {
            ...prev,
            scenario: {
              ...prev.scenario,
              background: sessionInfo.scenario.background,
              story: sessionInfo.scenario.story,
              stepBriefs: sessionInfo.scenario.stepBriefs,
              narratorPreferenceTypes: sessionInfo.scenario.narratorPreferenceTypes,
              seatRows: sessionInfo.scenario.seatRows,
            },
          };
          setStoredStudySession(nextSession);
          return nextSession;
        });
      })
      .catch(() => {
        handleStaleStudySession();
      });
  }, [handleStaleStudySession, studySession]);

  const effectiveStudyMode: StudyModeId = demoMode ? DEMO_STUDY_MODE : studyMode;

  return (
    <BrowserRouter>
      <DevToolsProvider>
        <div className="flex h-screen">
          <div className="flex-1 overflow-hidden bg-dark text-fg">
            <Routes>
              <Route
                path="/"
                element={
                  <StudyStartPage
                    theme={theme}
                    onThemeToggle={handleThemeToggle}
                    selectedMode={studyMode}
                    onModeChange={setStudyMode}
                    selectedScenarioId={selectedScenarioId}
                    onScenarioChange={setSelectedScenarioId}
                    loggingParticipantId={loggingParticipantId}
                    onLoggingParticipantIdChange={setLoggingParticipantId}
                    apiKey={apiKey}
                    onApiKeyChange={setApiKey}
                    accessCode={accessCode}
                    onAccessCodeChange={setAccessCode}
                    demoCredentialMode={demoCredentialMode}
                    onDemoCredentialModeChange={setDemoCredentialMode}
                    demoMode={demoMode}
                    onDemoModeChange={handleDemoModeChange}
                    sessionNotice={sessionNotice}
                    onDismissSessionNotice={() => setSessionNotice(null)}
                  />
                }
              />
              <Route path="/demo" element={<DemoModeEntry onEnter={handleEnterDemoMode} />} />
              {/* Second-screen mirror for the booth. Opened in its own window; it
                  listens to the booking window rather than joining the relay. */}
              <Route path="/demo/memory" element={<DemoMemoryMirrorPage />} />
              <Route
                path="/task-review"
                element={selectedScenarioId ? (
                  <ScenarioReviewPage
                    studyMode={effectiveStudyMode}
                    selectedScenarioId={selectedScenarioId}
                    loggingParticipantId={loggingParticipantId}
                    apiKey={apiKey}
                    accessCode={accessCode}
                    demoCredentialMode={demoCredentialMode}
                    demoMode={demoMode}
                    onSessionCreated={handleStudySessionCreated}
                  />
                ) : (
                  <Navigate to="/" replace />
                )}
              />
              <Route
                path="/booking"
                element={studySession ? (
                  <ChatPage
                    studyModePreset={effectiveStudyMode}
                    studySession={studySession}
                  />
                ) : (
                  <Navigate to="/" replace />
                )}
              />
              <Route
                path="/end"
                element={
                  <StudyEndPage
                    selectedScenarioTitle={selectedScenarioTitle}
                    studySession={studySession}
                    onResetMode={handleStudyReset}
                  />
                }
              />
              <Route
                path="/survey/per-trial"
                element={demoMode ? (
                  <Navigate to="/" replace />
                ) : (
                  <PerTrialSurveyPage
                    loggingParticipantId={loggingParticipantId}
                  />
                )}
              />
              <Route
                path="/survey/post-study"
                element={demoMode ? (
                  <Navigate to="/" replace />
                ) : (
                  <PostStudySurveyPage
                    loggingParticipantId={loggingParticipantId}
                  />
                )}
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
          {AGENT_CONSOLE_ENABLED ? <DevTools /> : null}
        </div>
      </DevToolsProvider>
    </BrowserRouter>
  );
}

export default App;
