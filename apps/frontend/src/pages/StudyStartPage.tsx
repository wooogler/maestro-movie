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
  DEMO_STUDY_MODE,
  getInterfaceCondition,
  getInteractionMode,
  getStudyModeConfig,
  getStudyModeFromConditionSelection,
  type StudyModeId,
} from './studyOptions';
import { useLanguage } from '../i18n';
import { usePlannerModelSetting, useVoiceVerbositySettings } from '../hooks';
import { defaultVerbosityFor } from '../voice';
import { SettingsModal } from '../components/settings/SettingsModal';
import { PreferencePresetPicker } from '../components/memory';
import type { StudyScenarioDetail } from '../study/sessionStorage';
import { formatScenarioTitle, isHardTaskScenario } from '../utils/displayFormats';
import {
  clearPendingStudyLogEvents,
  queuePendingStudyLogEvent,
} from '../study/pendingInteractionEvents';

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
  /** Preset whose preference memory the session opens with, or null. */
  preferencePresetId: string | null;
  onPreferencePresetChange: (presetId: string | null) => void;
  /**
   * Whether the demo visitor agreed to have this session recorded for research.
   * Asked here, before anything is running, because this is the last screen
   * that exists before the session — and therefore the last moment at which
   * "record nothing" is still a choice rather than a deletion.
   */
  researchConsent: boolean;
  onResearchConsentChange: (consented: boolean) => void;
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
  preferencePresetId,
  onPreferencePresetChange,
  researchConsent,
  onResearchConsentChange,
  sessionNotice = null,
  onDismissSessionNotice,
}: StudyStartPageProps) {
  const navigate = useNavigate();
  const { s: ui } = useLanguage();
  const [loadingScenarios, setLoadingScenarios] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<StudyScenarioDetail[]>([]);
  const [voiceCheckOpen, setVoiceCheckOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tutorialVideoOpen, setTutorialVideoOpen] = useState(false);
  /*
    The credential dialog. The code and key used to be typed straight into the
    header row, which left the booth's access code sitting in plain text on the
    screen every visitor walks up to. Now the row only says whether a
    credential is ready, and the value itself is typed in a dialog and never
    shown again: changing it means typing a new one, not editing the old.

    The draft is local until "Use" so that switching the Code/Key segment and
    then cancelling leaves the stored mode and value untouched.
  */
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState('');
  const [credentialDraftMode, setCredentialDraftMode] = useState<'code' | 'key'>('code');
  const credentialInputRef = useRef<HTMLInputElement | null>(null);
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
  // In demo mode the visitor supplies one of two credentials: an access code
  // from the presenter, or their own OpenAI key. Everything that used to gate on
  // "no API key" now gates on "no credential of either kind".
  const usingAccessCode = demoCredentialMode === 'code';
  const apiKeyMissing = usingAccessCode ? !accessCode.trim() : !apiKey.trim();
  // /speech/synthesize-preview runs before any session exists, so it is
  // unauthenticated and the credential travels with the request: the visitor's
  // own key, or the booth access code, which the backend verifies (read-only,
  // not a redemption) before speaking its fixed sample on the operator key.
  const speakerPreviewCredential = demoMode && usingAccessCode ? { accessCode } : { apiKey };
  // Outside demo mode the key is optional: the lab backend has its own.
  const credentialPresent = demoMode ? !apiKeyMissing : Boolean(apiKey.trim());
  const credentialStatusLabel = demoMode
    ? apiKeyMissing
      ? ui.credentialMissing
      : usingAccessCode
      ? ui.credentialReadyCode
      : ui.credentialReadyKey
    : apiKey.trim()
    ? 'API key ready'
    : 'API Key (optional)';
  const credentialDraftPresent =
    credentialDraftMode === 'code' ? Boolean(accessCode.trim()) : Boolean(apiKey.trim());

  const openCredentialDialog = () => {
    queueSetupGuiAction('openCredentialDialog');
    // Always an empty field, on purpose: prefilling would put the saved code
    // back on screen, which is the thing the dialog exists to avoid.
    setCredentialDraft('');
    setCredentialDraftMode(demoMode ? demoCredentialMode : 'key');
    setCredentialOpen(true);
  };
  const closeCredentialDialog = () => {
    setCredentialOpen(false);
    setCredentialDraft('');
  };
  const saveCredential = () => {
    const value = credentialDraft.trim();
    if (!value) return;
    if (credentialDraftMode === 'code') {
      // Uppercase so the stored value matches the printed card. The backend
      // normalizes again anyway.
      onAccessCodeChange(value.toUpperCase());
    } else {
      onApiKeyChange(value);
    }
    if (demoMode) onDemoCredentialModeChange(credentialDraftMode);
    closeCredentialDialog();
  };
  const removeCredential = () => {
    if (credentialDraftMode === 'code') {
      onAccessCodeChange('');
    } else {
      onApiKeyChange('');
    }
    if (demoMode) onDemoCredentialModeChange(credentialDraftMode);
    closeCredentialDialog();
  };

  // Escape closes the dialog and focus starts in its field, so a visitor can
  // type the code the moment it opens.
  useEffect(() => {
    if (!credentialOpen) return;
    credentialInputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCredentialOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [credentialOpen]);
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
    // A demo visitor's setup is only recorded once they have said it may be.
    // The queue is flushed into whatever session starts next, so queueing
    // before consent would put this visitor's actions into someone else's log.
    if (demoMode && !researchConsent) return;
    queuePendingStudyLogEvent({
      type: 'user.gui_action',
      clientTimestamp: new Date().toISOString(),
      payload: {
        action,
        source: 'participant',
        location: 'study-setup',
        ...(selectedScenarioId ? { selectedScenarioId } : {}),
        studyMode: demoMode ? DEMO_STUDY_MODE : selectedMode,
        ...(extraPayload ?? {}),
      },
    });
  };

  const handleResearchConsentChange = (consented: boolean) => {
    onResearchConsentChange(consented);
    if (consented) {
      queuePendingStudyLogEvent({
        type: 'study.consent.granted',
        clientTimestamp: new Date().toISOString(),
        payload: { location: 'study-setup', studyMode: DEMO_STUDY_MODE },
      });
      return;
    }
    // Un-ticking is a withdrawal, and it has to reach back as far as the queue
    // does: anything already queued for this visitor goes with it.
    clearPendingStudyLogEvents();
  };

  /*
    The same settings sheet the booking UI shows, one screen earlier. Language
    and how much the agent says out loud are both things a visitor would rather
    set before the agent starts talking than during — and the language in
    particular is fixed when the voice session is minted, so changing it mid-run
    tears the session down and opens a new one.
  */
  const voiceVerbosity = useVoiceVerbositySettings({
    fallback: defaultVerbosityFor(demoMode),
    onChange: (_next, detail) => queueSetupGuiAction('changeVoiceVerbosity', detail),
  });
  const voiceSettingsAvailable = demoMode
    ? true
    : getStudyModeConfig(selectedConditionMode).voiceModeAvailable;
  // Demo only: in a study condition the model is the researcher's to set.
  const plannerModelSetting = usePlannerModelSetting({
    onChange: (_model, detail) => queueSetupGuiAction('changePlannerModel', detail),
  });

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
    // let the backend answer; only a demo visitor must supply a credential here.
    if (demoMode && apiKeyMissing) {
      setSpeakerCheckStatus('error');
      setVoiceCheckError(
        usingAccessCode
          ? 'Enter the access code from the presenter to test the speaker.'
          : describeApiErrorCode(OPENAI_API_KEY_MISSING)
      );
      return;
    }

    setVoiceCheckLoading('speaker');
    setVoiceCheckError(null);
    setSpeakerCheckStatus('playing');
    resetVoiceSample();

    try {
      const sample = await api.synthesizeSpeechPreview(
        'This is a speaker test.',
        speakerPreviewCredential
      );
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
    <main className="h-full overflow-y-auto bg-dark px-3 py-4 sm:px-4 sm:py-5">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center">
        <div className="w-full rounded-2xl border border-dark-border bg-dark-light p-5 sm:p-6">
          <div className="mb-5 flex flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-3">
            <div>
              <h1 className="text-3xl font-semibold text-fg-strong sm:text-2xl">
                {demoMode ? ui.demoSetupTitle : 'User Study Setup'}
              </h1>
              <p className="mt-2 text-base leading-relaxed text-fg-muted sm:mt-1 sm:text-sm">
                {demoMode
                  ? ui.demoSetupSubtitle
                  : 'Select your assigned condition and one scenario before starting.'}
              </p>
              {demoMode ? (
                <button
                  type="button"
                  onClick={() => navigate('/about')}
                  className="mt-2 text-sm font-medium text-primary-text underline underline-offset-2 transition-colors hover:text-primary-hover"
                >
                  {ui.aboutDemoLink}
                </button>
              ) : null}
            </div>
            {/*
              A phone gets one control per row at a comfortable height. On a
              430px screen the desktop arrangement wrapped into a ragged block
              of half-width chips with a code field too small to aim at.
            */}
            <div className="flex flex-col items-stretch gap-2.5 sm:flex-row sm:flex-wrap sm:items-start sm:justify-end sm:gap-2">
              <button
                type="button"
                onClick={() => handleDemoModeToggle(!demoMode)}
                aria-pressed={demoMode}
                className={`inline-flex h-14 items-center justify-center gap-2 rounded-xl border px-4 text-base font-semibold transition-colors sm:h-11 sm:justify-start sm:rounded-lg sm:text-sm ${
                  demoMode
                    ? 'border-primary/60 bg-primary/15 text-primary-text hover:bg-primary/20'
                    : 'border-dark-border bg-dark text-fg hover:border-primary hover:text-fg-strong'
                }`}
              >
                {demoMode ? ui.demoModeOn : 'Demo Mode'}
              </button>
              {/*
                Unnumbered on purpose: the numbers walk a visitor through the
                steps they have to take, and this is one they may skip. English
                and the balanced voice preset are already right for most of
                them.
              */}
              <button
                type="button"
                onClick={() => {
                  queueSetupGuiAction('openSettings');
                  setSettingsOpen(true);
                }}
                title="Language and how much the agent says out loud"
                className="inline-flex h-14 items-center justify-center gap-2 rounded-xl border border-dark-border bg-dark px-4 text-base font-semibold text-fg transition-colors hover:border-primary hover:text-fg-strong sm:h-11 sm:rounded-lg sm:text-sm"
              >
                {ui.settings}
              </button>
              {demoMode ? null : (
                <label
                  className={`flex h-11 items-center gap-2 rounded-lg border px-3 transition-colors ${
                    pidMissing
                      ? 'border-danger bg-danger/10'
                      : 'border-dark-border bg-dark'
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                      pidMissing
                        ? 'bg-danger/10 text-danger-text'
                        : 'bg-primary/15 text-primary-text'
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
                        ? 'border-danger bg-dark focus:border-danger'
                        : 'border-dark-border bg-dark-light focus:border-primary'
                    }`}
                  />
                </label>
              )}
              {/*
                Only the state of the credential, never its value. The code
                used to be typed here in the open; see the dialog below.
              */}
              <button
                type="button"
                onClick={openCredentialDialog}
                aria-haspopup="dialog"
                aria-expanded={credentialOpen}
                className={`inline-flex h-14 items-center justify-center gap-2 rounded-xl border px-4 text-base font-semibold transition-colors sm:h-11 sm:justify-start sm:rounded-lg sm:text-sm ${
                  demoMode && apiKeyMissing
                    ? 'border-danger bg-danger/10 text-danger-text hover:bg-danger/15'
                    : 'border-dark-border bg-dark text-fg hover:border-primary hover:text-fg-strong'
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    demoMode && apiKeyMissing
                      ? 'bg-danger/10 text-danger-text'
                      : 'bg-primary/15 text-primary-text'
                  }`}
                >
                  {demoMode ? '1' : '2'}
                </span>
                {credentialPresent ? (
                  <span aria-hidden="true" className="text-primary-text">
                    ✓
                  </span>
                ) : null}
                <span>{credentialStatusLabel}</span>
                {credentialPresent ? (
                  <span className="text-xs font-medium text-fg-muted">{ui.credentialChange}</span>
                ) : null}
              </button>
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
                className="inline-flex h-14 items-center gap-2 rounded-xl border border-primary/35 bg-primary/10 px-4 text-base font-semibold text-primary-text transition-colors hover:border-primary/60 hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-primary/35 disabled:hover:bg-primary/10 sm:h-11 sm:rounded-lg sm:text-sm"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary-text">
                  {demoMode ? '2' : '3'}
                </span>
                {demoMode ? ui.micCheck : 'Mic Check'}
              </button>
              <button
                type="button"
                onClick={() => {
                  queueSetupGuiAction('openTutorialVideo');
                  setTutorialVideoOpen(true);
                }}
                className="inline-flex h-14 items-center gap-2 rounded-xl border border-primary/35 bg-primary/10 px-4 text-base font-semibold text-primary-text transition-colors hover:border-primary/60 hover:bg-primary/15 sm:h-11 sm:rounded-lg sm:text-sm"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary-text">
                  {demoMode ? '3' : '4'}
                </span>
                {demoMode ? ui.watchTutorial : 'Watch Tutorial Video'}
              </button>
              <button
                type="button"
                hidden
                aria-hidden="true"
                tabIndex={-1}
                onClick={onThemeToggle}
                className={`px-3 py-1 text-xs rounded border transition-colors ${
                  theme === 'dark'
                    ? 'border-accent-line/60 bg-accent/10 text-accent-text hover:border-accent-hover hover:text-accent-text'
                    : 'border-primary/45 bg-primary/10 text-primary-text hover:border-primary hover:text-primary-hover'
                }`}
              >
                {theme === 'dark' ? 'Bright Mode' : 'Dark Mode'}
              </button>
            </div>
          </div>

          {sessionNotice ? (
            <div className="mb-5 flex items-start justify-between gap-3 rounded-lg border border-accent-line/40 bg-accent/10 px-3 py-2 text-sm text-accent-text">
              <span>{sessionNotice}</span>
              {onDismissSessionNotice ? (
                <button
                  type="button"
                  onClick={onDismissSessionNotice}
                  className="shrink-0 text-xs font-semibold uppercase tracking-wide text-accent-text transition-colors hover:text-accent-text"
                >
                  Dismiss
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-4">
            {demoMode ? (
              <>
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
                  Demo
                </h2>
                <div className="rounded-xl border border-dark-border bg-dark px-4 py-3 text-sm text-fg-muted">
                  {ui.demoPrivacyNote}
                </div>
              </section>

              {/*
                The consent box. It is asked here rather than on the way out
                because this is the last screen that exists before the session:
                afterwards, "record nothing" would mean deleting a file rather
                than never writing one.
              */}
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
                  {ui.consentTitle}
                </h2>
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                    researchConsent
                      ? 'border-primary/70 bg-primary/10'
                      : 'border-dark-border bg-dark hover:border-dark-lighter'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0 accent-primary"
                    checked={researchConsent}
                    onChange={(event) => handleResearchConsentChange(event.target.checked)}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-fg-strong">
                      {ui.consentCheckboxLabel}
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
                      {ui.consentBody}
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-fg-faint">
                      {ui.consentOptOutNote}
                    </p>
                  </div>
                </label>
              </section>

              {/*
                Preference memory the session starts with.

                Here because this is the only screen that exists before a
                session: /task-review fires the session POST on mount, so a
                picker there would race it. Nothing is stored between visitors —
                the point is to simulate an agent that already knows something,
                not to remember anyone.
              */}
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
                  {ui.preferenceMemoryTitle}
                </h2>
                <p className="text-sm leading-relaxed text-fg-muted">
                  {ui.preferenceMemoryBody}
                </p>
                <PreferencePresetPicker
                  selectedPresetId={preferencePresetId}
                  onSelect={onPreferencePresetChange}
                />
              </section>
              </>
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
                        ? 'cursor-not-allowed border border-dark-border bg-dark-light text-fg-faint'
                        : 'border border-primary/35 bg-primary/10 text-primary-text hover:border-primary/60 hover:bg-primary/15'
                    }`}
                  >
                    {tutorialSelected ? (
                      'Survey Disabled'
                    ) : !perTrialSurveyEnabled ? (
                      'Hard Task Only'
                    ) : (
                      <>
                        <span className="block">Open Survey</span>
                        <span className="mt-1 inline-block rounded-md border border-accent-line bg-accent px-2 py-0.5 text-lg font-black tracking-wide text-accent-fg">
                          {conditionCode}{perTrialSetLabel ? ` / ${perTrialSetLabel}` : ''}
                        </span>
                      </>
                    )}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleOpenPostStudySurvey}
                  className="w-full rounded-xl border border-primary/35 bg-primary/10 px-4 py-3 text-sm font-semibold text-primary-text transition-colors hover:border-primary/60 hover:bg-primary/15"
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
            <div className="mt-4 rounded-lg border border-danger bg-danger/10 px-3 py-2 text-sm text-danger-text">
              {error}
            </div>
          )}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
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
              className="w-full rounded-xl bg-primary px-4 py-4 text-base font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:rounded-lg sm:py-2 sm:text-sm sm:font-medium"
            >
              {demoMode ? ui.startDemo : 'Start Task'}
            </button>
          </div>
        </div>
      </div>

      {settingsOpen ? (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          voiceSettingsAvailable={voiceSettingsAvailable}
          voiceVerbosity={voiceVerbosity.settings}
          onPresetChange={voiceVerbosity.handlePresetChange}
          onCategoryChange={voiceVerbosity.handleCategoryChange}
          onSmartSkipChange={voiceVerbosity.handleSmartSkipChange}
          plannerModelAvailable={demoMode}
          plannerModel={plannerModelSetting.model}
          onPlannerModelChange={plannerModelSetting.handleChange}
        />
      ) : null}

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
                      {demoMode && usingAccessCode
                        ? 'Play a short sample to confirm speaker output and that your access code works.'
                        : 'Play a short sample to confirm speaker output and that your OpenAI API key works.'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handlePlaySpeakerSample()}
                    disabled={voiceCheckLoading !== 'none' || (demoMode && apiKeyMissing)}
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
                <div className="rounded-lg border border-danger bg-danger/10 px-3 py-2 text-sm text-danger-text">
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

      {credentialOpen ? (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={demoMode ? ui.credentialDialogTitle : 'API Key'}
          onClick={closeCredentialDialog}
        >
          <form
            className="w-full max-w-md rounded-t-2xl border border-dark-border bg-dark-light p-5 shadow-2xl sm:rounded-2xl sm:p-6"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              saveCredential();
            }}
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-fg-strong">
                {demoMode ? ui.credentialDialogTitle : 'API Key'}
              </h2>
              <button
                type="button"
                onClick={closeCredentialDialog}
                className="rounded-lg border border-dark-border px-3 py-1.5 text-xs font-medium text-fg hover:border-primary hover:text-fg-strong"
              >
                {ui.close}
              </button>
            </div>
            {demoMode ? (
              <>
                <p className="mb-3 text-sm text-fg-muted">{ui.demoSetupSubtitle}</p>
                <div
                  className="mb-4 flex rounded-lg bg-dark p-0.5"
                  role="radiogroup"
                  aria-label="How to authorize this demo"
                >
                  {(
                    [
                      ['code', ui.accessCodeLabel],
                      ['key', ui.apiKeyLabel],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={credentialDraftMode === mode}
                      onClick={() => {
                        setCredentialDraftMode(mode);
                        setCredentialDraft('');
                        credentialInputRef.current?.focus();
                      }}
                      className={`h-10 flex-1 rounded-md text-sm font-semibold transition-colors ${
                        credentialDraftMode === mode
                          ? 'bg-dark-light text-fg-strong shadow-sm'
                          : 'text-fg-muted hover:text-fg-strong'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="mb-3 text-sm text-fg-muted">
                Optional. Leave it empty to use the key configured on the server.
              </p>
            )}
            <label
              className="mb-1.5 block text-sm font-medium text-fg-strong"
              htmlFor={credentialDraftMode === 'code' ? 'demo-access-code' : 'demo-api-key'}
            >
              {credentialDraftMode === 'code'
                ? ui.accessCodeLabel
                : demoMode
                ? ui.apiKeyLabel
                : 'API Key'}
            </label>
            {credentialDraftMode === 'code' ? (
              <input
                ref={credentialInputRef}
                id="demo-access-code"
                type="text"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="characters"
                maxLength={12}
                value={credentialDraft}
                onChange={(event) => setCredentialDraft(event.target.value.toUpperCase())}
                placeholder="ABC123"
                className="h-12 w-full rounded-lg border border-dark-border bg-dark px-3 font-mono text-lg tracking-[0.25em] text-fg-strong outline-none transition-colors placeholder:tracking-normal placeholder:text-fg-faint focus:border-primary"
              />
            ) : (
              <input
                ref={credentialInputRef}
                id="demo-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={credentialDraft}
                onChange={(event) => setCredentialDraft(event.target.value)}
                placeholder="sk-..."
                className="h-12 w-full rounded-lg border border-dark-border bg-dark px-3 text-base text-fg-strong outline-none transition-colors placeholder:text-fg-faint focus:border-primary"
              />
            )}
            {credentialDraftPresent ? (
              <p className="mt-2 text-xs text-fg-muted">
                {credentialDraftMode === 'code' ? ui.credentialSavedCode : ui.credentialSavedKey}
              </p>
            ) : null}
            <div className="mt-5 flex items-center justify-end gap-2">
              {credentialDraftPresent ? (
                <button
                  type="button"
                  onClick={removeCredential}
                  className="rounded-lg border border-dark-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-danger hover:text-danger-text"
                >
                  {ui.credentialRemove}
                </button>
              ) : null}
              <button
                type="submit"
                disabled={!credentialDraft.trim()}
                className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ui.credentialUse}
              </button>
            </div>
          </form>
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
                className="text-primary-text underline underline-offset-2 transition-colors hover:text-primary-hover"
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
