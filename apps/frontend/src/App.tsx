import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LanguageProvider } from './i18n';
import { ChatPage } from './pages/ChatPage';
import {
  createProfileFromPreset,
  findPreferencePreset,
} from './study/preferenceProfile';
import { StudyStartPage } from './pages/StudyStartPage';
import { ScenarioReviewPage } from './pages/ScenarioReviewPage';
import { StudyEndPage } from './pages/StudyEndPage';
import { PerTrialSurveyPage } from './pages/PerTrialSurveyPage';
import { PostStudySurveyPage } from './pages/PostStudySurveyPage';
import { DemoCompanionPage } from './pages/DemoCompanionPage';
import { DemoMemoryMirrorPage } from './pages/DemoMemoryMirrorPage';
import { DemoCardPage } from './pages/DemoCardPage';
import { DemoCardGalleryPage } from './pages/DemoCardGalleryPage';
import { AboutPage } from './pages/AboutPage';
import type { QuickDemoCard } from './study/quickDemoCards';
import {
  DEFAULT_STUDY_MODE,
  DEMO_STUDY_MODE,
  isDemoStudyMode,
  sanitizeSetupStudyMode,
  type StudyModeId,
} from './pages/studyOptions';
import { api, describeApiErrorCode, STUDY_SESSION_INVALID_EVENT } from './api/client';
import type { VoiceOutputTarget } from './hooks/useVoiceCompanionHost';
import {
  clearStoredStudySession,
  getStoredAccessCode,
  getStoredApiKey,
  getStoredDemoModePreference,
  getStoredStudySession,
  setStoredAccessCode,
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
  // Both credentials persist across a relaunch (see sessionStorage.ts for the
  // PWA reason). Access codes are reusable by design -- one code runs a whole
  // event -- so the code a visitor typed is still good after they finish, and
  // the presenter should not have to hand the card over again for the next
  // visitor, after a reload, or after the installed app is closed and reopened.
  const [accessCode, setAccessCode] = useState<string>(() => getStoredAccessCode());
  // Open on whichever credential is actually stored. A visitor who pasted their
  // own key and relaunched would otherwise land on the code tab with the key
  // field hidden, which reads exactly like the key having been lost.
  const [demoCredentialMode, setDemoCredentialMode] = useState<'code' | 'key'>(() =>
    !getStoredAccessCode() && getStoredApiKey() ? 'key' : 'code'
  );
  /*
    Whether the current demo visitor agreed to be recorded.

    Deliberately not persisted anywhere. A booth runs one stranger after another
    in the same tab, and a stored `true` would answer the question on behalf of
    the next person to walk up. It starts false for every visitor and is cleared
    again the moment a session ends.
  */
  const [demoResearchConsent, setDemoResearchConsent] = useState(false);
  /*
    The preference memory the next demo session opens with.

    Deliberately not persisted, for the same reason as the consent flag above: a
    booth runs one stranger after another in the same tab. It also does not need
    to be — the "memory outlives the session" claim is what the demo ARGUES, and
    a preset is how that state is simulated, not how it is stored.

    The revision only ever counts up. It is the agent's idempotence key: the
    profile rides every snapshot, and an unchanged revision makes a re-send a
    no-op rather than something that could undo a removal made since.
  */
  /*
    The phone-pairing token, minted here because two screens now show its QR:
    the "ready to start" screen and the booking rail.

    Minting rotates the pairing's revocation handle, so a per-screen fetch would
    hand out a code and then kill it the moment the other screen mounted —
    including killing a phone that had already scanned and was working. One
    owner, one mint, passed down. Held against the session it belongs to and
    read back only for that session, so a new session cannot inherit the
    previous visitor's pairing.
  */
  const [companionPairing, setCompanionPairing] = useState<{
    sessionId: string;
    token: string;
  } | null>(null);

  /*
    Where the visitor said they want to hear and speak, chosen on the pairing
    screen before a phone has attached.

    A preference rather than a live switch: nothing is capturing yet, so picking
    the phone here cannot mute anything. The booking page honours it the moment
    a phone actually announces itself.
  */
  const [voiceTargetPreference, setVoiceTargetPreference] =
    useState<VoiceOutputTarget>('kiosk');

  /*
    The quick-demo card this session was opened by, if any.

    Held here rather than in the page that read the QR because the booking route
    is a sibling, not a child: the card face navigates to `/booking`, and this is
    the only place that can hand ChatPage the card once it gets there.

    Deliberately not persisted. It is a property of ONE session — the visitor who
    scanned it — and a booth runs one stranger after another in the same tab, so
    a stored card would land the next person mid-workflow in a scene they never
    chose. The cost is that a reload of /booking drops back to the movie list,
    which is the right failure: the session is still theirs and still works.
  */
  const [quickDemoCard, setQuickDemoCard] = useState<QuickDemoCard | null>(null);

  const [preferencePresetId, setPreferencePresetId] = useState<string | null>(null);
  const [preferenceProfileRevision, setPreferenceProfileRevision] = useState(0);
  const handlePreferencePresetChange = useCallback((presetId: string | null) => {
    setPreferencePresetId(presetId);
    setPreferenceProfileRevision((revision) => revision + 1);
  }, []);


  const preferenceProfile = useMemo(() => {
    if (!preferencePresetId) return null;
    const preset = findPreferencePreset(preferencePresetId);
    return preset ? createProfileFromPreset(preset, preferenceProfileRevision) : null;
  }, [preferencePresetId, preferenceProfileRevision]);
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

  /*
    Read back only for the session it was minted against, rather than cleared
    from an effect: a stale token would otherwise be handed to the next
    session's QR for one render, which is long enough to photograph.
  */
  const demoSessionId = demoMode ? (studySession?.sessionId ?? null) : null;
  const companionToken =
    companionPairing && companionPairing.sessionId === demoSessionId
      ? companionPairing.token
      : null;

  /*
    Guarded by a ref, and with no cleanup flag. Both details are load-bearing.

    Minting REVOKES the previous pairing, so a second call is not a wasted
    request — it kills the code already on screen, and a phone that scanned it
    joins as `unpaired`, where the audio button renders disabled. StrictMode
    runs this twice on mount, and on a reload straight into a stored session the
    id is already there on the first render, so both passes would mint.

    A `cancelled` flag would then break the other way: StrictMode's cleanup runs
    between the two passes, so the one surviving mint would be discarded and the
    QR would stay empty forever. Nothing needs cancelling instead — the token is
    stored against its session id and only read back for that session, so a
    result arriving late is ignored rather than shown.
  */
  const companionMintedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!demoSessionId || companionMintedForRef.current === demoSessionId) return;
    companionMintedForRef.current = demoSessionId;
    api
      .createCompanionPairing()
      .then((result) => {
        setCompanionPairing({ sessionId: demoSessionId, token: result.companionToken });
      })
      .catch(() => {
        // Includes the 403 a non-demo session gets. The QR simply does not render.
        if (companionMintedForRef.current === demoSessionId) {
          companionMintedForRef.current = null;
        }
      });
  }, [demoSessionId]);

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

  // Persisted so an installed PWA that is closed and reopened comes back with
  // the credential still filled in; emptying the field removes it.
  useEffect(() => {
    setStoredApiKey(apiKey);
  }, [apiKey]);

  useEffect(() => {
    setStoredAccessCode(accessCode);
  }, [accessCode]);

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

  // Ending a task drops the visitor back on setup, but the credential they typed
  // -- pasted key or booth access code -- is good for the whole browser session:
  // clearing it here would force a re-entry on the most common post-task path.
  const handleStudyReset = () => {
    clearStoredStudySession({ keepCredentials: true });
    setSelectedScenarioTitle(null);
    setStudySession(null);
    setSessionNotice(null);
    // The next visitor answers for themselves.
    setDemoResearchConsent(false);
    setQuickDemoCard(null);
  };

  // A stale study token (typically a backend restart: demo sessions live in memory
  // by design) should drop the user back on the start page with an explanation --
  // but keep the credential they already typed.
  const handleStaleStudySession = useCallback(() => {
    clearStoredStudySession({ keepCredentials: true });
    setSelectedScenarioTitle(null);
    setStudySession(null);
    setSessionNotice(SESSION_ENDED_MESSAGE);
    setDemoResearchConsent(false);
    setQuickDemoCard(null);
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

  /*
    A scanned quick-demo card starting its session.

    Reuses the ordinary path above — the session is a normal demo session and
    everything downstream (storage, mode, scenario, the agent) must treat it as
    one — and only adds the card, which is the single thing that differs: where
    ChatPage opens.
  */
  const handleQuickCardStarted = (session: StudySessionState, card: QuickDemoCard) => {
    setQuickDemoCard(card);
    handleStudySessionCreated(session);
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
      <LanguageProvider>
        <DevToolsProvider>
          <div className="app-viewport flex">
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
                      preferencePresetId={preferencePresetId}
                      onPreferencePresetChange={handlePreferencePresetChange}
                      researchConsent={demoResearchConsent}
                      onResearchConsentChange={setDemoResearchConsent}
                      sessionNotice={sessionNotice}
                      onDismissSessionNotice={() => setSessionNotice(null)}
                    />
                  }
                />
                <Route path="/demo" element={<DemoModeEntry onEnter={handleEnterDemoMode} />} />
                {/* What a printed quick-demo card's QR opens: one stage, one
                    sentence. Its own route rather than a mode of the setup page
                    because it shares nothing with it — no scenario picker, no
                    consent question, no pairing step, and a credential that
                    arrives in the URL fragment instead of being typed. */}
                <Route
                  path="/demo/card"
                  element={<DemoCardPage onCardStarted={handleQuickCardStarted} />}
                />
                {/* The same five links as QR codes, for the presenter's screen. */}
                <Route path="/demo/cards" element={<DemoCardGalleryPage />} />
                {/* What the demo is, for anyone who arrives without a presenter.
                    Needs no session and calls no API. */}
                <Route path="/about" element={<AboutPage />} />
                {/* Second-screen mirror for the booth. Opened in its own window; it
                    listens to the booking window rather than joining the relay. */}
                <Route path="/demo/memory" element={<DemoMemoryMirrorPage />} />
                {/* The paired phone acting as the session's mic and speaker.
                    Its own route rather than a mode of the mirror above: this
                    one joins the relay as a write-capable companion, asks for
                    microphone permission, and holds a wake lock. */}
                <Route path="/demo/companion" element={<DemoCompanionPage />} />
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
                      researchConsent={demoResearchConsent}
                      companionToken={companionToken}
                      voiceTarget={voiceTargetPreference}
                      onVoiceTargetChange={setVoiceTargetPreference}
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
                      preferenceProfile={preferenceProfile}
                      companionToken={companionToken}
                      voiceTargetPreference={voiceTargetPreference}
                      quickStartCard={quickDemoCard}
                      // A card visitor tapped "start and talk" one screen ago;
                      // making them find the mic button would undo the point.
                      startWithVoice={Boolean(quickDemoCard)}
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
      </LanguageProvider>
    </BrowserRouter>
  );
}

export default App;
