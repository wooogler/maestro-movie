/**
 * What reaches the agent from the microphone, per language.
 *
 * Two language-dependent things live here: the prompt that steers the
 * transcription model, and the gate that decides a transcript was noise rather
 * than speech. Both were English-only and one of them, the script guard, made
 * Korean structurally impossible — a Hangul transcript was discarded outright.
 *
 * Pure functions with no React or spec imports, so the gate can be exercised
 * directly by `voiceInput.check.ts`.
 */

import { languagePack, type Language } from './language';

export type IgnoredTranscriptReason =
  /** English session, Hangul transcript — kept as the original id so the study log vocabulary is unchanged. */
  | 'non_english'
  /** The transcriber handed back the option labels from its own prompt, not speech. */
  | 'prompt_echo'
  /** More characters than the measured audio could have carried at any human speaking rate. */
  | 'implausible_rate'
  | 'filler_only'
  | 'too_short'
  /** A phrase the transcriber is known to invent from silence ("ご視聴ありがとうございました"). */
  | 'known_hallucination';

/**
 * Whisper-family models emit a plausible-looking phrase when handed silence or
 * room noise, and in the English study that hallucination frequently came back
 * as Hangul — so an unexpected script was a usable noise signal.
 *
 * There is no mirror of this for Korean, and it would be wrong to invent one:
 * naming a film out loud ("Street Fighter", "Klara and the Sun") is an entirely
 * ordinary Korean-session utterance with no Hangul in it. A guard cannot tell
 * that from a hallucination, and a false reject is silent — the visitor speaks,
 * nothing happens, and nothing on screen explains why. So Korean sessions rely
 * on the filler and duration checks alone.
 */
function hasUnexpectedScript(text: string, language: Language): boolean {
  if (language !== 'en') return false;
  return /[ㄱ-ㆎ가-힣]/.test(text);
}

/**
 * English and Korean keep the exact character class the recorded study gated
 * with. Widening it to every letter would let a kana or Han hallucination in an
 * English session — "ご視聴ありがとうございました" is the classic one — survive
 * as a token where it used to empty to `too_short`. Every other language needs
 * its own letters to survive, accents and kana and Han included, so it gets
 * Unicode letters and digits.
 */
function usesLegacyTokenClass(language: Language): boolean {
  return language === 'en' || language === 'ko';
}

const LEGACY_EDGE = /^[^a-z0-9ㄱ-ㆎ가-힣]+|[^a-z0-9ㄱ-ㆎ가-힣]+$/gi;
const UNICODE_EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const LEGACY_NON_TOKEN = /[^a-z0-9ㄱ-ㆎ가-힣]+/g;
const UNICODE_NON_TOKEN = /[^\p{L}\p{N}]+/gu;

export function normalizeVoiceTranscriptToken(token: string, language: Language = 'en'): string {
  return token
    .toLowerCase()
    .replace(usesLegacyTokenClass(language) ? LEGACY_EDGE : UNICODE_EDGE, '')
    .trim();
}

type WordSegmenter = { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> };
const segmenters = new Map<string, WordSegmenter | null>();

function getWordSegmenter(locale: string): WordSegmenter | null {
  if (!segmenters.has(locale)) {
    const Segmenter = (Intl as unknown as {
      Segmenter?: new (locale: string, options: { granularity: 'word' }) => WordSegmenter;
    }).Segmenter;
    segmenters.set(locale, Segmenter ? new Segmenter(locale, { granularity: 'word' }) : null);
  }
  return segmenters.get(locale) ?? null;
}

/**
 * Words, for a script written without spaces. `Intl.Segmenter` knows where a
 * Japanese or Chinese word ends; without it (an old browser) each run of
 * letters between punctuation becomes one token, which errs toward fewer,
 * longer tokens — the direction that keeps speech.
 */
export function segmentWords(text: string, language: Language): string[] {
  const pack = languagePack(language);
  const segmenter = getWordSegmenter(pack.locale);
  if (!segmenter) return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words: string[] = [];
  for (const part of segmenter.segment(text)) {
    if (part.isWordLike) words.push(part.segment);
  }
  return words;
}

function splitTranscriptWords(text: string, language: Language): string[] {
  return languagePack(language).usesSpaces ? text.split(/\s+/) : segmentWords(text, language);
}

export function getNormalizedVoiceTranscriptTokens(text: string, language: Language = 'en'): string[] {
  return splitTranscriptWords(text, language)
    .map((token) => normalizeVoiceTranscriptToken(token, language))
    .filter(Boolean);
}

const EN_FILLER_PATTERNS: readonly RegExp[] = [
  /^u+h+$/,
  /^u+m+$/,
  /^e+r+m+$/,
  /^h+m+$/,
  /^m+m+$/,
  /^a+h+$/,
];

/**
 * Deliberately short. `그` ("that") and `저기` ("over there") are common
 * hesitation noises but both can also be a real reference to something on
 * screen, and dropping a real reference costs more than passing a filler
 * through to the planner.
 */
const KO_FILLER_PATTERNS: readonly RegExp[] = [/^으*음+$/, /^어+$/, /^아+$/, /^에+$/, /^흠+$/];

/**
 * Japanese hesitations. `うん` and `ええ` are left out on purpose: both are a
 * plain "yes". Bare `あの` / `その` are left out for the reason `그` is left out
 * of the Korean list — they can point at something on screen.
 */
const JA_FILLER_PATTERNS: readonly RegExp[] = [
  /^え[ーぇ]+$/,
  /^あ[ーぁ]+$/,
  /^ん[ーん]*$/,
  /^う[ー]+ん?$/,
  /^えー?っ?と[ー]*$/,
  /^あの[ー]+$/,
  /^その[ー]+$/,
];

/**
 * `那个` is a hesitation and a real "that one" alike, and `嗯` is as often a
 * "mm-hm, yes" as a pause, so neither is here.
 */
const ZH_FILLER_PATTERNS: readonly RegExp[] = [/^[呃额額唔啊]+$/];

const DE_FILLER_PATTERNS: readonly RegExp[] = [/^ä+h+m*$/, /^ö+h+m*$/, /^h+m+$/, /^m+h*m+$/];
const FR_FILLER_PATTERNS: readonly RegExp[] = [/^e+u+h+$/, /^h+m+$/, /^b+a+h+$/, /^m+h*m+$/];
const ES_FILLER_PATTERNS: readonly RegExp[] = [/^e+h+$/, /^e+m+$/, /^h+m+$/, /^m+h*m+$/];

const FILLER_PATTERNS: Record<Language, readonly RegExp[]> = {
  en: EN_FILLER_PATTERNS,
  ko: KO_FILLER_PATTERNS,
  ja: JA_FILLER_PATTERNS,
  'zh-Hans': ZH_FILLER_PATTERNS,
  'zh-Hant': ZH_FILLER_PATTERNS,
  de: DE_FILLER_PATTERNS,
  fr: FR_FILLER_PATTERNS,
  es: ES_FILLER_PATTERNS,
};

const ZH_MEANINGFUL_SHORT_TOKENS = new Set([
  '好', '是', '对', '對', '行', '要', '不', '嗯', '嗯嗯',
  '不要', '不是', '可以', '好的', '对的', '對的',
  '这个', '這個', '那个', '那個', '这', '這', '那',
  '下一步', '返回', '确认', '確認', 'ok',
]);

/**
 * Short words that survive the too-brief-to-be-speech check. Korean carries a
 * whole answer in one or two syllables far more often than English does, so
 * this list does more work in `ko` than its English counterpart — and more
 * still in Japanese and Chinese, where one or two characters is an ordinary
 * answer.
 */
const MEANINGFUL_SHORT_TOKENS: Record<Language, ReadonlySet<string>> = {
  en: new Set(['no', 'ok']),
  ko: new Set([
    '네', '넵', '예', '응', '웅',
    '아니', '아뇨', '싫어',
    '그거', '저거', '이거', '그건',
    '다음', '이전', '뒤로', '확인', '좋아', '맞아',
  ]),
  ja: new Set([
    'はい', 'いいえ', 'うん', 'ええ', 'いや', '違う',
    'それ', 'これ', 'あれ', 'そう', '次', '前', '戻る', '戻って',
    'ok',
  ]),
  'zh-Hans': ZH_MEANINGFUL_SHORT_TOKENS,
  'zh-Hant': ZH_MEANINGFUL_SHORT_TOKENS,
  de: new Set(['ja', 'nein', 'ok', 'jo']),
  fr: new Set(['oui', 'non', 'ok', 'ça']),
  es: new Set(['sí', 'si', 'no', 'ok', 'ya']),
};

export function isLikelyFillerToken(token: string, language: Language): boolean {
  if (!token) return false;
  return FILLER_PATTERNS[language].some((pattern) => pattern.test(token));
}

/**
 * The transcription prompt lists the labels on screen so the model biases
 * toward them. Handed silence or room noise, it reads that list back as if the
 * visitor had said it — real traces show a 1388 ms clip returning all five film
 * titles, and a 1292 ms clip returning four showtimes complete with the "·"
 * separator that only exists in the augmented label text. The planner then acts
 * on a GUI the visitor never spoke to.
 *
 * Punctuation carries no signal here, so both sides collapse to bare tokens:
 * "12:40 PM · 3D" and "Klara and the Sun." both become word runs.
 */
function getEchoTokens(text: string, language: Language): string[] {
  const lower = text.toLowerCase();
  if (usesLegacyTokenClass(language)) {
    return lower.replace(LEGACY_NON_TOKEN, ' ').trim().split(/\s+/).filter(Boolean);
  }
  const spaced = lower.replace(UNICODE_NON_TOKEN, ' ').trim();
  if (!spaced) return [];
  return languagePack(language).usesSpaces
    ? spaced.split(/\s+/).filter(Boolean)
    : segmentWords(spaced, language);
}

/** Removes every occurrence of one label's token run, longest labels first. */
function stripHintOccurrences(
  tokens: readonly string[],
  hintTokens: readonly string[]
): { rest: string[]; matched: boolean } {
  const rest: string[] = [];
  let matched = false;
  let index = 0;
  while (index < tokens.length) {
    const isHit = hintTokens.every((token, offset) => tokens[index + offset] === token);
    if (isHit) {
      matched = true;
      index += hintTokens.length;
      continue;
    }
    rest.push(tokens[index]);
    index += 1;
  }
  return { rest, matched };
}

/** Non-hint words this many or more mean the visitor said something of their own. */
const ECHO_MAX_RESIDUAL_TOKENS = 3;

/**
 * Above this, an utterance is faster than a human mouth — the transcriber
 * padded it. Genuine speech in the traces ran 2–10 chars/s in English; the
 * echoes ran 44 and 68. Korean packs far more meaning into a character, and its
 * real utterances sat well under 10 chars/s, so it gets a tighter ceiling.
 */
const MAX_PLAUSIBLE_CHARS_PER_SECOND: Record<Language, number> = {
  en: 25,
  ko: 15,
  // UNMEASURED. Japanese and Chinese carry more per character than Korean, so
  // they start tighter; re-derive from real booth traces before trusting them.
  ja: 10,
  'zh-Hans': 10,
  'zh-Hant': 10,
  // Alphabetic and spaced like English, so English's ceiling. Also unmeasured.
  de: 25,
  fr: 25,
  es: 25,
};

/**
 * A short transcript can clear any rate by accident — "Sure." inside a clipped
 * 200 ms window is 25 chars/s and entirely real.
 */
const RATE_CHECK_MIN_CHARS = 20;

/**
 * The rate below which a single long label is credible as a genuine choice.
 * Only used to protect the one-label echo rule from eating a real answer.
 */
const ECHO_SINGLE_LABEL_MIN_CHARS_PER_SECOND: Record<Language, number> = {
  en: 15,
  ko: 9,
  // UNMEASURED, like the ceilings above.
  ja: 6,
  'zh-Hans': 6,
  'zh-Hant': 6,
  de: 15,
  fr: 15,
  es: 15,
};

function getCharsPerSecond(text: string, durationMs: number): number | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return (text.length * 1000) / durationMs;
}

/**
 * True when the transcript is the prompt's own option list coming back.
 *
 * The thresholds lean toward letting speech through, because a false reject is
 * silent — the visitor speaks, nothing happens, and nothing on screen says why:
 *
 *  - three or more distinct labels is the shape every observed echo had;
 *  - exactly two only counts when both labels are multi-word, so a seat stage
 *    where the hints are "E9" and "F9" cannot turn "E9 and F9" into an echo;
 *  - one label only counts when it is four words or longer, is the entire
 *    transcript, and arrived faster than that many characters can be spoken —
 *    without the rate guard this rule would swallow someone simply saying
 *    "Klara and the Sun."
 */
function isPromptEcho(
  text: string,
  durationMs: number,
  hintLabels: readonly string[],
  language: Language
): boolean {
  if (hintLabels.length === 0) return false;

  const transcriptTokens = getEchoTokens(text, language);
  if (transcriptTokens.length === 0) return false;

  const hints = hintLabels
    .map((label) => getEchoTokens(label, language))
    .filter((tokens) => tokens.length > 0)
    .sort((a, b) => b.length - a.length);
  if (hints.length === 0) return false;

  let rest: string[] = [...transcriptTokens];
  const matchedHints: string[][] = [];
  for (const hintTokens of hints) {
    const stripped = stripHintOccurrences(rest, hintTokens);
    if (!stripped.matched) continue;
    matchedHints.push(hintTokens);
    rest = stripped.rest;
  }

  if (matchedHints.length === 0) return false;
  if (rest.length >= ECHO_MAX_RESIDUAL_TOKENS) return false;

  if (matchedHints.length >= 3) return true;
  if (matchedHints.length === 2) {
    return matchedHints.every((hintTokens) => hintTokens.length >= 2);
  }

  const [only] = matchedHints;
  if (only.length < 4 || rest.length > 0) return false;
  const charsPerSecond = getCharsPerSecond(text, durationMs);
  return charsPerSecond !== null && charsPerSecond > ECHO_SINGLE_LABEL_MIN_CHARS_PER_SECOND[language];
}

/**
 * `durationMs` of 0 means the source never measured the clip, not that the clip
 * was instantaneous — an unknown duration must never reject anything.
 */
function hasImplausibleRate(text: string, durationMs: number, language: Language): boolean {
  if (text.length < RATE_CHECK_MIN_CHARS) return false;
  const charsPerSecond = getCharsPerSecond(text, durationMs);
  if (charsPerSecond === null) return false;
  return charsPerSecond > MAX_PLAUSIBLE_CHARS_PER_SECOND[language];
}

/**
 * What the transcriber writes when handed silence, per language. These are
 * captions from the video subtitles the model was trained on — "thanks for
 * watching", "subscribe to the channel", a subtitling credit — and none of them
 * is something a visitor says to a booking kiosk.
 *
 * Matched after stripping case, spaces and punctuation, anywhere in the
 * transcript. English and Korean have no list: their gate is unchanged from
 * the recorded study.
 */
const ZH_HALLUCINATIONS = [
  '字幕由Amara.org社区提供',
  '字幕由Amara.org社區提供',
  '谢谢观看',
  '謝謝觀看',
  '感谢观看',
  '感謝觀看',
  '请不吝点赞',
  '請不吝點贊',
  '明镜与点点栏目',
  '明鏡與點點欄目',
  '订阅我的频道',
  '訂閱我的頻道',
];

const KNOWN_HALLUCINATIONS: Partial<Record<Language, readonly string[]>> = {
  ja: [
    'ご視聴ありがとうございました',
    'ご視聴ありがとうございます',
    'チャンネル登録',
    '最後までご覧いただき',
    '字幕由Amara.org社区提供',
  ],
  'zh-Hans': ZH_HALLUCINATIONS,
  'zh-Hant': ZH_HALLUCINATIONS,
  de: ['Untertitel der Amara.org-Community', 'Untertitel im Auftrag des ZDF', 'Vielen Dank fürs Zuschauen'],
  fr: [
    "Sous-titres réalisés par la communauté d'Amara.org",
    'Merci d’avoir regardé cette vidéo',
  ],
  es: [
    'Subtítulos realizados por la comunidad de Amara.org',
    'Gracias por ver el video',
    'Suscríbete al canal',
  ],
};

function compactForHallucination(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function isKnownHallucination(text: string, language: Language): boolean {
  const phrases = KNOWN_HALLUCINATIONS[language];
  if (!phrases?.length) return false;
  const compact = compactForHallucination(text);
  if (!compact) return false;
  return phrases.some((phrase) => compact.includes(compactForHallucination(phrase)));
}

export interface TranscriptGateOptions {
  language: Language;
  /** Audio spans at or under this are treated as too brief to be a word. */
  shortInputMaxDurationMs: number;
  shortInputMaxChars: number;
  /**
   * The option labels currently fed to the transcription prompt — the same list
   * `buildTranscriptionPrompt` formats. Without them the echo check is inert.
   */
  hintLabels?: readonly string[];
}

export function getIgnoredVoiceTranscriptReason(
  text: string,
  durationMs: number,
  options: TranscriptGateOptions
): IgnoredTranscriptReason | null {
  const { language, shortInputMaxDurationMs, shortInputMaxChars, hintLabels = [] } = options;

  if (hasUnexpectedScript(text, language)) return 'non_english';
  if (isKnownHallucination(text, language)) return 'known_hallucination';

  // Both of these describe a transcript that no one spoke, so they run before
  // the filler and duration rules, which describe speech that carried nothing.
  if (isPromptEcho(text, durationMs, hintLabels, language)) return 'prompt_echo';
  if (hasImplausibleRate(text, durationMs, language)) return 'implausible_rate';

  const tokens = getNormalizedVoiceTranscriptTokens(text, language);
  if (tokens.length === 0) return 'too_short';
  if (tokens.every((token) => isLikelyFillerToken(token, language))) return 'filler_only';

  if (
    durationMs <= shortInputMaxDurationMs &&
    tokens.length === 1 &&
    tokens[0].length <= shortInputMaxChars &&
    !MEANINGFUL_SHORT_TOKENS[language].has(tokens[0])
  ) {
    return 'too_short';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Transcription prompt
// ---------------------------------------------------------------------------

const TRANSCRIPTION_BASE: Record<Language, string> = {
  en:
    'Transcribe only what is actually spoken. Do not add words that are not in the audio. ' +
    'If the audio contains only silence, background noise, or unintelligible sounds, respond with an empty string. ' +
    'If the speech is unclear, transcribe the closest recognizable words only. ' +
    'The user may reply with short conversational responses like "yes", "no", "sure", "go back", "that one", or "sounds good" — ' +
    'transcribe these as-is without forcing a match to the options below.',
  ko:
    'The user is speaking Korean. Transcribe in Korean, in Hangul. ' +
    'Film titles, cinema names and formats appear on screen in English and may be spoken in English — keep those in English. ' +
    'Transcribe only what is actually spoken. Do not add words that are not in the audio. ' +
    'If the audio contains only silence, background noise, or unintelligible sounds, respond with an empty string. ' +
    'If the speech is unclear, transcribe the closest recognizable words only. ' +
    'The user may reply with short conversational responses like "네", "아니요", "좋아요", "뒤로", "그거", or "그걸로 할게요" — ' +
    'transcribe these as-is without forcing a match to the options below.',
  ja:
    'The user is speaking Japanese. Transcribe in Japanese, with kanji and kana as they are normally written. ' +
    'Film titles, cinema names and formats appear on screen in English and may be spoken in English or in katakana — write those in English, as they appear on screen. ' +
    'Transcribe only what is actually spoken. Do not add words that are not in the audio. ' +
    'If the audio contains only silence, background noise, or unintelligible sounds, respond with an empty string. ' +
    'If the speech is unclear, transcribe the closest recognizable words only. ' +
    'The user may reply with short conversational responses like "はい", "いいえ", "それで", "戻って", "それにします", or "お願いします" — ' +
    'transcribe these as-is without forcing a match to the options below.',
  'zh-Hans':
    'The user is speaking Mandarin Chinese. Transcribe in Chinese, in Simplified Chinese characters. ' +
    'Film titles, cinema names and formats appear on screen in English and may be spoken in English — keep those in English. ' +
    'Transcribe only what is actually spoken. Do not add words that are not in the audio. ' +
    'If the audio contains only silence, background noise, or unintelligible sounds, respond with an empty string. ' +
    'If the speech is unclear, transcribe the closest recognizable words only. ' +
    'The user may reply with short conversational responses like "好", "不要", "就这个", "返回", "下一步", or "可以" — ' +
    'transcribe these as-is without forcing a match to the options below.',
  'zh-Hant':
    'The user is speaking Mandarin Chinese. Transcribe in Chinese, in Traditional Chinese characters. ' +
    'Film titles, cinema names and formats appear on screen in English and may be spoken in English — keep those in English. ' +
    'Transcribe only what is actually spoken. Do not add words that are not in the audio. ' +
    'If the audio contains only silence, background noise, or unintelligible sounds, respond with an empty string. ' +
    'If the speech is unclear, transcribe the closest recognizable words only. ' +
    'The user may reply with short conversational responses like "好", "不要", "就這個", "返回", "下一步", or "可以" — ' +
    'transcribe these as-is without forcing a match to the options below.',
  de:
    'The user is speaking German. Transcribe in German. ' +
    'Film titles, cinema names and formats appear on screen in English and may be spoken in English — keep those in English. ' +
    'Transcribe only what is actually spoken. Do not add words that are not in the audio. ' +
    'If the audio contains only silence, background noise, or unintelligible sounds, respond with an empty string. ' +
    'If the speech is unclear, transcribe the closest recognizable words only. ' +
    'The user may reply with short conversational responses like "ja", "nein", "genau", "zurück", "das da", or "passt" — ' +
    'transcribe these as-is without forcing a match to the options below.',
  fr:
    'The user is speaking French. Transcribe in French. ' +
    'Film titles, cinema names and formats appear on screen in English and may be spoken in English — keep those in English. ' +
    'Transcribe only what is actually spoken. Do not add words that are not in the audio. ' +
    'If the audio contains only silence, background noise, or unintelligible sounds, respond with an empty string. ' +
    'If the speech is unclear, transcribe the closest recognizable words only. ' +
    'The user may reply with short conversational responses like "oui", "non", "d’accord", "retour", "celui-là", or "ça marche" — ' +
    'transcribe these as-is without forcing a match to the options below.',
  es:
    'The user is speaking Spanish. Transcribe in Spanish. ' +
    'Film titles, cinema names and formats appear on screen in English and may be spoken in English — keep those in English. ' +
    'Transcribe only what is actually spoken. Do not add words that are not in the audio. ' +
    'If the audio contains only silence, background noise, or unintelligible sounds, respond with an empty string. ' +
    'If the speech is unclear, transcribe the closest recognizable words only. ' +
    'The user may reply with short conversational responses like "sí", "no", "vale", "atrás", "ese", or "me parece bien" — ' +
    'transcribe these as-is without forcing a match to the options below.',
};

/**
 * The row sentence is here because of a Korean session that could not pick row
 * E: the transcriber wrote the letter as the Hangul syllable it sounds like —
 * "이 열로 해 줘", "주열로 해줘" — and the planner had no row to map. A row is
 * also named on its own far more often than a full seat label is.
 */
const SEAT_INSTRUCTION: Record<Language, string> = {
  en:
    'The user is choosing a seat. Preserve letter-number labels like A1, B5, F6 exactly. ' +
    'The user may also name a row on its own, like "row E" or "E row" — ' +
    'always write the row letter as a Latin capital letter. Possible labels:',
  ko:
    'The user is choosing a seat, speaking Korean. Preserve letter-number labels like A1, B5, F6 exactly and in Latin script. ' +
    'The user may also name a row on its own, like "E열" or "row E" — ' +
    'always write the row letter as a Latin capital letter, never as a Korean syllable such as 이, 지 or 비. Possible labels:',
  ja:
    'The user is choosing a seat, speaking Japanese. Preserve letter-number labels like A1, B5, F6 exactly and in Latin script. ' +
    'The user may also name a row on its own, like "E列" or "row E" — ' +
    'always write the row letter as a Latin capital letter, never in katakana such as イー, ビー or エフ. Possible labels:',
  'zh-Hans':
    'The user is choosing a seat, speaking Mandarin Chinese. Preserve letter-number labels like A1, B5, F6 exactly and in Latin script. ' +
    'The user may also name a row on its own, like "E排" or "row E" — ' +
    'always write the row letter as a Latin capital letter, never as a Chinese character such as 伊 or 比. Possible labels:',
  'zh-Hant':
    'The user is choosing a seat, speaking Mandarin Chinese. Preserve letter-number labels like A1, B5, F6 exactly and in Latin script. ' +
    'The user may also name a row on its own, like "E排" or "row E" — ' +
    'always write the row letter as a Latin capital letter, never as a Chinese character such as 伊 or 比. Possible labels:',
  de:
    'The user is choosing a seat, speaking German. Preserve letter-number labels like A1, B5, F6 exactly. ' +
    'The user may also name a row on its own, like "Reihe E" or "row E" — ' +
    'always write the row letter as a Latin capital letter. Possible labels:',
  fr:
    'The user is choosing a seat, speaking French. Preserve letter-number labels like A1, B5, F6 exactly. ' +
    'The user may also name a row on its own, like "rang E" or "row E" — ' +
    'always write the row letter as a Latin capital letter. Possible labels:',
  es:
    'The user is choosing a seat, speaking Spanish. Preserve letter-number labels like A1, B5, F6 exactly. ' +
    'The user may also name a row on its own, like "fila E" or "row E" — ' +
    'always write the row letter as a Latin capital letter. Possible labels:',
};

/**
 * How a bare row reads to the transcriber in each language, so "E열" is a
 * listed possibility rather than something it has to invent.
 */
const SEAT_ROW_HINT: Record<Language, (row: string) => string> = {
  en: (row) => `row ${row}`,
  ko: (row) => `${row}열`,
  ja: (row) => `${row}列`,
  'zh-Hans': (row) => `${row}排`,
  'zh-Hant': (row) => `${row}排`,
  de: (row) => `Reihe ${row}`,
  fr: (row) => `rang ${row}`,
  es: (row) => `fila ${row}`,
};

export function formatSeatRowHint(language: Language, row: string): string {
  return (SEAT_ROW_HINT[language] ?? SEAT_ROW_HINT.en)(row);
}

const EN_STAGE_CONTEXT: Record<string, string> = {
  movie: 'The user is choosing a movie',
  theater: 'The user is choosing a theater',
  date: 'The user is choosing a date',
  time: 'The user is choosing a showtime',
  confirm: 'The user is confirming a booking',
};

/** The English stage sentence plus who is speaking, the way the Korean entry reads. */
function stageContextSpokenIn(spokenLanguage: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(EN_STAGE_CONTEXT).map(([stage, sentence]) => [stage, `${sentence}, speaking ${spokenLanguage}`])
  );
}

const STAGE_CONTEXT: Record<Language, Record<string, string>> = {
  en: EN_STAGE_CONTEXT,
  ko: {
    movie: 'The user is choosing a movie, speaking Korean',
    theater: 'The user is choosing a theater, speaking Korean',
    date: 'The user is choosing a date, speaking Korean',
    time: 'The user is choosing a showtime, speaking Korean',
    confirm: 'The user is confirming a booking, speaking Korean',
  },
  ja: stageContextSpokenIn('Japanese'),
  'zh-Hans': stageContextSpokenIn('Mandarin Chinese, written in Simplified Chinese characters'),
  'zh-Hant': stageContextSpokenIn('Mandarin Chinese, written in Traditional Chinese characters'),
  de: stageContextSpokenIn('German'),
  fr: stageContextSpokenIn('French'),
  es: stageContextSpokenIn('Spanish'),
};

const FALLBACK_CONTEXT: Record<Language, string> = {
  en: 'The user is choosing an option',
  ko: 'The user is choosing an option, speaking Korean',
  ja: 'The user is choosing an option, speaking Japanese',
  'zh-Hans': 'The user is choosing an option, speaking Mandarin Chinese, written in Simplified Chinese characters',
  'zh-Hant': 'The user is choosing an option, speaking Mandarin Chinese, written in Traditional Chinese characters',
  de: 'The user is choosing an option, speaking German',
  fr: 'The user is choosing an option, speaking French',
  es: 'The user is choosing an option, speaking Spanish',
};

const OPTIONS_LABEL = 'Possible options on screen:';

export interface StageHintLimits {
  maxOptions: number;
  maxTextLength: number;
}

/**
 * The labels handed to the transcriber, from the raw on-screen option values.
 *
 * Pure, and shared with the transcript gate: whatever the model was told the
 * options are is exactly what counts as it quoting the list back.
 *
 * The seat stage is the one that rewrites its input. "C1 - Standard - $14.00"
 * is not something anyone says, so it keeps only "C1" — and the row letters
 * present are listed in their own right, first, because a visitor picks a seat
 * by naming a row far more often than by reading a full label out.
 */
export function collectStageHintLabels(
  language: Language,
  stage: string,
  rawValues: readonly string[],
  limits: StageHintLimits
): string[] {
  const seatRows: string[] = [];
  const labels = Array.from(
    new Set(
      rawValues
        .map((rawValue) => {
          const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
          if (!raw) return null;
          if (stage !== 'seat') return raw;
          // "C1 - Standard - $14.00" → "C1"
          const label = raw.split(/\s*-\s*/)[0].trim();
          if (!label) return null;
          const row = /^([A-Za-z]+)\d+$/.exec(label)?.[1]?.toUpperCase();
          if (row && !seatRows.includes(row)) seatRows.push(row);
          return label;
        })
        .filter((entry): entry is string => Boolean(entry))
    )
  );

  // Rows lead so the caps below can never truncate them away.
  const ordered = [...seatRows.map((row) => formatSeatRowHint(language, row)), ...labels];

  const limited: string[] = [];
  let totalLength = 0;
  for (const hint of ordered.slice(0, limits.maxOptions)) {
    const nextLength = totalLength + hint.length + (limited.length > 0 ? 2 : 0);
    if (nextLength > limits.maxTextLength) break;
    limited.push(hint);
    totalLength = nextLength;
  }

  return limited;
}

/**
 * The prompt is written in English in every language: it instructs the
 * transcription model rather than addressing the user, and mixing the
 * instruction language with the target language is a known way to make these
 * models echo the prompt back as if it were speech.
 */
export function buildTranscriptionPrompt(
  language: Language,
  stage: string,
  hintList: string
): string {
  const base = TRANSCRIPTION_BASE[language] ?? TRANSCRIPTION_BASE.en;

  if (stage === 'seat') {
    return `${base} ${SEAT_INSTRUCTION[language] ?? SEAT_INSTRUCTION.en} ${hintList}.`;
  }

  const context =
    (STAGE_CONTEXT[language] ?? STAGE_CONTEXT.en)[stage] ?? FALLBACK_CONTEXT[language] ?? FALLBACK_CONTEXT.en;
  return `${base} ${context}. ${OPTIONS_LABEL} ${hintList}.`;
}
