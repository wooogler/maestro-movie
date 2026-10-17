/**
 * The paired phone: this session's microphone and speaker.
 *
 * Reached by scanning the "use my phone" QR, which puts a companion token in the
 * URL **fragment** — never the query string, so it stays out of access logs and
 * proxy history, the same rule the memory-mirror QR follows.
 *
 * The phone is deliberately dumb about the *conversation*. It captures audio and
 * plays audio; transcripts go up raw, playback reports go up raw, and the kiosk
 * applies the short-utterance filter, the replay rule and every log line. That is
 * what keeps the agent's speech barrier owned by exactly one device.
 *
 * The one thing it does decide is whether it is holding the microphone at all —
 * the visitor taps here to take voice and taps again to give it back, because
 * they are holding this and not the kiosk. Even that is phrased as a request:
 * the kiosk owns `voiceOutputTarget` and answers with `companion.config`, so
 * capture starts only once the kiosk has actually let go.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { AgentMemoryPanel } from '../components/memory';
import { PREFERENCE_PRESETS, localizePreset } from '../study/preferenceProfile';
import { useCompanionLink } from '../components/companion/useCompanionLink';
import { useRealtimeVoice, type VoiceSpeakItem } from '../hooks/useRealtimeVoice';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock';
import { useLanguage } from '../i18n';

export function DemoCompanionPage() {
  const { s, language } = useLanguage();

  const [companionToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = window.location.hash.replace(/^#/, '').trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  });

  const link = useCompanionLink(companionToken);
  // Destructured: `link` is a fresh object every render, so depending on it
  // would rebuild these handlers continuously.
  const { sendClaim } = link;

  /**
   * iOS Safari will not play audio unless the element was started from a user
   * gesture. The voice session opens when the *kiosk* pushes config, which is
   * nowhere near a tap — so the element is created and unlocked inside this
   * button's handler and handed to the voice hook, which reuses it.
   */
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  /**
   * One tap does both jobs, because to the visitor they are one act: it unlocks
   * audio (which must happen inside a real gesture, see above) and asks the
   * kiosk to move voice onto this phone.
   *
   * The phone asks rather than decides. The kiosk owns `voiceOutputTarget` and
   * answers by pushing `companion.config` with `listening: true`, which is what
   * actually starts capture — so the phone can never end up capturing while the
   * kiosk still thinks it owns the microphone.
   */
  const unlockAudio = useCallback(() => {
    if (!audioElementRef.current) {
      const element = document.createElement('audio');
      element.autoplay = true;
      element.setAttribute('playsinline', 'true');
      element.style.display = 'none';
      document.body.appendChild(element);
      audioElementRef.current = element;
    }
    // Playing an empty element inside the gesture is what marks it as
    // user-activated for the rest of its life. It rejects immediately (no
    // source), and that rejection is expected and meaningless.
    void audioElementRef.current.play().catch(() => {});
    setUnlocked(true);
    sendClaim(true);
  }, [sendClaim]);

  /** Hand voice back to the kiosk's headset without unpairing. */
  const handBack = useCallback(() => {
    sendClaim(false);
  }, [sendClaim]);

  useEffect(
    () => () => {
      const element = audioElementRef.current;
      audioElementRef.current = null;
      if (element) {
        element.pause();
        element.srcObject = null;
        element.remove();
      }
    },
    []
  );

  const audioSink = useCallback(() => audioElementRef.current, []);

  const createSession = useCallback(
    async (language: string) => {
      if (!companionToken) throw new Error('This phone is not paired.');
      return api.createCompanionRealtimeSession(companionToken, language);
    },
    [companionToken]
  );

  const speakingItemRef = useRef<VoiceSpeakItem | null>(null);

  const {
    supported,
    inputStatus,
    outputStatus,
    error: voiceError,
    speak,
    stop,
  } = useRealtimeVoice({
    // `listening` gates the whole session rather than only delivery: when the
    // kiosk takes voice back it pushes listening:false, and this phone must
    // release its microphone rather than keep capturing quietly.
    enabled: unlocked && link.status === 'paired' && link.config?.listening === true,
    transcriptionPrompt: link.config?.transcriptionPrompt ?? null,
    language: link.config?.language ?? 'en',
    createSession,
    audioSink,
    onTranscript: ({ text, durationMs }) => link.sendTranscript({ text, durationMs }),
    onSpeakingItemChange: (item) => {
      speakingItemRef.current = item;
    },
    onPlaybackComplete: (item, { interrupted }) =>
      link.sendPlaybackComplete({ id: item.id, interrupted }),
  });

  // Drive the speaker from what the kiosk hands over. Keyed on `seq` so an
  // identical repeat of the same sentence still fires.
  const lastSpeakSeqRef = useRef(0);
  useEffect(() => {
    const request = link.speakRequest;
    if (!request || request.seq === lastSpeakSeqRef.current) return;
    lastSpeakSeqRef.current = request.seq;
    if (request.stop) {
      stop();
      return;
    }
    if (request.text) speak({ id: request.id, text: request.text });
  }, [link.speakRequest, speak, stop]);

  const hasVoice = link.config?.listening === true;
  const capturing = hasVoice && unlocked;
  useScreenWakeLock(capturing);

  const statusLine = useMemo(() => {
    if (!companionToken) return s.companionNoToken;
    if (link.status === 'unpaired') return link.message ?? s.companionUnpaired;
    if (link.status === 'connecting' || link.status === 'idle') return s.companionConnecting;
    // Paired, but nobody is on the other end yet: the visitor can scan from the
    // pairing screen, before the kiosk has entered the booking page at all.
    // Without this the phone says "tap to start" and then does nothing when you
    // do, which reads as a broken button rather than as waiting.
    if (!link.config) return s.companionWaitingHost;
    if (!unlocked) return s.companionTapToStart;
    if (!supported) return s.companionUnsupported;
    if (voiceError) return voiceError;
    if (link.config?.listening !== true) return s.companionOnKiosk;
    if (outputStatus === 'playing') return s.companionSpeaking;
    if (inputStatus === 'requesting-permission') return s.companionMicPermission;
    if (inputStatus === 'capturing') return s.companionHearing;
    if (inputStatus === 'listening') return s.companionListening;
    return s.companionReady;
  }, [
    companionToken,
    link.status,
    link.message,
    link.config,
    unlocked,
    supported,
    voiceError,
    outputStatus,
    inputStatus,
    s,
  ]);

  const live = capturing && (inputStatus === 'listening' || inputStatus === 'capturing');

  const audioReady = Boolean(companionToken) && link.status !== 'unpaired' && Boolean(link.config);
  const audioAction = !unlocked || !hasVoice ? unlockAudio : handBack;
  const audioLabel = hasVoice ? s.companionHandBack : s.companionTakeVoice;

  return (
    <div className="app-viewport relative flex flex-col bg-dark">
      <header className="shrink-0 px-5 pb-3 pt-6">
        <h1 className="text-lg font-semibold text-fg-strong">{s.companionTitle}</h1>
        <p className="mt-1 text-sm text-fg-muted">{statusLine}</p>
      </header>

      {/*
        The visitor's own memory, and the page's actual content.

        It used to sit under a 160px microphone circle centred in a flex-1 box,
        which on a phone pushed everything worth reading below the fold. The
        audio control is one occasional tap; the memory is what the visitor
        looks at for the whole session, so the memory gets the page and the
        control floats over it.

        Editable, and the phone stores none of it: every control asks the kiosk,
        which owns the socket, and what comes back on `agent.memory` is the only
        state rendered here. Not extra authority either — a paired phone already
        holds the microphone, so it can already build and retract preferences by
        talking.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-28">
        {link.memory ? (
          <>
            <AgentMemoryPanel
              snapshot={link.memory}
              currentStage={null}
              showHeading={false}
              onPreferenceDelete={(preferenceId) =>
                link.sendMemoryCommand({ kind: 'preference.delete', preferenceId })
              }
              onPreferenceRestore={(preferenceId) =>
                link.sendMemoryCommand({ kind: 'preference.restore', preferenceId })
              }
              onPreferenceClearAll={() => link.sendMemoryCommand({ kind: 'preference.clear' })}
            />

            <details className="mt-4 rounded-lg border border-dark-border px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-fg-muted">
                {s.preferenceMemoryTitle}
              </summary>
              <div className="mt-2 grid gap-1.5">
                {PREFERENCE_PRESETS.map((raw) => localizePreset(raw, language)).map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() =>
                      link.sendMemoryCommand({ kind: 'profile.load', presetId: preset.id })
                    }
                    className="rounded-lg border border-dark-border px-3 py-2 text-left transition-colors hover:border-primary"
                  >
                    <span className="block text-sm font-semibold text-fg-strong">{preset.label}</span>
                    <span className="mt-0.5 block text-xs text-fg-muted">{preset.blurb}</span>
                  </button>
                ))}
              </div>
            </details>
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-dark-border px-4 py-6 text-center text-sm text-fg-muted">
            {s.companionMemoryWaiting}
          </p>
        )}
      </div>

      {/*
        Floating, and absolute rather than fixed: an iOS URL bar collapsing on
        scroll moves the visual viewport, and a fixed element rides that
        movement instead of staying put over the page. `app-viewport` is a
        definite height, so anchoring to it keeps the control still.

        Disabled until the kiosk has actually answered, because until then the
        tap genuinely cannot do anything and a live-looking button that eats
        taps is the thing being fixed here.
      */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-6">
        <button
          type="button"
          onClick={audioAction}
          disabled={!audioReady}
          aria-label={audioLabel}
          className={`pointer-events-auto flex items-center gap-2.5 rounded-full border-2 px-5 py-3 shadow-lg backdrop-blur transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            live
              ? 'border-accent-line bg-accent/25 text-accent-text'
              : 'border-primary bg-dark-light/95 text-primary-text'
          }`}
        >
          <svg
            className="h-6 w-6 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15a3 3 0 003-3V7a3 3 0 10-6 0v5a3 3 0 003 3z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0M12 18v3M8 21h8" />
          </svg>
          <span className="text-sm font-semibold">{audioLabel}</span>
        </button>
      </div>
    </div>
  );
}
