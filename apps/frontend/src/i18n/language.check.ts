/**
 * Executable check for the language option. No test runner is configured in
 * this repo, so this is a plain script:
 *
 *   npx tsx apps/frontend/src/i18n/language.check.ts
 *
 * The load-bearing claim it defends is that turning this feature on changed
 * nothing for English. Every `en` branch here is asserted against the literal
 * text that was in the code before the language option existed.
 *
 * Exit code 0 means every case passed.
 */
import { DEFAULT_LANGUAGE, LANGUAGES, parseLanguage, STT_LOCALE } from './language';
import { UI_STRINGS, stringsFor, type UiStrings } from './strings';
import {
  buildTranscriptionPrompt,
  collectStageHintLabels,
  getIgnoredVoiceTranscriptReason,
} from './voiceInput';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function gate(
  text: string,
  durationMs: number,
  language: 'en' | 'ko',
  hintLabels: string[] = []
) {
  return getIgnoredVoiceTranscriptReason(text, durationMs, {
    language,
    shortInputMaxDurationMs: 300,
    shortInputMaxChars: 2,
    hintLabels,
  });
}

// The labels each stage actually put on screen in the traced sessions.
const MOVIE_HINTS = [
  'The Legend of Aang: The Last Airbender',
  'Street Fighter',
  'Clayface',
  'Wildwood',
  'Klara and the Sun',
];
const TIME_HINTS = ['12:40 PM · 3D', '3:45 PM · 3D', '6:55 PM · 3D', '10:00 PM · 3D'];
const THEATER_HINTS = [
  'Emagine Royal Oak',
  'Bel Air Luxury Cinema',
  'MJR Troy Grand Digital Cinema 16',
];
const DATE_HINTS = ['Wed, Nov 4', 'Thu, Nov 5', 'Fri, Nov 6'];
const SEAT_HINTS = collectStageHintLabels(
  'en',
  'seat',
  ['E9 - Standard - $14.00', 'E10 - Standard - $14.00', 'F9 - Standard - $14.00'],
  { maxOptions: 15, maxTextLength: 300 }
);

// -----------------------------------------------------------------------------
section('1. English is byte-for-byte what it was before this option existed');
// -----------------------------------------------------------------------------
{
  // Copied verbatim from the pre-change ChatPage.buildVoiceTranscriptionPrompt.
  const BASE =
    'Transcribe only what is actually spoken. Do not add words that are not in the audio. ' +
    'If the audio contains only silence, background noise, or unintelligible sounds, respond with an empty string. ' +
    'If the speech is unclear, transcribe the closest recognizable words only. ' +
    'The user may reply with short conversational responses like "yes", "no", "sure", "go back", "that one", or "sounds good" — ' +
    'transcribe these as-is without forcing a match to the options below.';

  check(
    'the movie-stage prompt is unchanged',
    buildTranscriptionPrompt('en', 'movie', 'Street Fighter, Wildwood') ===
      `${BASE} The user is choosing a movie. Possible options on screen: Street Fighter, Wildwood.`
  );
  // The seat prompt is the one deliberate departure from the pre-change text: a
  // row sentence was added in both languages after a Korean session could not
  // pick row E. Everything around it is still the original wording.
  check(
    'the seat-stage prompt keeps its original wording around the new row sentence',
    buildTranscriptionPrompt('en', 'seat', 'A1, B5').startsWith(
      `${BASE} The user is choosing a seat. Preserve letter-number labels like A1, B5, F6 exactly. `
    ) && buildTranscriptionPrompt('en', 'seat', 'A1, B5').endsWith('Possible labels: A1, B5.')
  );
  check(
    'an unknown stage still falls back the way it did',
    buildTranscriptionPrompt('en', 'nonsense', 'x') ===
      `${BASE} The user is choosing an option. Possible options on screen: x.`
  );

  check('English is the default', DEFAULT_LANGUAGE === 'en');
  // The planner prompt's half of this claim lives in the agent workspace:
  //   apps/tuning-agent/src/llm/languagePrompt.check.ts
}

// -----------------------------------------------------------------------------
section('2. the transcript gate no longer discards Korean');
// -----------------------------------------------------------------------------
{
  // The defect: `containsHangul(text) -> 'non_english'` ran before anything
  // else, so a Korean session could not deliver a single utterance.
  check('Korean speech is rejected in an English session', gate('네 좋아요', 900, 'en') === 'non_english');
  check('Korean speech passes in a Korean session', gate('네 좋아요', 900, 'ko') === null);

  check(
    'an English film title still passes in a Korean session',
    gate('Street Fighter', 900, 'ko') === null,
    'a Korean speaker naming a film has no Hangul in the transcript'
  );

  check('English fillers are still dropped', gate('um', 200, 'en') === 'filler_only');
  check('Korean fillers are dropped', gate('음', 200, 'ko') === 'filler_only');
  check(
    'a one-syllable Korean answer survives the too-short rule',
    gate('네', 200, 'ko') === null,
    'Korean carries a whole answer in one syllable far more often than English'
  );
  check(
    'a clipped English token is still too short',
    gate('hi', 200, 'en') === 'too_short',
    'two characters inside the 300ms window, and not one of the meaningful shorts'
  );
  check('the meaningful English shorts still survive', gate('no', 200, 'en') === null);
  check('silence is too short in both languages', gate('', 900, 'en') === 'too_short' && gate('', 900, 'ko') === 'too_short');
}

// -----------------------------------------------------------------------------
section('3. the string table is complete and distinct');
// -----------------------------------------------------------------------------
{
  const keys = Object.keys(UI_STRINGS.en) as Array<keyof UiStrings>;
  // `weekdayShort` is an array, and `locale` is a BCP-47 tag rather than prose;
  // neither is asserted the way the visible strings are.
  const prose = keys.filter((key) => key !== 'weekdayShort' && key !== 'locale');
  check('both languages define the same keys', keys.every((key) => key in UI_STRINGS.ko));
  check(
    // Catches a key that was copied across and never translated.
    'no Korean value was left as its English placeholder',
    prose.every((key) => UI_STRINGS.ko[key] !== UI_STRINGS.en[key]),
    prose.filter((key) => UI_STRINGS.ko[key] === UI_STRINGS.en[key]).join(', ')
  );
  check(
    'every Korean string actually contains Hangul',
    prose.every((key) => /[가-힣]/.test(String(UI_STRINGS.ko[key]))),
    prose.filter((key) => !/[가-힣]/.test(String(UI_STRINGS.ko[key]))).join(', ')
  );
  check(
    'each language names a locale for the formatted month heading',
    UI_STRINGS.en.locale === 'en-US' && UI_STRINGS.ko.locale === 'ko-KR'
  );
  check('both weekday rows have seven days', UI_STRINGS.en.weekdayShort.length === 7 && UI_STRINGS.ko.weekdayShort.length === 7);
  check('an unknown language falls back to English', stringsFor('de' as 'en') === UI_STRINGS.en);
  check('parseLanguage rejects anything unexpected', parseLanguage('de') === 'en' && parseLanguage('ko') === 'ko');
  check('every language has an STT locale', LANGUAGES.every((language) => Boolean(STT_LOCALE[language])));
}


// -----------------------------------------------------------------------------
section('4. the transcriber quoting its own prompt back is not speech');
// -----------------------------------------------------------------------------
{
  // All three come from real demo traces: the VAD measured about a second and a
  // half of audio and the model returned the entire on-screen option list.
  check(
    'the movie list read back is an echo',
    gate(
      'The Legend of Aang: The Last Airbender, Street Fighter, Clayface, Wildwood, Klara and the Sun.',
      1388,
      'en',
      MOVIE_HINTS
    ) === 'prompt_echo'
  );
  check(
    'the showtime list read back is an echo, separators and all',
    gate('12:40 PM · 3D, 3:45 PM · 3D, 6:55 PM · 3D, 10:00 PM · 3D.', 1292, 'en', TIME_HINTS) ===
      'prompt_echo',
    'the "·" exists only in the augmented label text, so it can only have come from the prompt'
  );
  check(
    'the theater list read back is an echo',
    gate('Emagine Royal Oak, Bel Air Luxury Cinema, MJR Troy Grand Digital Cinema 16.', 2000, 'en', THEATER_HINTS) ===
      'prompt_echo'
  );

  // Naming one option is how a choice is made out loud. Every one of these must
  // survive: a false reject is silent, and nothing on screen would explain it.
  check('a single film title passes', gate('Street Fighter?', 2092, 'en', MOVIE_HINTS) === null);
  check(
    'a single theater name passes',
    gate('The Bel Air Luxury Cinema.', 2956, 'en', THEATER_HINTS) === null
  );
  check('a spoken date passes', gate('Thursday is November 5th.', 3628, 'en', DATE_HINTS) === null);
  check(
    'a single seat passes, though seat hints are two characters long',
    gate('Seat E9.', 4684, 'en', SEAT_HINTS) === null
  );
  check(
    'two short seat labels together are not an echo',
    gate('E9 and F9.', 3000, 'en', SEAT_HINTS) === null,
    'two one-word labels can be a real request; the echo rule needs three, or two multi-word ones'
  );
  check('a filler-heavy confirmation passes', gate('Yes, yes, yes, please.', 2572, 'en', TIME_HINTS) === null);
  check(
    'a stated preference passes',
    gate('I want only 3D options that end before 10 p.m.', 5676, 'en', TIME_HINTS) === null
  );
  check(
    'a Korean utterance over the movie list passes',
    gate('어 액션 영화 보고 싶어.', 2400, 'ko', MOVIE_HINTS) === null
  );
  check(
    'with no hints there is nothing to echo',
    gate('Street Fighter, Clayface.', 4000, 'en', []) === null
  );
}

// -----------------------------------------------------------------------------
section('5. more characters than the audio could have carried');
// -----------------------------------------------------------------------------
{
  // Independent of the hint list: the same regurgitation with no hints to match
  // is still 50 characters a second.
  check(
    'the theater list is implausibly fast even unmatched',
    gate('Emagine Royal Oak, Bel Air Luxury Cinema, MJR Troy Grand Digital Cinema 16.', 1500, 'en', []) ===
      'implausible_rate',
    '75 chars in 1.5 s'
  );
  check(
    'the movie list is implausibly fast even unmatched',
    gate(
      'The Legend of Aang: The Last Airbender, Street Fighter, Clayface, Wildwood, Klara and the Sun.',
      1388,
      'en',
      []
    ) === 'implausible_rate',
    '67.7 chars/s'
  );
  check(
    'genuine English speech is well under the ceiling',
    gate('I want only 3D options that end before 10 p.m.', 5676, 'en') === null,
    '8.1 chars/s'
  );
  check(
    'a short burst never trips the rate rule',
    gate('Yes, yes, yes, please.', 2572, 'en') === null
  );
  check(
    'Korean gets a tighter ceiling',
    gate('3D로 예매하고 싶은데 저녁 시간대로 부탁드려요.', 1200, 'ko') === 'implausible_rate'
  );
  check(
    'the same Korean sentence spoken at a human pace passes',
    gate('3D로 예매하고 싶은데 저녁 시간대로 부탁드려요.', 4000, 'ko') === null
  );
  check(
    'an unknown duration never rejects anything',
    gate('Emagine Royal Oak, Bel Air Luxury Cinema, MJR Troy Grand Digital Cinema 16.', 0, 'en') === null,
    '0 means the source never measured the clip'
  );
}

// -----------------------------------------------------------------------------
section('6. the seat stage names its rows');
// -----------------------------------------------------------------------------
{
  // A Korean session tried four times to pick row E and got back "이 열로 해 줘",
  // "주열로 해줘" — the letter transcribed as the Hangul syllable it sounds like.
  const koSeatPrompt = buildTranscriptionPrompt('ko', 'seat', 'E9, F9');
  check('the Korean seat prompt asks for a bare row', koSeatPrompt.includes('E열'));
  check(
    'the Korean seat prompt forbids writing the row as a Korean syllable',
    koSeatPrompt.includes('이') && koSeatPrompt.includes('Latin capital letter')
  );
  check('the English seat prompt mentions a bare row', buildTranscriptionPrompt('en', 'seat', 'E9').includes('row E'));

  const seatValues = ['E9 - Standard - $14.00', 'E10 - Standard - $14.00', 'F9 - Standard - $14.00'];
  const limits = { maxOptions: 15, maxTextLength: 300 };
  const enSeatHints = collectStageHintLabels('en', 'seat', seatValues, limits);
  const koSeatHints = collectStageHintLabels('ko', 'seat', seatValues, limits);
  check(
    'the English seat hints lead with the rows on screen',
    enSeatHints[0] === 'row E' && enSeatHints[1] === 'row F' && enSeatHints.includes('E9')
  );
  check(
    'the Korean seat hints lead with the rows on screen',
    koSeatHints[0] === 'E열' && koSeatHints[1] === 'F열' && koSeatHints.includes('E9')
  );
  check(
    'the seat labels still drop their tier and price',
    enSeatHints.every((hint) => !hint.includes('$'))
  );
  check(
    'rows survive the hint caps',
    collectStageHintLabels(
      'en',
      'seat',
      Array.from({ length: 40 }, (_, index) => `A${index + 1} - Standard - $14.00`),
      { maxOptions: 4, maxTextLength: 300 }
    )[0] === 'row A'
  );
  check(
    'other stages are untouched by the row rule',
    collectStageHintLabels('en', 'movie', ['Street Fighter', 'Clayface'], limits).join(', ') ===
      'Street Fighter, Clayface'
  );
}

console.log(failures === 0 ? '\nall language checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
