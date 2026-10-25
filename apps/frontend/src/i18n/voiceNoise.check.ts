/**
 * Executable check for the booth's noise rules on the transcript gate:
 *
 *   npx tsx apps/frontend/src/i18n/voiceNoise.check.ts
 *
 * Two booth-only additions (KSEA poster session, 2026-10-24; Round 3 of
 * docs/scenarios/ksea2026-korean-simulation.md):
 *
 *   - `boothEcho`: one augmented on-screen label read back ("Clayface · R") is
 *     a prompt echo. Without the option the gate is exactly the study's.
 *   - `isLowContentTranscript`: a fragment, a bare "what?", an exclamation.
 *     ChatPage still sends it to the agent but does not stop the agent's
 *     sentence for it.
 *
 * Visitor lines here are made up in the shape of the hall's noise, not copied
 * from the logs. Exit code 0 means every case passed.
 */
import type { Language } from './language';
import { getIgnoredVoiceTranscriptReason, isLowContentTranscript } from './voiceInput';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function gate(text: string, language: Language, hintLabels: string[], boothEcho: boolean, durationMs = 1200) {
  return getIgnoredVoiceTranscriptReason(text, durationMs, {
    language,
    shortInputMaxDurationMs: 300,
    shortInputMaxChars: 2,
    hintLabels,
    ...(boothEcho ? { boothEcho: true } : {}),
  });
}

// What the movie stage put on screen after an age-rating augment, and what the
// time stage put there after an end-time augment.
const MOVIE_AUGMENTED = ['The Legend of Aang: The Last Airbender · PG', 'Street Fighter · PG-13', 'Clayface · R', 'Wildwood · PG', 'Klara and the Sun · PG-13'];
const TIME_AUGMENTED = ['4:10 PM · ends 6:08 PM', '6:50 PM · ends 8:48 PM', '9:30 PM · ends 11:28 PM'];
const MOVIE_PLAIN = ['The Legend of Aang: The Last Airbender', 'Street Fighter', 'Clayface', 'Wildwood', 'Klara and the Sun'];

console.log('\n1. one augmented label read back is an echo, in the booth');
{
  check('"Clayface · R." (822a4a42) is an echo', gate('Clayface · R.', 'ko', MOVIE_AUGMENTED, true) === 'prompt_echo');
  check('an end-time label read back is an echo', gate('6:50 PM · ends 8:48 PM', 'ko', TIME_AUGMENTED, true) === 'prompt_echo');
  check('in English too', gate('Clayface · R', 'en', MOVIE_AUGMENTED, true) === 'prompt_echo');
  check('the study gate is unchanged: not an echo without the option', gate('Clayface · R.', 'ko', MOVIE_AUGMENTED, false) === null);
  check('a visitor naming the film still gets through', gate('Clayface', 'ko', MOVIE_AUGMENTED, true) === null);
  check('...and saying it with a rating', gate('클레이페이스 R등급이요', 'ko', MOVIE_AUGMENTED, true) === null);
  check('...and in English', gate('Clayface, the R one.', 'en', MOVIE_AUGMENTED, true) === null);
  check('a separator with no such label on screen is not an echo', gate('Clayface · R.', 'ko', MOVIE_PLAIN, true) === null);
  check('a start time alone still gets through', gate('6:50 PM', 'ko', TIME_AUGMENTED, true) === null);
}

console.log('\n2. low-content transcripts (Korean)');
{
  for (const text of ['저기 그게...', '이걸', '응?', '와...', '맛있겠다.', '음', '그러니까...']) {
    check(`low: ${text}`, isLowContentTranscript(text, 'ko', MOVIE_PLAIN));
  }
  for (const text of [
    '네.', '네, 좋아요.', '아니요.', '그걸로 할게요.', '토요일로요.', '내일', '가운데쯤으로', '두 번째', '7시 40분으로 해 줘.',
    'C4', '디트로이트로', 'Clayface', '클라라와 태양 보고 싶어요.', '시네마 디트로이트', '다시 처음부터', '15마일 넘는 데는 안 돼요.',
  ]) {
    check(`content: ${text}`, !isLowContentTranscript(text, 'ko', MOVIE_PLAIN));
  }
}

console.log('\n3. low-content transcripts (English, and the unmeasured rest)');
{
  for (const text of ['what?', 'huh', 'um', 'wait...']) check(`low: ${text}`, isLowContentTranscript(text, 'en', MOVIE_PLAIN));
  for (const text of ['yes', 'no', 'Saturday', 'the first one', 'Klara and the Sun', 'seven forty', 'C4 and C5', "I don't know what that is"]) {
    check(`content: ${text}`, !isLowContentTranscript(text, 'en', MOVIE_PLAIN));
  }
  check('Japanese: a plain answer is content', !isLowContentTranscript('はい', 'ja'));
  check('Japanese: a trailing-off fragment is low', isLowContentTranscript('ええと…', 'ja'));
  check('German: a sentence is content', !isLowContentTranscript('Ich möchte Klara and the Sun sehen.', 'de'));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall voice-noise checks passed');
