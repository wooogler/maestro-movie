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
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_LABELS,
  LANGUAGE_PACKS,
  detectLanguage,
  languagePack,
  matchLanguageTag,
  parseLanguage,
  readLanguageFromUrl,
  stripLanguageFromUrl,
  STT_LOCALE,
  type Language,
} from './language';
import { UI_STRINGS, UI_STRING_OVERRIDES, stringsFor, type UiStrings } from './strings';
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
  language: Language,
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
  check('both languages define the same keys', keys.every((key) => key in UI_STRINGS.ko));
  // The visible strings, one leaf at a time. A record such as `agentStepLabels`
  // holds a phrase per tool, and asserting the record itself would turn it into
  // "[object Object]" — which contains no Hangul and is never equal to itself.
  // `weekdayShort` is an array, and `locale` is a BCP-47 tag rather than prose;
  // neither is asserted the way the visible strings are.
  const leaves = (table: UiStrings): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    for (const key of keys) {
      if (key === 'weekdayShort' || key === 'locale') continue;
      const value = table[key] as unknown;
      if (typeof value === 'string') out.push([key, value]);
      else if (value && typeof value === 'object') {
        for (const [sub, text] of Object.entries(value as Record<string, string>)) out.push([`${key}.${sub}`, text]);
      }
    }
    return out;
  };
  const en = new Map(leaves(UI_STRINGS.en));
  const ko = new Map(leaves(UI_STRINGS.ko));
  check(
    'both languages define the same nested keys',
    [...en.keys()].every((path) => ko.has(path)) && [...ko.keys()].every((path) => en.has(path))
  );
  check(
    // Catches a key that was copied across and never translated.
    'no Korean value was left as its English placeholder',
    [...en].every(([path, text]) => ko.get(path) !== text),
    [...en].filter(([path, text]) => ko.get(path) === text).map(([path]) => path).join(', ')
  );
  check(
    'every Korean string actually contains Hangul',
    [...ko.values()].every((text) => /[가-힣]/.test(text)),
    [...ko].filter(([, text]) => !/[가-힣]/.test(text)).map(([path]) => path).join(', ')
  );
  check(
    'each language names a locale for the formatted month heading',
    UI_STRINGS.en.locale === 'en-US' && UI_STRINGS.ko.locale === 'ko-KR'
  );
  check('both weekday rows have seven days', UI_STRINGS.en.weekdayShort.length === 7 && UI_STRINGS.ko.weekdayShort.length === 7);
  check('an unknown language falls back to English', stringsFor('xx' as Language) === UI_STRINGS.en);
  check('parseLanguage rejects anything unexpected', parseLanguage('xx') === 'en' && parseLanguage('ko') === 'ko');
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

// -----------------------------------------------------------------------------
section('7. the overlay languages: what is translated is in its own script');
// -----------------------------------------------------------------------------
{
  // Values that are legitimately the same as English in another language —
  // brand and format names, initialisms. A translated value equal to English
  // and NOT on this list is a placeholder that was copied rather than written.
  const COGNATES = new Set(['IMAX', 'OK', 'QR', 'MAESTRO', '3D', 'API']);
  const SCRIPT: Partial<Record<Language, { test: RegExp; name: string }>> = {
    ko: { test: /[가-힣]/, name: 'Hangul' },
    ja: { test: /[぀-ヿ一-鿿]/, name: 'kana or kanji' },
    'zh-Hans': { test: /[一-鿿]/, name: 'Han' },
    'zh-Hant': { test: /[一-鿿]/, name: 'Han' },
  };
  // Asserted through the override tables, never the merged ones: the merged
  // table is English wherever a translation has not been written yet, and that
  // fallback is intended — it is not a translation to grade.
  for (const language of LANGUAGES) {
    if (language === 'en' || language === 'ko') continue;
    const overrides = UI_STRING_OVERRIDES[language];
    check(`${language} has an override table`, overrides !== undefined);
    if (!overrides) continue;
    const prose = Object.entries(overrides).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0] !== 'locale'
    );
    const copied = prose.filter(
      ([key, text]) => text === (UI_STRINGS.en as unknown as Record<string, unknown>)[key] && !COGNATES.has(text)
    );
    check(`no ${language} override is a copy of the English`, copied.length === 0, copied.map(([key]) => key).join(', '));
    const script = SCRIPT[language];
    if (script) {
      const wrong = prose.filter(([, text]) => !COGNATES.has(text) && !script.test.test(text));
      check(`every ${language} override is written in ${script.name}`, wrong.length === 0, wrong.map(([key]) => key).join(', '));
      check(`${language} translates the first screen's start button`, typeof overrides.startDemo === 'string');
    }
    const merged = stringsFor(language);
    check(
      `${language} falls back to English for everything it has not translated`,
      (Object.keys(UI_STRINGS.en) as Array<keyof UiStrings>).every(
        (key) => key in overrides || key === 'agentStepLabels' || merged[key] === UI_STRINGS.en[key]
      )
    );
    if (overrides.weekdayShort) check(`${language} has seven weekdays`, overrides.weekdayShort.length === 7);
  }
  // Japanese and both Chinese packs are fully translated: every visible string,
  // every agent-step phrase. A key added to `UiStrings` later reads in English
  // there until it is written, and this is what says so.
  for (const language of ['ja', 'zh-Hans', 'zh-Hant'] as const) {
    const overrides = UI_STRING_OVERRIDES[language] ?? {};
    const missing = (Object.keys(UI_STRINGS.en) as Array<keyof UiStrings>).filter((key) => !(key in overrides));
    const missingSteps = Object.keys(UI_STRINGS.en.agentStepLabels).filter(
      (step) => !(step in (overrides.agentStepLabels ?? {}))
    );
    check(`${language} translates every UI string`, missing.length === 0, missing.join(', '));
    check(`${language} translates every agent-step phrase`, missingSteps.length === 0, missingSteps.join(', '));
    const steps = Object.entries(overrides.agentStepLabels ?? {});
    check(
      `${language} agent-step phrases are not English copies`,
      steps.every(([step, text]) => text !== UI_STRINGS.en.agentStepLabels[step as keyof UiStrings['agentStepLabels']])
    );
    // Every placeholder the English carries must survive translation, or the
    // number it stands for silently disappears from the screen.
    const placeholders = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort().join(',');
    const broken = (Object.keys(UI_STRINGS.en) as Array<keyof UiStrings>).filter((key) => {
      const en = UI_STRINGS.en[key];
      const translated = overrides[key];
      return typeof en === 'string' && typeof translated === 'string' && placeholders(en) !== placeholders(translated);
    });
    check(`${language} keeps every interpolation placeholder`, broken.length === 0, broken.join(', '));
  }
  check(
    'the voice-only packs translate nothing on screen yet, by design',
    ['de', 'fr', 'es'].every((language) => Object.keys(UI_STRING_OVERRIDES[language as Language] ?? {}).length === 0)
  );
  check(
    'each pack names its switch label in its own language',
    LANGUAGE_LABELS.ja === '日本語' &&
      LANGUAGE_LABELS['zh-Hans'] === '简体中文' &&
      LANGUAGE_LABELS['zh-Hant'] === '繁體中文' &&
      LANGUAGE_LABELS.de === 'Deutsch' &&
      LANGUAGE_LABELS.fr === 'Français' &&
      LANGUAGE_LABELS.es === 'Español'
  );
  check('every language has a pack', LANGUAGES.every((language) => LANGUAGE_PACKS[language]?.code === language));
  check(
    'both Chinese packs transcribe as zh; the others by their own code',
    STT_LOCALE['zh-Hans'] === 'zh' && STT_LOCALE['zh-Hant'] === 'zh' && STT_LOCALE.ja === 'ja' && STT_LOCALE.de === 'de'
  );
  check(
    'only Japanese and Chinese are written without spaces',
    LANGUAGES.filter((language) => !languagePack(language).usesSpaces).join(',') === 'ja,zh-Hans,zh-Hant'
  );
  check('an unknown code reads as the English pack', languagePack('xx').code === 'en');
}

// -----------------------------------------------------------------------------
section('8. the transcript gate in the new languages');
// -----------------------------------------------------------------------------
{
  check(
    'a Japanese answer with no spaces is several tokens, not one too-short word',
    gate('はい、お願いします', 250, 'ja') === null
  );
  check('a one-word Japanese yes survives the too-short rule', gate('はい', 200, 'ja') === null);
  check('a Japanese hesitation is a filler', gate('えーと', 600, 'ja') === 'filler_only');
  check('うん is a yes in Japanese, not a filler', gate('うん', 200, 'ja') === null);
  check('a one-character Chinese yes survives', gate('好', 200, 'zh-Hans') === null && gate('對', 200, 'zh-Hant') === null);
  check('a Chinese hesitation is a filler', gate('呃', 400, 'zh-Hans') === 'filler_only');
  check(
    'the classic Japanese silence hallucination is rejected',
    gate('ご視聴ありがとうございました', 1500, 'ja') === 'known_hallucination'
  );
  check(
    'the subtitling credit is rejected in both Chinese packs',
    gate('字幕由Amara.org社区提供', 1500, 'zh-Hans') === 'known_hallucination' &&
      gate('字幕由Amara.org社区提供', 1500, 'zh-Hant') === 'known_hallucination'
  );
  check(
    'an English film title still passes in a Japanese session',
    gate('Street Fighter', 900, 'ja') === null
  );
  check(
    'a Japanese sentence naming a film passes over the movie list',
    gate('Street Fighterをお願いします', 2400, 'ja', MOVIE_HINTS) === null
  );
  check(
    'the movie list read back is still an echo in Japanese',
    gate(
      'The Legend of Aang: The Last Airbender、Street Fighter、Clayface、Wildwood、Klara and the Sun。',
      1388,
      'ja',
      MOVIE_HINTS
    ) === 'prompt_echo'
  );
  check(
    'Japanese gets a tighter rate ceiling than Korean',
    gate('土曜日の夜に三人で見られる映画を探しています', 1200, 'ja') === 'implausible_rate' &&
      gate('土曜日の夜に三人で見られる映画を探しています', 4000, 'ja') === null
  );
  check('German yes survives, German hesitation does not', gate('ja', 200, 'de') === null && gate('äh', 400, 'de') === 'filler_only');
  check('French yes survives, French hesitation does not', gate('oui', 200, 'fr') === null && gate('euh', 400, 'fr') === 'filler_only');
  check('Spanish yes survives, Spanish hesitation does not', gate('sí', 200, 'es') === null && gate('eh', 400, 'es') === 'filler_only');
  check('an accented French word is a word', gate('Ça marche, merci.', 1500, 'fr') === null);
  check(
    'English still rejects Hangul and still empties kana to too_short, as in the study',
    gate('네 좋아요', 900, 'en') === 'non_english' && gate('ご視聴ありがとうございました', 1500, 'en') === 'too_short'
  );
}

// -----------------------------------------------------------------------------
section('9. the transcription prompt in the new languages');
// -----------------------------------------------------------------------------
{
  const zhHans = buildTranscriptionPrompt('zh-Hans', 'movie', 'Street Fighter');
  const zhHant = buildTranscriptionPrompt('zh-Hant', 'movie', 'Street Fighter');
  check('Simplified Chinese asks for Simplified characters', zhHans.includes('Simplified Chinese characters') && !zhHans.includes('Traditional'));
  check('Traditional Chinese asks for Traditional characters', zhHant.includes('Traditional Chinese characters') && !zhHant.includes('Simplified'));
  check('the Japanese prompt says Japanese', buildTranscriptionPrompt('ja', 'movie', 'x').includes('speaking Japanese'));
  check(
    'every prompt ends with the options it was given',
    LANGUAGES.every((language) => buildTranscriptionPrompt(language, 'theater', 'A, B').endsWith('Possible options on screen: A, B.'))
  );
  check(
    'every seat prompt asks for the row letter in Latin capitals',
    LANGUAGES.every((language) => buildTranscriptionPrompt(language, 'seat', 'E9').includes('Latin capital letter'))
  );
  const seatValues = ['E9 - Standard - $14.00', 'F9 - Standard - $14.00'];
  const limits = { maxOptions: 15, maxTextLength: 300 };
  check('the Japanese row hint is E列', collectStageHintLabels('ja', 'seat', seatValues, limits)[0] === 'E列');
  check('the Chinese row hint is E排', collectStageHintLabels('zh-Hant', 'seat', seatValues, limits)[0] === 'E排');
  check('the Spanish row hint is fila E', collectStageHintLabels('es', 'seat', seatValues, limits)[0] === 'fila E');
}

// -----------------------------------------------------------------------------
section('10. picking a language from the browser and the URL');
// -----------------------------------------------------------------------------
{
  check('ja-JP is Japanese', detectLanguage(['ja-JP', 'en-US']) === 'ja');
  check('zh-TW is Traditional', detectLanguage(['zh-TW']) === 'zh-Hant');
  check('zh-HK is Traditional', detectLanguage(['zh-HK']) === 'zh-Hant');
  check('zh-Hant-US is Traditional', detectLanguage(['zh-Hant-US']) === 'zh-Hant');
  check('zh-CN is Simplified', detectLanguage(['zh-CN']) === 'zh-Hans');
  check('bare zh is Simplified', detectLanguage(['zh']) === 'zh-Hans');
  check('ko-KR is Korean', detectLanguage(['ko-KR']) === 'ko');
  check('de-AT, fr-CA, es-MX map to their packs', detectLanguage(['de-AT']) === 'de' && detectLanguage(['fr-CA']) === 'fr' && detectLanguage(['es-MX']) === 'es');
  check('the first supported preference wins', detectLanguage(['pt-BR', 'en-GB', 'ja']) === 'en');
  check('nothing supported is English', detectLanguage(['pt-BR', 'it']) === 'en' && detectLanguage([]) === 'en');
  check('a garbage tag matches nothing', matchLanguageTag('xx') === null && matchLanguageTag('') === null && matchLanguageTag(null) === null);

  check('?lang=ja is read', readLanguageFromUrl('?lang=ja', '') === 'ja');
  check('?lang=zh-Hant is read', readLanguageFromUrl('?foo=1&lang=zh-Hant', '') === 'zh-Hant');
  check('a card fragment carries lang next to its code', readLanguageFromUrl('', '#c=seat&k=ABC123&lang=ja') === 'ja');
  check('an unknown lang is ignored', readLanguageFromUrl('?lang=xx', '') === null);
  check('a fragment with no lang is ignored', readLanguageFromUrl('', '#c=seat&k=ABC123') === null);
  check(
    'stripping lang keeps every other parameter',
    stripLanguageFromUrl('/demo/card', '', '#c=seat&k=ABC123&lang=ja') === '/demo/card#c=seat&k=ABC123' &&
      stripLanguageFromUrl('/', '?lang=ja&x=1', '') === '/?x=1' &&
      stripLanguageFromUrl('/', '?lang=ja', '') === '/'
  );
  check('a URL with no lang is left alone', stripLanguageFromUrl('/demo', '?x=1', '#a') === null);
  check(
    '<html lang> is a BCP-47 tag',
    languagePack('zh-Hant').htmlLang === 'zh-Hant' && languagePack('en').htmlLang === 'en' && languagePack('ko').htmlLang === 'ko'
  );
}

console.log(failures === 0 ? '\nall language checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
