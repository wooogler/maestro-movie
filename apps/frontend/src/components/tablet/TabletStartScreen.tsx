/**
 * The booth tablet's start page: one line to read, the language, one button.
 *
 * Shown in place of the demo setup page when this device carries a tablet
 * profile (see `study/tabletProfile.ts`). Everything that page asks — the
 * access code, the key, the preset memory, push-to-talk, the pairing QR — is
 * either in the profile or meaningless on a tablet, so none of it is here. The
 * research-recording box stays, pre-ticked as on the full setup page, because
 * "record nothing" has to remain a choice before the session exists.
 *
 * The Start tap is load-bearing beyond navigation: it is the user gesture that
 * unlocks the shared audio element before the session request is awaited, so
 * the agent's first sentence is audible on a browser that gates `play()`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, describeApiErrorCode, getApiErrorCode } from '../../api/client';
import { DEMO_SCENARIO_ID, DEMO_STUDY_MODE } from '../../pages/studyOptions';
import { useLanguage } from '../../i18n';
import { LanguageSelect } from '../settings/LanguageSelect';
import { usePushToTalkSetting } from '../../hooks/usePushToTalk';
import { unlockVoiceAudioElement } from '../../study/voiceAudioUnlock';
import type { StudySessionState } from '../../study/sessionStorage';
import type { TabletProfile } from '../../study/tabletProfile';
import {
  clearPendingStudyLogEvents,
  hasPendingStudyLogEvent,
  queuePendingStudyLogEvent,
} from '../../study/pendingInteractionEvents';

interface TabletStartScreenProps {
  profile: TabletProfile;
  onSessionStarted: (session: StudySessionState) => void;
}

export function TabletStartScreen({ profile, onSessionStarted }: TabletStartScreenProps) {
  const navigate = useNavigate();
  const { language, setLanguage, s } = useLanguage();
  const pushToTalk = usePushToTalkSetting();
  const [consent, setConsent] = useState(profile.researchConsent);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soundStatus, setSoundStatus] = useState<'idle' | 'playing' | 'error'>('idle');
  const soundRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const hasCode = Boolean(profile.accessCode);

  /*
    Every visitor starts in the profile's language and with the box at its
    default. This screen mounts on each arrival — a fresh launch, or the
    previous visitor's session ending — so that is where it is put back.
  */
  useEffect(() => {
    setLanguage(profile.language);
    setConsent(profile.researchConsent);
    // Once per arrival, not on every language change the visitor makes here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
    A visitor who switched the language here and walked away leaves it for the
    next one. Put it back after the profile's idle window without a touch.
  */
  const languageRef = useRef(language);
  languageRef.current = language;
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (languageRef.current !== profile.language) setLanguage(profile.language);
        setConsent(profile.researchConsent);
        setError(null);
      }, profile.idleSeconds * 1000);
    };
    arm();
    const options: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('pointerdown', arm, options);
    window.addEventListener('keydown', arm, options);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', arm, options);
      window.removeEventListener('keydown', arm, options);
    };
  }, [profile.idleSeconds, profile.language, profile.researchConsent, setLanguage]);

  const stopSound = useCallback(() => {
    const current = soundRef.current;
    if (!current) return;
    current.audio.pause();
    URL.revokeObjectURL(current.url);
    soundRef.current = null;
  }, []);
  useEffect(() => stopSound, [stopSound]);

  const handleConsentChange = (next: boolean) => {
    setConsent(next);
    if (next) {
      queuePendingStudyLogEvent({
        type: 'study.consent.granted',
        clientTimestamp: new Date().toISOString(),
        payload: { location: 'tablet-start', studyMode: DEMO_STUDY_MODE },
      });
    } else {
      clearPendingStudyLogEvents();
    }
  };

  const handleStart = async () => {
    if (starting || !hasCode) return;
    // Inside the gesture, before any await: see the module comment.
    unlockVoiceAudioElement();
    stopSound();
    // The profile's turn-taking: VAD, no key to hold, whatever an earlier
    // session on this device chose.
    if (pushToTalk.enabled) pushToTalk.setEnabled(false);
    if (consent && !hasPendingStudyLogEvent('study.consent.granted')) {
      queuePendingStudyLogEvent({
        type: 'study.consent.granted',
        clientTimestamp: new Date().toISOString(),
        payload: { location: 'tablet-start', studyMode: DEMO_STUDY_MODE, byDefault: true },
      });
    }
    if (!consent) clearPendingStudyLogEvents();
    setStarting(true);
    setError(null);
    try {
      const session = await api.createStudySession({
        scenarioId: DEMO_SCENARIO_ID,
        studyMode: DEMO_STUDY_MODE,
        accessCode: profile.accessCode,
        researchConsent: consent,
      });
      onSessionStarted(session);
      navigate('/booking', { replace: true });
    } catch (err) {
      setStarting(false);
      setError(
        describeApiErrorCode(getApiErrorCode(err)) ??
          (err instanceof Error ? err.message : s.quickCardFailed)
      );
    }
  };

  // Headsets vary, so the sample stays reachable — behind a small link.
  const handleSoundTest = async () => {
    if (soundStatus === 'playing' || !hasCode) return;
    stopSound();
    setSoundStatus('playing');
    try {
      const blob = await api.synthesizeSpeechPreview('This is a speaker test.', {
        accessCode: profile.accessCode,
      });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      soundRef.current = { audio, url };
      audio.onended = () => {
        stopSound();
        setSoundStatus('idle');
      };
      audio.onerror = () => {
        stopSound();
        setSoundStatus('error');
      };
      await audio.play();
    } catch {
      stopSound();
      setSoundStatus('error');
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-dark px-4 py-4">
      <div className="mx-auto flex min-h-full w-full max-w-lg flex-col justify-center gap-5 py-2 text-center">
        <h1 className="text-3xl font-semibold leading-tight text-fg-strong sm:text-4xl">
          {s.tabletInvite}
        </h1>
        <p className="-mt-2 text-sm text-fg-muted">{s.tabletHeadsetHint}</p>

        <LanguageSelect id="tablet-language" className="text-left" label={s.languagePickerLabel} large />

        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={starting || !hasCode}
          className="min-h-16 w-full rounded-2xl bg-primary px-6 py-4 text-2xl font-semibold text-primary-fg shadow-lg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {starting ? s.tabletStarting : s.tabletStart}
        </button>

        {!hasCode ? (
          <p className="rounded-lg border border-danger bg-danger/10 px-3 py-2 text-sm text-danger-text">{s.tabletNoCode}</p>
        ) : null}
        {error ? (
          <p className="rounded-lg border border-danger bg-danger/10 px-3 py-2 text-sm text-danger-text" role="alert">
            {error}
          </p>
        ) : null}

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-dark-border bg-dark-light px-4 py-2.5 text-left">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
            checked={consent}
            onChange={(event) => handleConsentChange(event.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-fg-strong">{s.consentCheckboxLabel}</span>
            <span className="block text-xs leading-relaxed text-fg-muted">{s.tabletConsentNote}</span>
          </span>
        </label>

        <button
          type="button"
          onClick={() => void handleSoundTest()}
          disabled={!hasCode || soundStatus === 'playing'}
          className="mx-auto min-h-11 px-3 text-sm font-medium text-primary-text underline underline-offset-2 disabled:opacity-50"
        >
          {soundStatus === 'playing' ? '…' : s.tabletSoundTest}
          {soundStatus === 'error' ? ' ✕' : ''}
        </button>
      </div>
    </main>
  );
}
