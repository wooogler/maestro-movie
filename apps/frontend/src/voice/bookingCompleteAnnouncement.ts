/**
 * The host's one sentence at the end of a booking, and the bookkeeping that
 * keeps it the host's. DOM-free, for `bookingCompleteAnnouncement.check.ts`.
 *
 * Demo only. When the booking-complete screen appears the kiosk says "Your
 * booking is complete. Enjoy the film." through the same voice path the
 * agent's messages use (headset, or the paired phone when it holds voice), and
 * only then does voice switch off for the finish step. With voice off it plays
 * a two-note chime instead.
 *
 * It is NOT an agent utterance, and three things follow:
 *   - it is never sent to the agent: there is no `user.message`, and the agent
 *     never learns the sentence was said;
 *   - its playback completion must not reach the agent either. The agent's
 *     speech barrier counts one completion per `agent.message` it sent; a
 *     completion for this sentence would spend a credit belonging to the
 *     agent's own last message and let it act while that is still playing.
 *     The ids below are how the host's completion handler recognises it;
 *   - holding voice on for it holds nothing the agent is waiting for: the
 *     agent's barrier is still released by the voice-off that follows, exactly
 *     as before, only up to `BOOKING_COMPLETE_VOICE_OFF_CAP_MS` later.
 */
import type { Language } from '../i18n/language';

/**
 * Spoken, so every pack has it — including the voice-only ones (de/fr/es),
 * whose screen is English but whose conversation is not. Kept out of
 * `UiStrings` for the same reason: it is never drawn.
 */
export const BOOKING_COMPLETE_SPOKEN: Readonly<Record<Language, string>> = {
  en: 'Your booking is complete. Enjoy the film.',
  ko: '예매가 완료되었습니다. 즐거운 관람 되세요.',
  ja: 'ご予約が完了しました。映画をお楽しみください。',
  'zh-Hans': '您的订票已完成，祝您观影愉快。',
  'zh-Hant': '您的訂票已完成，祝您觀影愉快。',
  de: 'Ihre Buchung ist abgeschlossen. Viel Spaß beim Film.',
  fr: 'Votre réservation est confirmée. Bon film !',
  es: 'Su reserva está completa. Disfrute de la película.',
};

export function bookingCompleteSentence(language: Language | string): string {
  return BOOKING_COMPLETE_SPOKEN[language as Language] ?? BOOKING_COMPLETE_SPOKEN.en;
}

/**
 * Every utterance the host speaks on its own account carries an id with this
 * prefix. The ids of spoken agent messages are minted by the chat store
 * (`agt-…`, `chatStore.ts`) and never start with it, so the prefix alone
 * decides whose completion a playback report is.
 */
export const HOST_UTTERANCE_ID_PREFIX = 'host:';

export function hostUtteranceId(kind: string, sequence: number): string {
  return `${HOST_UTTERANCE_ID_PREFIX}${kind}:${sequence}`;
}

export function isHostUtteranceId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(HOST_UTTERANCE_ID_PREFIX);
}

/**
 * The longest voice stays on waiting for the sentence. Long enough for the
 * slowest pack to be synthesised and played (~3 s of audio plus a realtime
 * round trip), short enough that a session that never speaks it — a dropped
 * channel, a phone that went to sleep — still reaches the finish step promptly.
 */
export const BOOKING_COMPLETE_VOICE_OFF_CAP_MS = 6000;

/**
 * How long after "playback complete" voice still stays on. The completion is
 * the server's `output_audio_buffer.stopped`, which reaches the page before the
 * last of the audio has played out of the WebRTC jitter buffer: measured in
 * headless Chromium, sound was still audible ~100 ms after it. Switching voice
 * off on the event itself tears the session down under that tail.
 */
export const BOOKING_COMPLETE_PLAYOUT_TAIL_MS = 500;

/** What the screen arriving at booking complete should do, given the moment. */
export type BookingCompleteCue = 'speak' | 'chime' | 'none';

export function bookingCompleteCue(input: {
  /** Demo only; the study conditions are untouched. */
  enabled: boolean;
  voiceModeEnabled: boolean;
  /** Already announced for this booking (a re-render, a remount of the same screen). */
  alreadyAnnounced: boolean;
}): BookingCompleteCue {
  if (!input.enabled || input.alreadyAnnounced) return 'none';
  return input.voiceModeEnabled ? 'speak' : 'chime';
}

/** Two notes, rising: G5 then E6, a major sixth — a "done", not an alarm. */
export const CHIME_NOTES: ReadonlyArray<{ frequencyHz: number; startS: number; durationS: number }> = [
  { frequencyHz: 783.99, startS: 0, durationS: 0.22 },
  { frequencyHz: 1318.51, startS: 0.16, durationS: 0.42 },
];
