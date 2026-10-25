import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LanguageProvider, useLanguage } from './i18n';
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
import {
  api,
  describeApiErrorCode,
  STUDY_SESSION_INVALID_EVENT,
  type StudySessionInvalidDetail,
} from './api/client';
import {
  clearTabletActivity,
  finishStudySessionByToken,
  getTabletProfile,
  stampTabletActivity,
} from './study/tabletProfileStorage';
import type { TabletResetRequest } from './components/tablet/TabletSessionControls';
import { useScreenWakeLock } from './hooks/useScreenWakeLock';
import { TabletStartScreen } from './components/tablet/TabletStartScreen';
import type { VoiceOutputTarget } from './hooks/useVoiceCompanionHost';
import {
  clearStoredStudySession,
  clearExpiredStoredStudySession,
  getStoredAccessCode,
  getStoredApiKey,
  getStoredDemoModePreference,
  getStoredStudySession,
  hasExpiredStoredStudySession,
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

// The demo's research-recording box is opt-out: every visitor arrives with it
// ticked. Both the initial state and every end-of-session reset use this, so the
// next visitor starts from the default rather than from the last one's choice.
const DEFAULT_DEMO_RESEARCH_CONSENT = true;

function DemoModeEntry({ onEnter }: { onEnter: () => void }) {
  useEffect(() => {
    onEnter();
  }, [onEnter]);
  return <Navigate to="/" replace />;
}

/*
  What /booking shows while a session restored from storage is being confirmed
  with the backend. Deliberately not ChatPage: mounting that joins the relay,
  mints a pairing token and starts logging on the strength of a record that may
  describe a session the backend has already finished or reaped.
*/
function RestoringSessionScreen() {
  const { s } = useLanguage();
  return (
    <main className="flex h-full items-center justify-center bg-dark px-6">
      <p className="text-sm text-fg-muted">{s.loading}</p>
    </main>
  );
}

function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  // The booth is the common case, so the app opens in demo mode unless a session
  // is already running as a study condition or the visitor deliberately left it.
  const [demoMode, setDemoMode] = useState<boolean>(() => {
    const session = getStoredStudySession();
    if (session) return isDemoStudyMode(session.studyMode);
    // A booth tablet is a demo device; its one-tap screen has no way out of it.
    if (getTabletProfile()) return true;
    return getStoredDemoModePreference() ?? true;
  });
  /*
    The booth tablet profile, read once (bootTabletProfile in main.tsx has
    already applied any profile URL). Demo only: a study condition on the same
    device runs exactly as it would without one.
  */
  const [tabletProfile] = useState(getTabletProfile);
  const tabletActive = Boolean(tabletProfile) && demoMode;
  // An unattended tablet must not dim between visitors, nor mid-sentence.
  // Best effort: Android's "stay awake while charging" is the real guarantee.
  useScreenWakeLock(tabletActive);
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

    Opt-out: the box starts ticked, and a visitor who would rather not be
    recorded unticks it.

    Deliberately not persisted anywhere. A booth runs one stranger after another
    in the same tab, and a stored choice would answer the question on behalf of
    the next person to walk up -- in particular, one visitor's "no" must not
    silently carry over to the next. It starts at DEFAULT_DEMO_RESEARCH_CONSENT
    for every visitor and is put back there the moment a session ends.

    The session record IS persisted (see sessionStorage.ts), so after the
    installed app is closed and reopened mid-session this flag is back at its
    default while the session carries on. That is correct, because the flag is only
    ever consulted when a session is CREATED: ScenarioReviewPage sends it with
    POST /study/sessions, and the backend decides there, once, whether the
    session gets an interaction log and an LLM trace. From then on logging is
    governed by the record -- `interactionLogFile` in the stored session state
    is what useStudyInteractionLogger keys on, and the backend keeps appending
    to the file it opened. So a consented session goes on logging after a
    relaunch, and one whose visitor unticked the box has no log file,
    cannot acquire one, and nothing on the restored path asks again.
  */
  const [demoResearchConsent, setDemoResearchConsent] = useState(DEFAULT_DEMO_RESEARCH_CONSENT);
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
  /** Whether that card visitor pressed "start and talk" rather than "start and type". */
  const [quickDemoCardVoice, setQuickDemoCardVoice] = useState(true);

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
  // Opens with the "session ended" notice when the record in storage is past
  // its own `expiresAt`: every initialiser below already treats that record as
  // absent, and the effect further down removes it. Nothing is sent for it --
  // see isStudySessionExpired.
  const [sessionNotice, setSessionNotice] = useState<string | null>(() =>
    hasExpiredStoredStudySession() ? SESSION_ENDED_MESSAGE : null
  );
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
    The session that came back from storage at mount, and whether the backend
    has confirmed it since.

    A stored record outlives the app now (installed PWA, closed and reopened),
    so it may describe a session the backend finished, expired or reaped in the
    meantime. Until GET /study/sessions/me answers, /booking shows a holding
    screen rather than ChatPage, and `/` -- the PWA's start URL, which is where
    a relaunch lands -- sends the visitor back into their booking instead of to
    the start page. Keyed on the session id so that a session created later in
    this page's life never inherits the restored status, and dropped on every
    path that ends a session.
  */
  const [restoredSession, setRestoredSession] = useState<{
    sessionId: string;
    verified: boolean;
  } | null>(() => {
    const stored = getStoredStudySession();
    return stored ? { sessionId: stored.sessionId, verified: false } : null;
  });
  const restoringSession = Boolean(
    studySession && restoredSession && restoredSession.sessionId === studySession.sessionId
  );
  const restoringSessionPending = restoringSession && !restoredSession?.verified;

  useEffect(() => {
    // Once, at mount: the storage write that the notice initialiser above
    // could not do. Idempotent, so StrictMode's second pass is harmless.
    clearExpiredStoredStudySession();
  }, []);

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
    // A tablet never shows the pairing QR, so it has nothing to mint.
    if (tabletActive) return;
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
  }, [demoSessionId, tabletActive]);

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
    setRestoredSession(null);
    setSessionNotice(null);
    // The next visitor answers for themselves, starting from the default.
    setDemoResearchConsent(DEFAULT_DEMO_RESEARCH_CONSENT);
    setQuickDemoCard(null);
  };

  // A stale study token (a backend restart, since demo sessions live in memory
  // by design; or a session that was finished, expired or reaped while the
  // installed app was closed) should drop the user back on the start page with
  // an explanation -- but keep the credential they already typed.
  const handleStaleStudySession = useCallback(() => {
    clearStoredStudySession({ keepCredentials: true });
    setSelectedScenarioTitle(null);
    setStudySession(null);
    setRestoredSession(null);
    setSessionNotice(SESSION_ENDED_MESSAGE);
    setDemoResearchConsent(DEFAULT_DEMO_RESEARCH_CONSENT);
    setQuickDemoCard(null);
  }, []);

  // The current session's token, for telling a stale rejection apart from a
  // live one (see StudySessionInvalidDetail).
  const currentStudyTokenRef = useRef<string | null>(studySession?.studyToken ?? null);
  currentStudyTokenRef.current = studySession?.studyToken ?? null;

  useEffect(() => {
    const handleSessionInvalid = (event: Event) => {
      const rejected = (event as CustomEvent<StudySessionInvalidDetail | undefined>).detail?.studyToken ?? null;
      // A late request from a session that already ended — a tablet's previous
      // visitor, finished on purpose a moment ago — says nothing about the
      // session running now.
      if (rejected && rejected !== currentStudyTokenRef.current) return;
      handleStaleStudySession();
    };
    window.addEventListener(STUDY_SESSION_INVALID_EVENT, handleSessionInvalid);
    return () => {
      window.removeEventListener(STUDY_SESSION_INVALID_EVENT, handleSessionInvalid);
    };
  }, [handleStaleStudySession]);

  /*
    A booth tablet starting over: the visitor pressed "Start over", walked
    away (idle reset), or finished their booking.

    The record leaves storage first and synchronously, so an installed-PWA
    relaunch from here on finds nothing to resume. Setting the session to null
    is what sends /booking back to `/`: ChatPage unmounts, and its own cleanup
    tears down the Realtime voice session and closes the relay socket. The
    backend is told last, with the token captured here — the stored record is
    already gone — and after the booking page's last log line, or two seconds,
    whichever comes first. A finish that fails is not retried: the server's own
    idle reaper still ends the session.
  */
  const handleTabletStartOver = useCallback((request: TabletResetRequest) => {
    const token = currentStudyTokenRef.current;
    clearStoredStudySession({ keepCredentials: true });
    clearTabletActivity();
    handleStudyReset();
    if (!token) return;
    const settled = new Promise<void>((resolve) => window.setTimeout(resolve, 2000));
    void Promise.race([request.beforeFinish.catch(() => {}), settled]).then(() =>
      finishStudySessionByToken(token).then((ok) => {
        console.info(`[tablet] start over (${request.reason}): session finish ${ok ? 'ok' : 'failed'}`);
      })
    );
    // handleStudyReset is a plain function that only sets state; it is stable
    // in behaviour, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTabletSessionStarted = useCallback((session: StudySessionState) => {
    stampTabletActivity(Date.now(), true);
    handleStudySessionCreated(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setRestoredSession(null);
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
  const handleQuickCardStarted = (
    session: StudySessionState,
    card: QuickDemoCard,
    { voice }: { voice: boolean }
  ) => {
    setQuickDemoCard(card);
    setQuickDemoCardVoice(voice);
    handleStudySessionCreated(session);
  };

  /*
    Confirms the session with the backend and refreshes the scenario text.

    For a session restored from storage this is also the gate on the booking
    page: `restoredSession` stays unverified, and /booking stays on its holding
    screen, until the backend has answered for this exact session id. Any
    failure -- a 401 for a finished, expired or reaped session, or a backend
    that cannot be reached -- ends the session on this side, so a dead record
    never resurrects for the next visitor to pick up the tablet.
  */
  useEffect(() => {
    if (!studySession) return;
    api.getCurrentStudySession()
      .then((sessionInfo) => {
        setRestoredSession((prev) =>
          prev && !prev.verified && prev.sessionId === sessionInfo.sessionId
            ? { ...prev, verified: true }
            : prev
        );
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
      {/* Browser-language detection for the booth only; a study condition opens
          in English unless someone chose otherwise, as it always did. */}
      <LanguageProvider detectBrowserLanguage={demoMode}>
        <DevToolsProvider>
          <div className="app-viewport flex">
            <div className="flex-1 overflow-hidden bg-dark text-fg">
              <Routes>
                <Route
                  path="/"
                  element={restoringSession || (tabletActive && studySession) ? (
                    // The PWA's start URL. A relaunch mid-session lands here,
                    // and the visitor's booking is the only sensible place to
                    // be; /booking decides whether it is still live. On a
                    // booth tablet the same holds for a Back gesture: the
                    // one-tap screen with a session still running would let a
                    // second Start strand the first. Start over is the way out.
                    <Navigate to="/booking" replace />
                  ) : tabletActive && tabletProfile ? (
                    // A booth tablet: one line, the language, one button.
                    <TabletStartScreen
                      profile={tabletProfile}
                      onSessionStarted={handleTabletSessionStarted}
                    />
                  ) : (
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
                  )}
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
                  element={restoringSessionPending ? (
                    <RestoringSessionScreen />
                  ) : studySession ? (
                    <ChatPage
                      studyModePreset={effectiveStudyMode}
                      studySession={studySession}
                      // A tablet visitor starts empty: the preset picker is
                      // not on its start screen.
                      preferenceProfile={tabletActive ? null : preferenceProfile}
                      companionToken={tabletActive ? null : companionToken}
                      voiceTargetPreference={tabletActive ? 'kiosk' : voiceTargetPreference}
                      quickStartCard={quickDemoCard}
                      // A card visitor tapped "start and talk" one screen ago;
                      // making them find the mic button would undo the point.
                      // The same holds for the full demo: the visitor tapped
                      // "start booking" on the pairing screen, which is also
                      // where the audio element is unlocked — a booth visit
                      // should begin listening and speaking, not with a hunt
                      // for the mic button. Study conditions keep the toggle.
                      // A card visitor who pressed "start and type" instead
                      // asked for the opposite, so that one starts with voice
                      // off and the composer ready to type.
                      startWithVoice={quickDemoCard ? quickDemoCardVoice : demoMode}
                      tabletProfile={tabletActive ? tabletProfile : null}
                      onTabletStartOver={handleTabletStartOver}
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
