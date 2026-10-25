/**
 * Demo only: the host says "Your booking is complete. Enjoy the film." when the
 * booking-complete screen appears, and holds voice on until it has been heard.
 *
 * The rules — whose utterance this is, why its completion must not reach the
 * agent, the cap — are in `voice/bookingCompleteAnnouncement.ts`. This is the
 * React half, and its one subtle part is the hold:
 *
 * The page switches voice off in an effect the moment the finish step renders.
 * A hold published from THIS hook's effect would arrive one commit too late —
 * that effect would already have run and switched voice off, tearing down the
 * session the sentence was just queued on. So the hold is derived during
 * render (`holdVoiceOn`) from facts that are already true in the very render
 * the screen first appears in, and it ends by state: playback reported done
 * (or interrupted), or the cap, whichever comes first.
 *
 * With voice off there is nothing to hold, and a two-note chime plays instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Language } from '../i18n/language';
import type { VoiceSpeakItem } from './useRealtimeVoice';
import {
  BOOKING_COMPLETE_PLAYOUT_TAIL_MS,
  BOOKING_COMPLETE_VOICE_OFF_CAP_MS,
  CHIME_NOTES,
  bookingCompleteCue,
  bookingCompleteSentence,
  hostUtteranceId,
} from '../voice/bookingCompleteAnnouncement';

interface UseBookingCompleteAnnouncementOptions {
  /** The demo. False in every study condition, where this does nothing at all. */
  enabled: boolean;
  /** The booking-complete screen is the one on screen. */
  bookingComplete: boolean;
  voiceModeEnabled: boolean;
  language: Language;
  /**
   * The page's speak path: the kiosk's realtime session, or the paired phone
   * when it holds voice. Whatever is behind it, its playback completion comes
   * back through the page's completion handler, which hands host utterances to
   * `handleHostPlaybackResolved` instead of the agent.
   */
  speak: (item: VoiceSpeakItem) => void;
  onLogEvent?: (type: string, payload: unknown) => void;
}

interface UseBookingCompleteAnnouncementResult {
  /** True while voice must stay on for the sentence; the voice-off waits on it. */
  holdVoiceOn: boolean;
  /** For the page's playback-completion handler, for ids `isHostUtteranceId` accepts. */
  handleHostPlaybackResolved: (item: VoiceSpeakItem, info: { interrupted: boolean }) => void;
  /**
   * When the completion cue finished — the sentence played out (or was
   * interrupted, or hit the cap), or the chime played — and null before that
   * or while the complete screen is not up. The booth reset counts its
   * return-to-start delay from here, so the countdown never runs under the
   * sentence that announces it. Always reached: the cap ends the sentence.
   */
  settledAtMs: number | null;
}

/*
  One AudioContext for the chime, unlocked by the visitor's own taps and keys.
  Safari will not start a context outside a user gesture, and the complete
  screen appears after an async booking call, not inside the Confirm click.
*/
let chimeContext: AudioContext | null = null;

function unlockChimeContext(): void {
  if (typeof window === 'undefined') return;
  try {
    if (!chimeContext) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      chimeContext = new Ctor();
    }
    if (chimeContext.state === 'suspended') void chimeContext.resume().catch(() => {});
  } catch {
    chimeContext = null;
  }
}

function playChime(): boolean {
  unlockChimeContext();
  const context = chimeContext;
  if (!context) return false;
  try {
    const start = context.currentTime + 0.02;
    for (const note of CHIME_NOTES) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = note.frequencyHz;
      const at = start + note.startS;
      // A soft attack and an exponential tail: a bell, not a beep.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.durationS);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + note.durationS + 0.05);
    }
    return true;
  } catch {
    return false;
  }
}

/** For a browser check: what the complete screen did, readable off `<html>`. */
function markDocument(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(name, value);
}

export function useBookingCompleteAnnouncement({
  enabled,
  bookingComplete,
  voiceModeEnabled,
  language,
  speak,
  onLogEvent,
}: UseBookingCompleteAnnouncementOptions): UseBookingCompleteAnnouncementResult {
  /** The hold for this complete screen has ended (played, interrupted, or capped). */
  const [released, setReleased] = useState(false);
  const [settledAtMs, setSettledAtMs] = useState<number | null>(null);
  const announcedRef = useRef(false);
  const pendingIdRef = useRef<string | null>(null);
  const capTimerRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  const voiceModeEnabledRef = useRef(voiceModeEnabled);
  const speakRef = useRef(speak);
  const onLogEventRef = useRef(onLogEvent);
  // Declared before the announcing effect, so it has run by the time that one
  // reads these in the same commit.
  useEffect(() => {
    voiceModeEnabledRef.current = voiceModeEnabled;
    speakRef.current = speak;
    onLogEventRef.current = onLogEvent;
  });

  // Derived in render, so it is already true in the commit that shows the
  // screen — before the page's voice-off effect reads it.
  const holdVoiceOn = enabled && bookingComplete && voiceModeEnabled && !released;

  const release = useCallback((reason: 'played' | 'interrupted' | 'cap') => {
    if (capTimerRef.current !== null) {
      window.clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
    const id = pendingIdRef.current;
    pendingIdRef.current = null;
    setReleased(true);
    setSettledAtMs(Date.now());
    markDocument('data-booking-complete-voice-off', reason);
    onLogEventRef.current?.('chat.voice_mode.booking_complete_released', { reason, utteranceId: id });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!bookingComplete) {
      // Armed again for the next booking (Reset, then another run).
      announcedRef.current = false;
      setReleased(false);
      setSettledAtMs(null);
      return;
    }
    const cue = bookingCompleteCue({
      enabled,
      voiceModeEnabled: voiceModeEnabledRef.current,
      alreadyAnnounced: announcedRef.current,
    });
    // Already announced for this screen: whatever settled it still stands.
    if (cue === 'none') return;
    announcedRef.current = true;
    const text = bookingCompleteSentence(language);
    markDocument('data-booking-complete-cue', cue);
    if (cue === 'chime') {
      const played = playChime();
      // The chime is under a second and needs no hold: settled at once.
      setSettledAtMs(Date.now());
      onLogEventRef.current?.('chat.voice_mode.booking_complete_announced', { cue, played });
      return;
    }
    sequenceRef.current += 1;
    const id = hostUtteranceId('booking-complete', sequenceRef.current);
    pendingIdRef.current = id;
    capTimerRef.current = window.setTimeout(() => {
      capTimerRef.current = null;
      if (pendingIdRef.current === id) release('cap');
    }, BOOKING_COMPLETE_VOICE_OFF_CAP_MS);
    speakRef.current({ id, text });
    markDocument('data-booking-complete-spoken', text);
    onLogEventRef.current?.('chat.voice_mode.booking_complete_announced', { cue, utteranceId: id, text, language });
  }, [bookingComplete, enabled, language, release]);

  // Leaving the page mid-sentence: nothing left to release, only a timer to drop.
  useEffect(
    () => () => {
      if (capTimerRef.current !== null) window.clearTimeout(capTimerRef.current);
    },
    []
  );

  // The chime's context is unlocked by the visitor's own input, as Safari requires.
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const unlock = () => unlockChimeContext();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, [enabled]);

  const handleHostPlaybackResolved = useCallback(
    (item: VoiceSpeakItem, info: { interrupted: boolean }) => {
      if (!item.id || item.id !== pendingIdRef.current) return;
      if (info.interrupted) {
        release('interrupted');
        return;
      }
      // Played to the end on the server's clock; let the last ~100 ms leave the
      // speaker before the session is torn down. Replaces the cap timer, which
      // can no longer be what ends this.
      if (capTimerRef.current !== null) window.clearTimeout(capTimerRef.current);
      capTimerRef.current = window.setTimeout(() => {
        capTimerRef.current = null;
        if (pendingIdRef.current === item.id) release('played');
      }, BOOKING_COMPLETE_PLAYOUT_TAIL_MS);
    },
    [release]
  );

  return { holdVoiceOn, handleHostPlaybackResolved, settledAtMs };
}
