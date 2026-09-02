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

import type { Language } from './language';

export type IgnoredTranscriptReason =
  /** English session, Hangul transcript — kept as the original id so the study log vocabulary is unchanged. */
  | 'non_english'
  /** The transcriber handed back the option labels from its own prompt, not speech. */
  | 'prompt_echo'
  /** More characters than the measured audio could have carried at any human speaking rate. */
  | 'implausible_rate'
  | 'filler_only'
  | 'too_short';

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

export function normalizeVoiceTranscriptToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^a-z0-9ㄱ-ㆎ가-힣]+|[^a-z0-9ㄱ-ㆎ가-힣]+$/gi, '')
    .trim();
}

export function getNormalizedVoiceTranscriptTokens(text: string): string[] {
  return text.split(/\s+/).map(normalizeVoiceTranscriptToken).filter(Boolean);
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

const FILLER_PATTERNS: Record<Language, readonly RegExp[]> = {
  en: EN_FILLER_PATTERNS,
  ko: KO_FILLER_PATTERNS,
};

/**
 * Short words that survive the too-brief-to-be-speech check. Korean carries a
 * whole answer in one or two syllables far more often than English does, so
 * this list does more work in `ko` than its English counterpart.
 */
const MEANINGFUL_SHORT_TOKENS: Record<Language, ReadonlySet<string>> = {
  en: new Set(['no', 'ok']),
  ko: new Set([
    '네', '넵', '예', '응', '웅',
    '아니', '아뇨', '싫어',
    '그거', '저거', '이거', '그건',
    '다음', '이전', '뒤로', '확인', '좋아', '맞아',
  ]),
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
function getEchoTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9ㄱ-ㆎ가-힣]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
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

  const transcriptTokens = getEchoTokens(text);
  if (transcriptTokens.length === 0) return false;

  const hints = hintLabels
    .map((label) => getEchoTokens(label))
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

  // Both of these describe a transcript that no one spoke, so they run before
  // the filler and duration rules, which describe speech that carried nothing.
  if (isPromptEcho(text, durationMs, hintLabels, language)) return 'prompt_echo';
  if (hasImplausibleRate(text, durationMs, language)) return 'implausible_rate';

  const tokens = getNormalizedVoiceTranscriptTokens(text);
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
};

/**
 * How a bare row reads to the transcriber in each language, so "E열" is a
 * listed possibility rather than something it has to invent.
 */
export function formatSeatRowHint(language: Language, row: string): string {
  return language === 'ko' ? `${row}열` : `row ${row}`;
}

const STAGE_CONTEXT: Record<Language, Record<string, string>> = {
  en: {
    movie: 'The user is choosing a movie',
    theater: 'The user is choosing a theater',
    date: 'The user is choosing a date',
    time: 'The user is choosing a showtime',
    confirm: 'The user is confirming a booking',
  },
  ko: {
    movie: 'The user is choosing a movie, speaking Korean',
    theater: 'The user is choosing a theater, speaking Korean',
    date: 'The user is choosing a date, speaking Korean',
    time: 'The user is choosing a showtime, speaking Korean',
    confirm: 'The user is confirming a booking, speaking Korean',
  },
};

const FALLBACK_CONTEXT: Record<Language, string> = {
  en: 'The user is choosing an option',
  ko: 'The user is choosing an option, speaking Korean',
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
 * The prompt is written in English in both cases: it instructs the
 * transcription model rather than addressing the user, and mixing the
 * instruction language with the target language is a known way to make these
 * models echo the prompt back as if it were speech.
 */
export function buildTranscriptionPrompt(
  language: Language,
  stage: string,
  hintList: string
): string {
  const base = TRANSCRIPTION_BASE[language];

  if (stage === 'seat') {
    return `${base} ${SEAT_INSTRUCTION[language]} ${hintList}.`;
  }

  const context = STAGE_CONTEXT[language][stage] ?? FALLBACK_CONTEXT[language];
  return `${base} ${context}. ${OPTIONS_LABEL} ${hintList}.`;
}
