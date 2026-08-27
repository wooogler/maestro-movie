import { useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  describeApiErrorCode,
  getApiErrorCode,
  OPENAI_API_KEY_MISSING,
} from '../api/client';
import {
  CONDITION_SELECTION_OPTIONS,
  DEMO_SCENARIO_ID,
  getInterfaceCondition,
  getInteractionMode,
  getStudyModeFromConditionSelection,
  type StudyModeId,
} from './studyOptions';
import type { StudyScenarioDetail } from '../study/sessionStorage';
import { formatScenarioTitle, isHardTaskScenario } from '../utils/displayFormats';
import { queuePendingStudyLogEvent } from '../study/pendingInteractionEvents';

type Theme = 'dark' | 'light';
const VOICE_CHECK_STATUS_STORAGE_KEY = 'study_voice_check_status_v1';
const TUTORIAL_SCENARIO_ID = 'scn_t1_solo_weekend_3d_tutorial';
const SHOW_TUTORIAL_SCENARIO = !import.meta.env.PROD;
const TUTORIAL_VIDEO_ID = 'e7k_tedv9N0';
const TUTORIAL_VIDEO_EMBED_URL = `https://www.youtube-nocookie.com/embed/${TUTORIAL_VIDEO_ID}?rel=0`;
const TUTORIAL_VIDEO_WATCH_URL = `https://youtu.be/${TUTORIAL_VIDEO_ID}`;

interface StudyStartPageProps {
  theme: Theme;
  onThemeToggle: () => void;
  selectedMode: StudyModeId;
  onModeChange: (mode: StudyModeId) => void;
  selectedScenarioId: string | null;
  onScenarioChange: (scenarioId: string) => void;
  loggingParticipantId: string;
  onLoggingParticipantIdChange: (participantId: string) => void;
  apiKey: string;
  onApiKeyChange: (apiKey: string) => void;
  accessCode: string;
  onAccessCodeChange: (accessCode: string) => void;
  demoCredentialMode: 'code' | 'key';
  onDemoCredentialModeChange: (mode: 'code' | 'key') => void;
  demoMode: boolean;
  onDemoModeChange: (demoMode: boolean) => void;
  sessionNotice?: string | null;
  onDismissSessionNotice?: () => void;
}

function deriveSetLabel(scenarioId: string | null): string | null {
  if (!scenarioId) return null;
  const match = scenarioId.match(/^scn_s(\d+)_t[12]_/i);
  if (!match) return null;
  const setNumber = Number.parseInt(match[1], 10);
  if (!Number.isInteger(setNumber) || setNumber < 1 || setNumber > 26) return null;
  return `Set ${String.fromCharCode(64 + setNumber)}`;
}

function getScenarioGridSortKey(scenario: StudyScenarioDetail): [number, number, number, string] {
  if (scenario.id === TUTORIAL_SCENARIO_ID) {
    return [0, 0, 0, scenario.title];
  }

  const labeledScenarioMatch = scenario.title.match(/^S(\d+)-T(\d+):/i);
  if (labeledScenarioMatch) {
    const scenarioGroup = Number.parseInt(labeledScenarioMatch[1], 10);
    const taskIndex = Number.parseInt(labeledScenarioMatch[2], 10);
    return [1, scenarioGroup, taskIndex, scenario.title];
  }

  return [2, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, scenario.title];
}

export function StudyStartPage({
  theme,
  onThemeToggle,
  selectedMode,
  onModeChange,
  selectedScenarioId,
  onScenarioChange,
  loggingParticipantId,
  onLoggingParticipantIdChange,
  apiKey,
  onApiKeyChange,
  accessCode,
  onAccessCodeChange,
  demoCredentialMode,
  onDemoCredentialModeChange,
  demoMode,
  onDemoModeChange,
  sessionNotice = null,
  onDismissSessionNotice,
}: StudyStartPageProps) {
  const navigate = useNavigate();
  const [loadingScenarios, setLoadingScenarios] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<StudyScenarioDetail[]>([]);
  const [voiceCheckOpen, setVoiceCheckOpen] = useState(false);
  const [tutorialVideoOpen, setTutorialVideoOpen] = useState(false);
  const [voiceCheckError, setVoiceCheckError] = useState<string | null>(null);
  const [micCheckStatus, setMicCheckStatus] = useState<'idle' | 'checking' | 'granted' | 'denied'>('idle');
  const [speakerCheckStatus, setSpeakerCheckStatus] = useState<'idle' | 'playing' | 'played' | 'confirmed' | 'error'>('idle');
  const [voiceCheckLoading, setVoiceCheckLoading] = useState<'none' | 'mic' | 'speaker'>('none');
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewAudioUrlRef = useRef<string | null>(null);
  const selectedConditionMode = CONDITION_SELECTION_OPTIONS.some((option) => option.id === selectedMode)
    ? selectedMode
    : getStudyModeFromConditionSelection(
        getInterfaceCondition(selectedMode),
        getInteractionMode(selectedMode)
      );
  const pidMissing = !demoMode && !loggingParticipantId.trim();
  // In demo mode the visitor supplies one of two credentials: a single-use
  // access code from the presenter, or their own OpenAI key. Everything that
  // used to gate on "no API key" now gates on "no credential of either kind".
  const usingAccessCode = demoCredentialMode === 'code';
  const apiKeyMissing = usingAccessCode ? !accessCode.trim() : !apiKey.trim();
  // /speech/synthesize-preview runs before any session exists, so it is
  // unauthenticated and can only use a key the caller supplies. An access-code
  // visitor has no key at this point — their credential is redeemed server-side
  // when the session starts — so the speaker preview is genuinely unavailable
  // to them. Enabling the operator-key fallback for it instead would reopen the
  // unauthenticated drain path that flag exists to keep closed.
  const speakerPreviewUnavailable = demoMode && usingAccessCode;
  const tutorialSelected = selectedScenarioId === TUTORIAL_SCENARIO_ID;
  const perTrialSurveyEnabled = isHardTaskScenario({ scenarioId: selectedScenarioId });
  const conditionCode = CONDITION_SELECTION_OPTIONS.find((o) => o.id === selectedConditionMode)?.code ?? selectedConditionMode;
  const perTrialSetLabel = deriveSetLabel(selectedScenarioId);
  const orderedScenarios = useMemo(() => {
    return [...scenarios]
      .filter((s) => SHOW_TUTORIAL_SCENARIO || s.id !== TUTORIAL_SCENARIO_ID)
      .sort((left, right) => {
        const leftKey = getScenarioGridSortKey(left);
        const rightKey = getScenarioGridSortKey(right);

        for (let index = 0; index < leftKey.length; index += 1) {
          if (leftKey[index] < rightKey[index]) return -1;
          if (leftKey[index] > rightKey[index]) return 1;
        }
        return 0;
      });
  }, [scenarios]);

  useEffect(() => {
    let mounted = true;
    setLoadingScenarios(true);
    setError(null);
    api.getStudyScenarios()
      .then((result) => {
        if (!mounted) return;
        setScenarios(result.scenarios);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'Failed to load scenarios');
      })
      .finally(() => {
        if (!mounted) return;
        setLoadingScenarios(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (scenarios.length === 0) return;

    const hasSelected = selectedScenarioId
      ? scenarios.some((scenario) => scenario.id === selectedScenarioId)
      : false;

    if (!hasSelected) {
      onScenarioChange(scenarios[0].id);
    }
  }, [onScenarioChange, scenarios, selectedScenarioId]);

  useEffect(() => {
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      if (previewAudioUrlRef.current) {
        URL.revokeObjectURL(previewAudioUrlRef.current);
        previewAudioUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      const rawValue = window.localStorage.getItem(VOICE_CHECK_STATUS_STORAGE_KEY);
      if (!rawValue) return;
      const parsed = JSON.parse(rawValue) as {
        micCheckStatus?: 'idle' | 'granted' | 'denied';
        speakerCheckStatus?: 'idle' | 'played' | 'confirmed' | 'error';
      };
      if (parsed.micCheckStatus) {
        setMicCheckStatus(parsed.micCheckStatus);
      }
      if (parsed.speakerCheckStatus) {
        setSpeakerCheckStatus(parsed.speakerCheckStatus);
      }
    } catch {
      // Ignore malformed persisted status.
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.localStorage.setItem(
      VOICE_CHECK_STATUS_STORAGE_KEY,
      JSON.stringify({
        micCheckStatus:
          micCheckStatus === 'checking' ? 'idle' : micCheckStatus,
        speakerCheckStatus:
          speakerCheckStatus === 'playing' ? 'idle' : speakerCheckStatus,
      })
    );
  }, [micCheckStatus, speakerCheckStatus]);

  const navigateToTaskReview = () => {
    // A demo visitor picks nothing: there is one world, and the printed card in
    // their hand is the scenario. Selecting it here lets the review page start
    // the session immediately instead of showing a briefing nobody reads.
    if (demoMode) {
      onScenarioChange(DEMO_SCENARIO_ID);
      navigate('/task-review');
      return;
    }
    if (!selectedScenarioId) return;
    navigate('/task-review');
  };

  const resetVoiceSample = () => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
    if (previewAudioUrlRef.current) {
      URL.revokeObjectURL(previewAudioUrlRef.current);
      previewAudioUrlRef.current = null;
    }
  };

  const handleStartTask = () => {
    if (!selectedScenarioId) return;
    if (demoMode && apiKeyMissing) {
      setError(
        usingAccessCode
          ? 'Enter the access code from the presenter to start the demo.'
          : 'Enter your OpenAI API key to start the demo.'
      );
      return;
    }
    onDismissSessionNotice?.();
    navigateToTaskReview();
  };

  const handleDemoModeToggle = (nextDemoMode: boolean) => {
    setError(null);
    onDismissSessionNotice?.();
    onDemoModeChange(nextDemoMode);
  };

  // Never carries the API key: setup events are study log payloads.
  const queueSetupGuiAction = (action: string, extraPayload?: Record<string, unknown>) => {
    // Demo mode logs nothing at all.
    if (demoMode) return;
    queuePendingStudyLogEvent({
      type: 'user.gui_action',
      clientTimestamp: new Date().toISOString(),
      payload: {
        action,
        source: 'participant',
        location: 'study-setup',
        ...(selectedScenarioId ? { selectedScenarioId } : {}),
        studyMode: selectedMode,
        ...(extraPayload ?? {}),
      },
    });
  };

  const handleConditionChange = (mode: StudyModeId) => {
    onModeChange(mode);
  };

  const handleOpenPerTrialSurvey = (mode: StudyModeId) => {
    if (selectedScenarioId === TUTORIAL_SCENARIO_ID) {
      setError('Per-trial surveys are disabled for the tutorial scenario.');
      return;
    }
    if (!perTrialSurveyEnabled) {
      setError('Per-trial surveys are only available for Hard tasks.');
      return;
    }
    if (!loggingParticipantId.trim()) {
      setError('Enter Participant PID before opening the survey.');
      return;
    }

    const searchParams = new URLSearchParams({
      studyMode: mode,
    });
    if (selectedScenarioId) {
      searchParams.set('scenarioId', selectedScenarioId);
    }
    navigate(`/survey/per-trial?${searchParams.toString()}`);
  };

  const handleOpenPostStudySurvey = () => {
    if (!loggingParticipantId.trim()) {
      setError('Enter Participant PID before opening the post-study survey.');
      return;
    }
    navigate('/survey/post-study');
  };

  const handleRunMicrophoneCheck = async () => {
    if (voiceCheckLoading !== 'none') return;
    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      setMicCheckStatus('denied');
      setVoiceCheckError('Microphone access is not supported in this browser.');
      return;
    }

    setVoiceCheckLoading('mic');
    setVoiceCheckError(null);
    setMicCheckStatus('checking');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stream.getTracks().forEach((track) => track.stop());
      setMicCheckStatus('granted');
    } catch (requestError) {
      setMicCheckStatus('denied');
      setVoiceCheckError(
        requestError instanceof Error && requestError.message
          ? requestError.message
          : 'Microphone permission was denied.'
      );
    } finally {
      setVoiceCheckLoading('none');
    }
  };

  // The speaker sample runs through /speech/synthesize-preview so it doubles as an
  // end-to-end check that the entered OpenAI key actually works.
  const handlePlaySpeakerSample = async () => {
    if (voiceCheckLoading !== 'none') return;
    // In the lab flow the key lives on the server, so let the request go out and
    // let the backend answer; only a demo visitor must supply a key here.
    if (speakerPreviewUnavailable) {
      setSpeakerCheckStatus('error');
      setVoiceCheckError(
        'The speaker test needs your own OpenAI key. With an access code, voice starts working once the demo begins.'
      );
      return;
    }
    if (demoMode && apiKeyMissing) {
      setSpeakerCheckStatus('error');
      setVoiceCheckError(describeApiErrorCode(OPENAI_API_KEY_MISSING));
      return;
    }

    setVoiceCheckLoading('speaker');
    setVoiceCheckError(null);
    setSpeakerCheckStatus('playing');
    resetVoiceSample();

    try {
      const sample = await api.synthesizeSpeechPreview('This is a speaker test.');
      const objectUrl = URL.createObjectURL(sample);
      previewAudioUrlRef.current = objectUrl;

      const audio = new Audio(objectUrl);
      previewAudioRef.current = audio;

      audio.onended = () => {
        if (previewAudioRef.current !== audio) return;
        resetVoiceSample();
        setSpeakerCheckStatus('confirmed');
      };
      audio.onerror = () => {
        if (previewAudioRef.current !== audio) return;
        resetVoiceSample();
        setSpeakerCheckStatus('error');
        setVoiceCheckError('Speaker playback failed. Check your system audio output.');
      };

      await audio.play();
    } catch (playbackError) {
      resetVoiceSample();
      setSpeakerCheckStatus('error');
      setVoiceCheckError(
        describeApiErrorCode(getApiErrorCode(playbackError)) ??
          (playbackError instanceof Error && playbackError.message
            ? playbackError.message
            : 'Failed to play the voice sample.')
      );
    } finally {
      setVoiceCheckLoading('none');
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-dark px-4 py-4 sm:py-5">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-start sm:justify-center">
        <div className="w-full rounded-2xl border border-dark-border bg-dark-light p-5 sm:p-6">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-fg-strong">
                {demoMode ? 'Demo Setup' : 'User Study Setup'}
              </h1>
              <p className="mt-1 text-sm text-fg-muted">
                {demoMode
                  ? 'Enter the access code from the presenter, or paste your own OpenAI API key. Nothing is recorded.'
                  : 'Select your assigned condition and one scenario before starting.'}
              </p>
            </div>
            <div className="flex flex-wrap items-start justify-end gap-2">
              <button
                type="button"
                onClick={() => handleDemoModeToggle(!demoMode)}
                aria-pressed={demoMode}
                className={`inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors ${
                  demoMode
                    ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20'
                    : 'border-dark-border bg-dark text-fg hover:border-primary hover:text-fg-strong'
                }`}
              >
                {demoMode ? 'Demo Mode: On' : 'Demo Mode'}
              </button>
              {demoMode ? null : (
                <label
                  className={`flex h-11 items-center gap-2 rounded-lg border px-3 transition-colors ${
                    pidMissing
                      ? 'border-rose-400/70 bg-rose-500/10'
                      : 'border-dark-border bg-dark'
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                      pidMissing
                        ? 'bg-rose-500/15 text-rose-300'
                        : 'bg-primary/15 text-primary'
                    }`}
                  >
                    1
                  </span>
                  <span className="text-sm font-medium text-fg-strong">PID</span>
                  <input
                    type="text"
                    value={loggingParticipantId}
                    onChange={(event) => onLoggingParticipantIdChange(event.target.value)}
                    placeholder="P12"
                    className={`h-8 w-20 rounded-md border px-2.5 text-sm text-fg-strong outline-none transition-colors placeholder:text-fg-faint ${
                      pidMissing
                        ? 'border-rose-400/70 bg-dark focus:border-rose-300'
                        : 'border-dark-border bg-dark-light focus:border-primary'
                    }`}
                  />
                </label>
              )}
              <div
                className={`flex h-11 items-center gap-2 rounded-lg border pl-3 pr-1 transition-colors ${
                  demoMode && apiKeyMissing
                    ? 'border-rose-400/70 bg-rose-500/10'
                    : 'border-dark-border bg-dark'
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    demoMode && apiKeyMissing
                      ? 'bg-rose-500/15 text-rose-300'
                      : 'bg-primary/15 text-primary'
                  }`}
                >
                  {demoMode ? '1' : '2'}
                </span>
                {demoMode && usingAccessCode ? (
                  <>
                    <label className="text-sm font-medium text-fg-strong" htmlFor="demo-access-code">
                      Code
                    </label>
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="characters"
                      maxLength={12}
                      value={accessCode}
                      // Uppercase as the visitor types so what they see matches
                      // the printed card. The backend normalizes again anyway.
                      onChange={(event) => onAccessCodeChange(event.target.value.toUpperCase())}
                      id="demo-access-code"
                      placeholder="ABC123"
                      className={`h-8 w-32 rounded-md border px-2.5 font-mono text-sm tracking-[0.2em] text-fg-strong outline-none transition-colors placeholder:tracking-normal placeholder:text-fg-faint ${
                        apiKeyMissing
                          ? 'border-rose-400/70 bg-dark focus:border-rose-300'
                          : 'border-dark-border bg-dark-light focus:border-primary'
                      }`}
                    />
                  </>
                ) : (
                  <>
                    <label className="text-sm font-medium text-fg-strong" htmlFor="demo-api-key">
                      API Key
                    </label>
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={apiKey}
                      onChange={(event) => onApiKeyChange(event.target.value)}
                      id="demo-api-key"
                      placeholder="sk-..."
                      className={`h-8 w-40 rounded-md border px-2.5 text-sm text-fg-strong outline-none transition-colors placeholder:text-fg-faint ${
                        demoMode && apiKeyMissing
                          ? 'border-rose-400/70 bg-dark focus:border-rose-300'
                          : 'border-dark-border bg-dark-light focus:border-primary'
                      }`}
                    />
                  </>
                )}
                {demoMode && (
                  <div
                    className="ml-1 flex h-9 items-center rounded-md bg-dark-light p-0.5"
                    role="radiogroup"
                    aria-label="How to authorize this demo"
                  >
                    {(
                      [
                        ['code', 'Code'],
                        ['key', 'Key'],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={demoCredentialMode === mode}
                        onClick={() => onDemoCredentialModeChange(mode)}
                        title={
                          mode === 'code'
                            ? 'Use a single-use access code from the presenter'
                            : 'Use your own OpenAI API key'
                        }
                        className={`h-full rounded px-2.5 text-xs font-semibold transition-colors ${
                          demoCredentialMode === mode
                            ? 'bg-dark text-fg-strong shadow-sm'
                            : 'text-fg-muted hover:text-fg-strong'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  queueSetupGuiAction('openVoiceCheck');
                  setVoiceCheckError(null);
                  setVoiceCheckOpen(true);
                }}
                // Deliberately not gated on having a credential. The dialog's
                // microphone step is pure getUserMedia and is the more useful
                // half — a visitor should be able to grant mic permission before
                // the task starts no matter how they are authorizing. Only the
                // speaker sample needs a key, and it disables itself.
                title="Check microphone permission and speaker output"
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-sky-500/35 bg-sky-500/10 px-4 text-sm font-semibold text-sky-700 transition-colors hover:border-sky-500/60 hover:bg-sky-500/15 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-sky-500/35 disabled:hover:bg-sky-500/10"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-xs font-semibold text-sky-700">
                  {demoMode ? '2' : '3'}
                </span>
                Mic Check
              </button>
              <button
                type="button"
                onClick={() => {
                  queueSetupGuiAction('openTutorialVideo');
                  setTutorialVideoOpen(true);
                }}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-sky-500/35 bg-sky-500/10 px-4 text-sm font-semibold text-sky-700 transition-colors hover:border-sky-500/60 hover:bg-sky-500/15"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-xs font-semibold text-sky-700">
                  {demoMode ? '3' : '4'}
                </span>
                Watch Tutorial Video
              </button>
              <button
                type="button"
                hidden
                aria-hidden="true"
                tabIndex={-1}
                onClick={onThemeToggle}
                className={`px-3 py-1 text-xs rounded border transition-colors ${
                  theme === 'dark'
                    ? 'border-amber-300/60 bg-amber-100/10 text-amber-200 hover:border-amber-200 hover:text-amber-100'
                    : 'border-sky-500/45 bg-sky-500/10 text-sky-700 hover:border-sky-500 hover:text-sky-800'
                }`}
              >
                {theme === 'dark' ? 'Bright Mode' : 'Dark Mode'}
              </button>
            </div>
          </div>

          {sessionNotice ? (
            <div className="mb-5 flex items-start justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800">
              <span>{sessionNotice}</span>
              {onDismissSessionNotice ? (
                <button
                  type="button"
                  onClick={onDismissSessionNotice}
                  className="shrink-0 text-xs font-semibold uppercase tracking-wide text-amber-800/80 transition-colors hover:text-amber-900"
                >
                  Dismiss
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-4">
            {demoMode ? (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
                  Demo
                </h2>
                <div className="rounded-xl border border-dark-border bg-dark px-4 py-3 text-sm text-fg-muted">
                  Your key stays in this browser tab and is used only for this session. No
                  participant ID, no surveys, and nothing about this session is logged. Voice mode
                  is available from the mic button once the booking task starts.
                </div>
              </section>
            ) : (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
                Condition
              </h2>
              <div className="grid gap-2.5">
                <div className="flex items-stretch gap-2.5">
                  <div className="flex flex-1 flex-col gap-2.5">
                    {CONDITION_SELECTION_OPTIONS.map((option) => {
                      const checked = selectedConditionMode === option.id;
                      return (
                        <label
                          key={option.id}
                          className={`flex flex-1 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
                            checked
                              ? 'border-primary/70 bg-primary/10'
                              : 'border-dark-border bg-dark hover:border-dark-lighter'
                          }`}
                        >
                          <input
                            type="radio"
                            name="study-condition"
                            className="h-4 w-4 accent-primary"
                            checked={checked}
                            onChange={() => handleConditionChange(option.id)}
                          />
                          <div className="text-sm font-semibold text-fg-strong">
                            {option.code ? `${option.code}: ` : ''}
                            {option.summary}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleOpenPerTrialSurvey(selectedConditionMode)}
                    disabled={tutorialSelected || !perTrialSurveyEnabled}
                    className={`w-36 rounded-xl px-4 py-3 text-sm font-semibold transition-colors ${
                      tutorialSelected || !perTrialSurveyEnabled
                        ? 'cursor-not-allowed border border-stone-300 bg-stone-100 text-slate-400'
                        : 'border border-sky-500/35 bg-sky-500/10 text-sky-700 hover:border-sky-500/60 hover:bg-sky-500/15'
                    }`}
                  >
                    {tutorialSelected ? (
                      'Survey Disabled'
                    ) : !perTrialSurveyEnabled ? (
                      'Hard Task Only'
                    ) : (
                      <>
                        <span className="block">Open Survey</span>
                        <span className="mt-1 inline-block rounded-md border border-amber-400 bg-amber-400 px-2 py-0.5 text-lg font-black tracking-wide text-slate-900">
                          {conditionCode}{perTrialSetLabel ? ` / ${perTrialSetLabel}` : ''}
                        </span>
                      </>
                    )}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleOpenPostStudySurvey}
                  className="w-full rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-700 transition-colors hover:border-emerald-500/60 hover:bg-emerald-500/15"
                >
                  Post-Study Survey
                </button>
              </div>
            </section>
            )}

            {!demoMode && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
                Scenario
              </h2>
              {loadingScenarios ? (
                <div className="rounded-xl border border-dark-border bg-dark p-4 text-sm text-fg-muted">
                  Loading scenarios...
                </div>
              ) : scenarios.length === 0 ? (
                <div className="rounded-xl border border-dark-border bg-dark p-4 text-sm text-fg-muted">
                  No scenarios available.
                </div>
              ) : (
                <div className="grid gap-2.5 md:grid-cols-2">
                  {orderedScenarios.map((scenario) => {
                    const checked = selectedScenarioId === scenario.id;
                    const isExampleScenario = scenario.id === TUTORIAL_SCENARIO_ID;
                    return (
                      <label
                        key={scenario.id}
                        className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                          checked
                            ? 'border-primary/70 bg-primary/10'
                            : 'border-dark-border bg-dark hover:border-dark-lighter'
                        } ${isExampleScenario ? 'md:col-span-2' : ''}`}
                      >
                        <input
                          type="radio"
                          name="study-scenario"
                          className="mt-1 h-4 w-4 accent-primary"
                          checked={checked}
                          onChange={() => onScenarioChange(scenario.id)}
                        />
                        <div className="text-sm font-medium text-fg-strong">
                          {formatScenarioTitle(scenario.title)}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </section>
            )}
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary">
              {error}
            </div>
          )}

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={handleStartTask}
              disabled={
                demoMode
                  // The demo has no participant ID and nothing to choose: the
                  // access code (or the visitor's own key) is the whole setup.
                  ? apiKeyMissing
                  : loadingScenarios || !selectedScenarioId || pidMissing
              }
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {demoMode ? 'Start Demo' : 'Start Task'}
            </button>
          </div>
        </div>
      </div>

      {voiceCheckOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark/75 px-4">
          <div className="w-full max-w-xl rounded-2xl border border-dark-border bg-dark-light p-6 shadow-2xl">
            <div className="mb-5">
              <h2 className="text-xl font-semibold text-fg-strong">Mic Check</h2>
              <p className="mt-2 text-sm text-fg-muted">
                Use this first to verify microphone permission and speaker playback before a voice-mode round.
              </p>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-dark-border bg-dark p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-fg-strong">1. Microphone permission</div>
                    <div className="mt-1 text-xs text-fg-muted">
                      Allow microphone access so voice mode is ready before the task starts.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRunMicrophoneCheck()}
                    disabled={voiceCheckLoading !== 'none'}
                    className="rounded-lg border border-dark-border px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-primary hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {micCheckStatus === 'granted'
                      ? 'Granted'
                      : voiceCheckLoading === 'mic'
                      ? 'Checking...'
                      : 'Allow Microphone'}
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-dark-border bg-dark p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-fg-strong">2. Speaker playback</div>
                    <div className="mt-1 text-xs text-fg-muted">
                      {speakerPreviewUnavailable
                        ? 'Needs your own OpenAI key. With an access code the agent starts speaking once the demo begins — the microphone check above is the part that matters here.'
                        : 'Play a short sample to confirm speaker output and that your OpenAI API key works.'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handlePlaySpeakerSample()}
                    disabled={
                      voiceCheckLoading !== 'none' ||
                      (demoMode && apiKeyMissing) ||
                      speakerPreviewUnavailable
                    }
                    className="rounded-lg border border-dark-border px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-primary hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {voiceCheckLoading === 'speaker'
                      ? 'Playing...'
                      : speakerCheckStatus === 'confirmed'
                      ? 'Played'
                      : 'Play Sample'}
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-dark-border bg-dark p-4 text-sm text-fg-muted">
                <div>Microphone: {micCheckStatus === 'granted' ? 'ready' : micCheckStatus === 'denied' ? 'not granted' : 'not checked'}</div>
                <div className="mt-1">Speaker: {speakerCheckStatus === 'confirmed' ? 'confirmed' : speakerCheckStatus === 'played' ? 'sample played' : speakerCheckStatus === 'error' ? 'playback failed' : 'not checked'}</div>
              </div>

              {voiceCheckError ? (
                <div className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary">
                  {voiceCheckError}
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  resetVoiceSample();
                  setVoiceCheckOpen(false);
                }}
                className="rounded-lg border border-dark-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-primary hover:text-fg-strong"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {tutorialVideoOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark/75 px-3 py-3 sm:px-5 sm:py-5">
          <div className="max-h-[90vh] w-full max-w-[min(92vw,84rem)] overflow-y-auto rounded-2xl border border-dark-border bg-dark-light p-5 shadow-2xl sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-fg-strong">Tutorial Video</h2>
                <p className="mt-2 text-sm text-fg-muted">
                  Watch this walkthrough before starting the tutorial scenario or your assigned study task.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTutorialVideoOpen(false)}
                className="rounded-lg border border-dark-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-primary hover:text-fg-strong"
              >
                Close
              </button>
            </div>

            <div className="overflow-hidden rounded-xl border border-dark-border bg-dark">
              <div className="aspect-video w-full">
                <iframe
                  className="h-full w-full"
                  src={TUTORIAL_VIDEO_EMBED_URL}
                  title="User Study Tutorial Video"
                  loading="lazy"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                />
              </div>
            </div>

            <div className="mt-3 text-sm text-fg-muted">
              If the video does not load here, open it on{' '}
              <a
                href={TUTORIAL_VIDEO_WATCH_URL}
                target="_blank"
                rel="noreferrer"
                className="text-sky-700 underline underline-offset-2 transition-colors hover:text-sky-800"
              >
                YouTube
              </a>
              .
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
