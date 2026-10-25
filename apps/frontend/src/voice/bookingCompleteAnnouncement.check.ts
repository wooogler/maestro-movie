/**
 * Executable check for the host's booking-complete sentence:
 *
 *   npx tsx apps/frontend/src/voice/bookingCompleteAnnouncement.check.ts
 *
 * Exit code 0 means every case passed.
 */
import { LANGUAGES } from '../i18n/language';
import {
  BOOKING_COMPLETE_PLAYOUT_TAIL_MS,
  BOOKING_COMPLETE_SPOKEN,
  BOOKING_COMPLETE_VOICE_OFF_CAP_MS,
  CHIME_NOTES,
  bookingCompleteCue,
  bookingCompleteSentence,
  hostUtteranceId,
  isHostUtteranceId,
} from './bookingCompleteAnnouncement';

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(name: string): void {
  console.log(`\n${name}`);
}

section('1. every pack has the sentence, in its own words');
{
  const missing = LANGUAGES.filter((language) => !BOOKING_COMPLETE_SPOKEN[language]?.trim());
  check('every language, voice-only packs included', missing.length === 0, missing.join(', '));
  check('the two the user named, verbatim', BOOKING_COMPLETE_SPOKEN.ko === '예매가 완료되었습니다. 즐거운 관람 되세요.' && BOOKING_COMPLETE_SPOKEN.en === 'Your booking is complete. Enjoy the film.');
  const copies = LANGUAGES.filter((language) => language !== 'en' && BOOKING_COMPLETE_SPOKEN[language] === BOOKING_COMPLETE_SPOKEN.en);
  check('none is a copy of the English', copies.length === 0, copies.join(', '));
  check('Hangul in Korean, kana in Japanese, Han in both Chinese', /[가-힣]/.test(BOOKING_COMPLETE_SPOKEN.ko) && /[぀-ヿ]/.test(BOOKING_COMPLETE_SPOKEN.ja) && /[一-鿿]/.test(BOOKING_COMPLETE_SPOKEN['zh-Hans']) && /[一-鿿]/.test(BOOKING_COMPLETE_SPOKEN['zh-Hant']));
  check('Simplified and Traditional differ', BOOKING_COMPLETE_SPOKEN['zh-Hans'] !== BOOKING_COMPLETE_SPOKEN['zh-Hant']);
  check('short enough to finish inside the cap (one breath)', LANGUAGES.every((language) => BOOKING_COMPLETE_SPOKEN[language].length <= 60));
  check('an unknown language falls back to English', bookingCompleteSentence('xx') === BOOKING_COMPLETE_SPOKEN.en);
}

section('2. a host utterance is recognisably not the agent\'s');
{
  const id = hostUtteranceId('booking-complete', 3);
  check('host ids are host ids', isHostUtteranceId(id));
  check(
    'chat-store message ids never are (agent, system, user)',
    ['agt-1730000000000-abc1234', 'sys-1730000000000-abc1234', 'usr-1730000000000-abc1234'].every((value) => !isHostUtteranceId(value))
  );
  check('a missing id is not a host utterance', !isHostUtteranceId(null) && !isHostUtteranceId(undefined) && !isHostUtteranceId(''));
  check('each announcement gets its own id', hostUtteranceId('booking-complete', 1) !== hostUtteranceId('booking-complete', 2));
}

section('3. what the complete screen does');
{
  check('voice on: speak', bookingCompleteCue({ enabled: true, voiceModeEnabled: true, alreadyAnnounced: false }) === 'speak');
  check('voice off: chime', bookingCompleteCue({ enabled: true, voiceModeEnabled: false, alreadyAnnounced: false }) === 'chime');
  check('once per screen', bookingCompleteCue({ enabled: true, voiceModeEnabled: true, alreadyAnnounced: true }) === 'none');
  check(
    'the study conditions: nothing, voice on or off',
    bookingCompleteCue({ enabled: false, voiceModeEnabled: true, alreadyAnnounced: false }) === 'none' &&
      bookingCompleteCue({ enabled: false, voiceModeEnabled: false, alreadyAnnounced: false }) === 'none'
  );
  check('the voice-off cap is 6 s', BOOKING_COMPLETE_VOICE_OFF_CAP_MS === 6000);
  check(
    'the playout tail covers the measured ~100 ms and is a small part of the cap',
    BOOKING_COMPLETE_PLAYOUT_TAIL_MS >= 200 && BOOKING_COMPLETE_PLAYOUT_TAIL_MS <= 1000 &&
      BOOKING_COMPLETE_PLAYOUT_TAIL_MS < BOOKING_COMPLETE_VOICE_OFF_CAP_MS / 4
  );
  check(
    'the chime is two rising notes, under a second',
    CHIME_NOTES.length === 2 &&
      CHIME_NOTES[1].frequencyHz > CHIME_NOTES[0].frequencyHz &&
      Math.max(...CHIME_NOTES.map((note) => note.startS + note.durationS)) < 1
  );
}

console.log(failures === 0 ? '\nall booking-complete announcement checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
