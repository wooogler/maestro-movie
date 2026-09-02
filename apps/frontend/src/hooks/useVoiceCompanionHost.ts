import { useCallback, useEffect, useRef } from 'react';
import type { VoiceSpeakItem } from './useRealtimeVoice';

/**
 * The kiosk's half of phone voice.
 *
 * The phone is deliberately dumb: it captures audio and plays audio. Everything
 * that decides anything stays here — the short-utterance filter, the
 * replay-suppression rule, the study logging, and above all the single
 * `tts.playback.complete` the agent's speech barrier is counting. The phone
 * reports to the host; the host reports to the agent.
 *
 * Three rules in this file are not obvious and each one is load-bearing.
 *
 * **1. Ownership is latched on the visitor's choice, never on presence.**
 * `companionActive` arrives on `relay.presence`, and the host's own relay socket
 * reconnects on a flat 1200ms timer. During that gap presence is simply absent —
 * which says nothing about the phone, whose own socket never dropped. Deriving
 * ownership from presence would therefore hand voice back to the kiosk on every
 * host hiccup: the kiosk would open its mic mid-utterance, transcribe the
 * phone's own speaker, and submit the agent's words back as the visitor's.
 * `target` only ever changes because a person changed it.
 *
 * **2. Config is pushed on the phone's `hello`, not on a presence edge.**
 * The companion slot is newest-wins. When a second phone joins, the slot is
 * reassigned before the first phone's close handler runs, so `companionActive`
 * never transitions false→true and an edge-triggered push never fires — leaving
 * the new phone with no language and no prompt while the host forwards
 * utterances into it forever. A `hello` on every join is race-free.
 *
 * **3. The watchdog fires before the agent's barrier does.**
 * The agent waits `TTS_PLAYBACK_TIMEOUT_MS` (15s) for a completion and then
 * releases itself. If a phone dies mid-utterance and the host waited longer than
 * that, every turn would cost the agent its full timeout. Resolving first means
 * a dead phone looks like a fast interruption instead.
 */

/** Deliberately under the agent's 15s barrier timeout. See rule 3. */
const COMPANION_PLAYBACK_WATCHDOG_MS = 12_000;

export type VoiceOutputTarget = 'kiosk' | 'companion';

interface UseVoiceCompanionHostOptions {
  /** Demo-only master switch. False in every study condition. */
  enabled: boolean;
  /** The visitor's choice. Only a user action moves this. */
  target: VoiceOutputTarget;
  language: string;
  transcriptionPrompt: string | null;
  /** Whether the phone should be capturing at all (voice mode on and usable). */
  listening: boolean;
  sendCompanionSpeak: (item: { id: string | null; text: string; stop?: boolean }) => void;
  sendCompanionConfig: (config: {
    language: string;
    transcriptionPrompt: string | null;
    listening: boolean;
  }) => void;
  /**
   * The host's own completion funnel — the same one the kiosk's local playback
   * feeds, so the replay rule and `tts.playback.complete` happen exactly once
   * whichever device actually made the sound.
   */
  onPlaybackResolved: (item: VoiceSpeakItem, info: { interrupted: boolean }) => void;
}

interface UseVoiceCompanionHostResult {
  /** True when the phone, not the kiosk, is this session's mic and speaker. */
  owns: boolean;
  /** Hand an utterance to the phone. */
  speakOnCompanion: (item: VoiceSpeakItem) => void;
  /** Cut the phone off mid-utterance and settle anything outstanding. */
  stopOnCompanion: () => void;
  /** Wire to the bridge's `onCompanionHello`. */
  handleCompanionHello: () => void;
  /** Wire to the bridge's `onCompanionPlaybackComplete`. */
  handleCompanionPlaybackComplete: (payload: { id: string | null; interrupted: boolean }) => void;
}

export function useVoiceCompanionHost({
  enabled,
  target,
  language,
  transcriptionPrompt,
  listening,
  sendCompanionSpeak,
  sendCompanionConfig,
  onPlaybackResolved,
}: UseVoiceCompanionHostOptions): UseVoiceCompanionHostResult {
  const owns = enabled && target === 'companion';

  const pendingRef = useRef(new Map<string, { item: VoiceSpeakItem; timer: number }>());
  const onPlaybackResolvedRef = useRef(onPlaybackResolved);
  const sendSpeakRef = useRef(sendCompanionSpeak);
  const sendConfigRef = useRef(sendCompanionConfig);
  useEffect(() => {
    onPlaybackResolvedRef.current = onPlaybackResolved;
    sendSpeakRef.current = sendCompanionSpeak;
    sendConfigRef.current = sendCompanionConfig;
  }, [onPlaybackResolved, sendCompanionSpeak, sendCompanionConfig]);

  /** A speak with no id still needs a pending key, or its watchdog cannot be found. */
  const keyFor = (item: VoiceSpeakItem, seq: number): string => item.id ?? `anon-${seq}`;
  const seqRef = useRef(0);

  const resolvePending = useCallback((key: string, interrupted: boolean) => {
    const entry = pendingRef.current.get(key);
    if (!entry) return;
    pendingRef.current.delete(key);
    window.clearTimeout(entry.timer);
    onPlaybackResolvedRef.current(entry.item, { interrupted });
  }, []);

  const resolveAllPending = useCallback(
    (interrupted: boolean) => {
      for (const key of Array.from(pendingRef.current.keys())) {
        resolvePending(key, interrupted);
      }
    },
    [resolvePending]
  );

  const speakOnCompanion = useCallback(
    (item: VoiceSpeakItem) => {
      seqRef.current += 1;
      const key = keyFor(item, seqRef.current);
      // Replacing an outstanding entry for the same id would strand its
      // watchdog; settle the old one first so the barrier stays balanced.
      resolvePending(key, true);
      const timer = window.setTimeout(() => {
        pendingRef.current.delete(key);
        onPlaybackResolvedRef.current(item, { interrupted: true });
      }, COMPANION_PLAYBACK_WATCHDOG_MS);
      pendingRef.current.set(key, { item, timer });
      sendSpeakRef.current({ id: item.id, text: item.text });
    },
    [resolvePending]
  );

  const stopOnCompanion = useCallback(() => {
    // `stop: true` rather than empty text: the phone's speak() early-returns on
    // an empty string, so a bare empty frame would be swallowed silently.
    sendSpeakRef.current({ id: null, text: '', stop: true });
    resolveAllPending(true);
  }, [resolveAllPending]);

  const handleCompanionPlaybackComplete = useCallback(
    (payload: { id: string | null; interrupted: boolean }) => {
      if (payload.id) {
        resolvePending(payload.id, payload.interrupted);
        return;
      }
      // An id-less completion can only be matched to a single outstanding
      // utterance. With several in flight, guessing would spend the wrong
      // credit, so it is dropped and the watchdog settles them instead.
      if (pendingRef.current.size === 1) {
        resolvePending(Array.from(pendingRef.current.keys())[0], payload.interrupted);
      }
    },
    [resolvePending]
  );

  const pushConfig = useCallback(() => {
    sendConfigRef.current({ language, transcriptionPrompt, listening });
  }, [language, transcriptionPrompt, listening]);

  const handleCompanionHello = useCallback(() => {
    // Unconditional. A phone that just announced itself has no state, and the
    // cost of a redundant push is one small envelope.
    pushConfig();
  }, [pushConfig]);

  // Content-change pushes on top of the hello, so a stage change or a language
  // switch reaches an already-paired phone.
  useEffect(() => {
    if (!owns) return;
    pushConfig();
  }, [owns, pushConfig]);

  // Handing voice back to the kiosk must silence the phone. Without this the
  // phone keeps playing the utterance it was already given while the kiosk opens
  // its own microphone — the exact double-audio state ownership exists to avoid.
  const previousOwnsRef = useRef(owns);
  useEffect(() => {
    const previous = previousOwnsRef.current;
    previousOwnsRef.current = owns;
    if (previous && !owns) {
      sendSpeakRef.current({ id: null, text: '', stop: true });
      sendConfigRef.current({ language, transcriptionPrompt, listening: false });
      resolveAllPending(true);
    }
  }, [owns, language, transcriptionPrompt, resolveAllPending]);

  // Unmount must not leave the agent waiting on a completion that can no longer
  // arrive; the watchdogs themselves die with the page.
  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const entry of pending.values()) window.clearTimeout(entry.timer);
      pending.clear();
    };
  }, []);

  return {
    owns,
    speakOnCompanion,
    stopOnCompanion,
    handleCompanionHello,
    handleCompanionPlaybackComplete,
  };
}
