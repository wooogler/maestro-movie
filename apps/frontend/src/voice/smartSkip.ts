import type { UtteranceClassification } from './classifyUtterance';
import type { VoiceCategory, VoiceMode, VoiceVerbositySettings } from './verbosity';

/**
 * The gate between "the agent produced a sentence" and "the browser speaks it".
 *
 * Pure function, no React, no store — everything it needs is passed in, so it
 * can be exercised by `smartSkip.check.ts` and replayed over the study corpus.
 *
 * IMPORTANT: a `silent` decision does not make the utterance free. The agent
 * counts every `agent.message` the host accepts and waits for a matching
 * `tts.playback.complete` before it plans again (`speechBarrier.ts`), timing out
 * after 15 s. Whoever acts on a `silent` decision must release that credit —
 * see `releaseSpeechBarrierForSkip` in ChatPage.
 */

export interface VoiceDecisionInput {
  text: string;
  classification: UtteranceClassification;
  settings: VoiceVerbositySettings;
  /** Option labels currently rendered on screen (`spec.visibleItems[].value`). */
  visibleLabels: string[];
  /** Stage heading, e.g. "Select Showtime". Part of the on-screen token set. */
  screenTitle?: string | null;
  /**
   * Verbatim text of the utterances recently spoken in this session, newest
   * last. Raw rather than normalised because the dedupe guard needs the
   * original capitalisation to spot proper nouns.
   */
  recentSpoken: string[];
  /** Agent utterances since the participant last said or did anything. */
  consecutiveCount: number;
}

export interface VoiceDecision {
  category: VoiceCategory;
  /** What the preset alone asked for, before the smart rules. */
  settingMode: VoiceMode;
  mode: VoiceMode;
  /** '' when silent. */
  spokenText: string;
  /** Which smart rule changed the outcome, if any. */
  rule: string | null;
}

/** How many past utterances R1 remembers. */
export const RECENT_UTTERANCE_WINDOW = 12;
/** How many of those R2 compares against — near-duplicates cluster locally. */
const NEAR_DUPLICATE_WINDOW = 6;
/**
 * Dice coefficient over character trigrams. Calibrated on the near-duplicate
 * pairs the corpus analysis found: the real ones score 0.77-0.83 here, while
 * genuinely different utterances stay at or below 0.56.
 */
const NEAR_DUPLICATE_THRESHOLD = 0.75;
/** Trigger the monologue cap on the third back-to-back utterance. */
const MONOLOGUE_LIMIT = 2;
/** How many on-screen option labels an utterance must recite to count as a read-back. */
const LIST_READBACK_LABELS = 3;
/** Longest a shortened non-question utterance may be before it is cut. */
const BRIEF_MAX_CHARS = 110;
/** A shortening that saves less than this much is not worth calling "brief". */
const BRIEF_MIN_SAVING = 0.1;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'your', 'you', 'are', 'was',
  'have', 'has', 'will', 'can', 'from', 'into', 'onto', 'they', 'them', 'these',
  'those', 'here', 'there', 'now', 'next', 'back', 'more', 'also', 'just',
  'only', 'both', 'each', 'been', 'them', 'what', 'when', 'which', 'while',
  'option', 'options', 'one', 'ones',
]);

/**
 * Hangul is kept alongside `a-z0-9`. Stripping it — which this did — collapsed
 * every Korean utterance to the empty string, so R1 saw the second Korean
 * sentence of a session as an exact repeat of the first and went on matching
 * everything after it. That silences narration and, worse, downgrades real
 * conversation to `brief`.
 */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\uac00-\ud7a3]+/g, ' ')
    .trim();
}

function trigrams(value: string): Set<string> {
  const padded = ` ${value} `;
  const set = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) set.add(padded.slice(i, i + 3));
  return set;
}

/** Dice coefficient over character trigrams: 2|A∩B| / (|A|+|B|). */
export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * The tokens that carry the specific thing an utterance is about: numbers,
 * times, and proper nouns.
 *
 * Narration is templated, so two utterances about *different* options score
 * very high on raw text similarity — "Choosing Mar 14 (Sat) for your show
 * date." and "Choosing Mar 15 (Sun) for your show date." are 0.82 similar and
 * are emphatically not duplicates. Requiring these tokens to match as well is
 * what stops the dedupe rule from swallowing a changed choice.
 *
 * The first word of every sentence is skipped because sentence-initial
 * capitalisation says nothing about proper-noun-hood — see
 * `distinguishingTokens`.
 */
/**
 * Words that name a specific option no matter where they appear. Capitalisation
 * cannot be trusted at a sentence start, so "Saturday works best…" and "Sunday
 * works best…" would otherwise look like the same sentence.
 */
const VALUE_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'today', 'tomorrow', 'tonight', 'morning', 'afternoon', 'evening', 'night',
  'imax', 'standard',
  // Korean equivalents. Dates and times mostly carry digits, which the `\d`
  // branch already catches; these are the ones that do not.
  '오늘', '내일', '모레', '오전', '오후', '저녁', '밤', '아침', '낮',
  '월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일',
  '일반', '프리미엄',
]);

/**
 * A capitalised word that merely opens a sentence is not a name. This used to
 * skip position 0 of the whole utterance only, so the "Which" in "Both are
 * Standard. Which time would you like?" counted as a proper noun and the
 * sentence never matched "Both showtimes are Standard; which time would you
 * like?" (0.894 on trigrams) — it was spoken in full right after it. Sentences
 * are cut the way `shortenForBrief` cuts them, and a `;` ends a clause the same
 * way, so the word after either is skipped too.
 */
function sentenceStart(tokens: string[], index: number): boolean {
  if (index === 0) return true;
  // `.`, `!` and `?` are already sentence boundaries by the time this runs:
  // `splitSentences` breaks on them whenever a capital follows, and the only
  // full stops it leaves in front of a capital are masked abbreviations
  // ("6 p.m. Redford…"), which must NOT hide the name after them.
  return /;["'\u201d\u2019)\]]*$/.test(tokens[index - 1]);
}

function distinguishingTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const sentence of splitSentences(text)) {
    const tokens = sentence.split(/\s+/);
    tokens.forEach((raw, index) => {
      const token = raw.replace(/^[^\w\uac00-\ud7a3]+|[^\w\uac00-\ud7a3]+$/g, '');
      if (!token) return;
      const lower = token.toLowerCase();
      if (/\d/.test(token) || VALUE_WORDS.has(lower)) out.add(lower);
      // Capitalisation marks a name in English. Korean has no case, but the
      // catalogue's names stay in Latin script inside a Korean sentence, so the
      // same test still finds them there.
      else if (!sentenceStart(tokens, index) && /^[A-Z][a-z]/.test(token)) out.add(lower);
    });
  }
  return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * Four characters is an English heuristic for "long enough to carry meaning".
 * Hangul packs a word into two or three, so applying the same floor to Korean
 * discards every content word and leaves nothing to compare.
 */
function minContentTokenLength(token: string): number {
  return /[\uac00-\ud7a3]/.test(token) ? 2 : 4;
}

function contentTokens(text: string): string[] {
  return normalizeForCompare(text)
    .split(' ')
    .filter(
      (token) =>
        // A token carrying a digit is content however short it is, and it used
        // to be discarded twice over — once by the length floor, once by an
        // explicit pure-digit exclusion. That threw away exactly the word that
        // says WHICH option: "Selecting March 20." reduced to "march", a token
        // every date label on screen carries, so R3 silenced narration about a
        // date that was not on screen at all. Same for "seats E4 and E5".
        (/\d/.test(token) || token.length >= minContentTokenLength(token)) &&
        !STOPWORDS.has(token)
    );
}

/**
 * True when every meaningful word of the utterance is already printed on
 * screen — the literal definition of "you can see this, I don't need to say
 * it". Only ever consulted for narration categories.
 */
function isAlreadyOnScreen(
  text: string,
  classification: UtteranceClassification,
  visibleLabels: string[],
  screenTitle: string | null | undefined
): boolean {
  // Drop the verb phrase: "Selecting" is never printed on a button.
  const body = text.slice(classification.verbPrefixLength);
  const tokens = contentTokens(body);
  if (tokens.length === 0) return false;

  const inLabels = new Set<string>();
  for (const label of visibleLabels) for (const t of contentTokens(label)) inLabels.add(t);
  if (inLabels.size === 0) return false;

  const onScreen = new Set(inLabels);
  if (screenTitle) for (const t of contentTokens(screenTitle)) onScreen.add(t);

  // The title is allowed to *cover* a word, but never to carry the match on its
  // own: "Selecting seats." reduces to the single token "seats", which the
  // "Select Seats" heading would otherwise satisfy while naming no option at
  // all. (Seat ids themselves now survive `contentTokens`, so "Selecting seats
  // E4 and E5." is judged on E4 and E5 as it always should have been.)
  return tokens.every((token) => onScreen.has(token)) && tokens.some((token) => inLabels.has(token));
}

/**
 * How many of the options currently on screen the utterance reads out loud.
 *
 * This is the tail that made `respond` utterances reach 833 characters:
 * "The showtimes that end by 2 p.m. are 10:50 AM, which ends at 12:21 PM, and
 * 12:20 PM, which ends at 1:51 PM. …" — every one of those strings is printed
 * on a button the participant is looking at.
 */
function countRecitedLabels(text: string, visibleLabels: string[]): number {
  // Padded both sides so containment is token-aligned. Raw `includes` finds
  // "1:45 PM" inside "11:45 PM" and "2:00 PM" inside "12:00 PM" — ordinary
  // collisions with 12-hour labels, and each one inflates the count toward the
  // read-back threshold on an utterance that recited nothing.
  const haystack = ` ${normalizeForCompare(text)} `;
  const seen = new Set<string>();
  for (const label of visibleLabels) {
    const needle = normalizeForCompare(label);
    if (needle.length >= 3 && haystack.includes(` ${needle} `)) seen.add(needle);
  }
  return seen.size;
}

/**
 * Abbreviations whose full stop is not a sentence end. `p.m.` is the one that
 * matters — the corpus is full of "…fits your 6 p.m. cutoff. Want to go with
 * 3:40 p.m. or the later one?", and a naive split leaves "or the later one?"
 * as the only "question", which is what would get spoken.
 */
const ABBREVIATION = /\b(?:p\.m|a\.m|e\.g|i\.e|etc|vs|approx|no|mr|mrs|ms|dr|st)\./gi;
const DOT_PLACEHOLDER = '\u0000';

function splitSentences(text: string): string[] {
  const masked = text.replace(ABBREVIATION, (match) => match.replace(/\./g, DOT_PLACEHOLDER));
  return masked
    // A real break is a terminator followed by something that starts like a new
    // sentence. Requiring that as well as masking abbreviations means an
    // unlisted abbreviation degrades to "no split" rather than to a fragment.
    // `[A-Z0-9]` alone never fires on Korean — Hangul has no case — so a whole
    // Korean reply was one "sentence" and `brief` could not shorten it at all.
    .split(/(?<=[.!?])\s+(?=["'\u201c\u2018(\[]?[A-Z0-9\uac00-\ud7a3])/)
    .map((part) => part.split(DOT_PLACEHOLDER).join('.').trim())
    .filter(Boolean);
}

function capitalizeFirst(text: string): string {
  if (!text) return text;
  return text[0].toUpperCase() + text.slice(1);
}

function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

/**
 * Shorten without ever dropping the question.
 *
 * The corpus makes the rule obvious: `respond` utterances are a preamble
 * followed by a question, and the preamble is usually a read-back of what is on
 * screen (p90 167 chars, max 833, 5.1% enumerate three or more visible
 * options). Keeping only the question sentences attacks that tail without
 * touching the median.
 *
 * Narration utterances rarely contain a question, so they shorten the other
 * way: strip the verb phrase the classifier already matched and keep the
 * object. "I'm highlighting the PG options." → "The PG options."
 */
export function shortenForBrief(
  text: string,
  classification: UtteranceClassification
): string {
  const trimmed = text.trim();
  const sentences = splitSentences(trimmed);

  if (classification.hasQuestion) {
    const questions = sentences.filter((sentence) => sentence.endsWith('?'));
    if (questions.length > 0) {
      const kept = questions.join(' ');
      // Never truncate a question — an over-long one is still better than a
      // fragment the participant cannot answer.
      return isWorthIt(trimmed, kept) ? kept : trimmed;
    }
    // A "?" somewhere other than a sentence end. Leave it alone.
    return trimmed;
  }

  let candidate: string;
  if (classification.verbPrefixLength > 0) {
    const stripped = trimmed.slice(classification.verbPrefixLength).trim();
    // Keep only the first clause of what is left; the rest is usually a
    // "…so you can compare the end times" rationale.
    candidate = capitalizeFirst(splitSentences(stripped)[0] ?? stripped);
  } else {
    candidate = sentences[0] ?? trimmed;
  }

  candidate = truncateAtWord(candidate, BRIEF_MAX_CHARS);
  return isWorthIt(trimmed, candidate) ? candidate : trimmed;
}

/**
 * Guard against a shortening that is empty, contentless, longer, or barely
 * different.
 *
 * The contentless case is not hypothetical: "Confirming your booking." is a
 * whole utterance in the corpus, the verb phrase the classifier matched covers
 * every word of it, and the remainder is the full stop. Without this the
 * participant hears a shortening consisting of one click.
 */
function isWorthIt(original: string, candidate: string): boolean {
  const cleaned = candidate.trim();
  if (!cleaned) return false;
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return false;
  return cleaned.length <= original.length * (1 - BRIEF_MIN_SAVING);
}

const MODE_RANK: Record<VoiceMode, number> = { speak: 0, brief: 1, silent: 2 };

/** Downgrades only — a smart rule may quieten an utterance, never amplify it. */
function downgrade(
  current: { mode: VoiceMode; rule: string | null },
  next: VoiceMode,
  rule: string
): { mode: VoiceMode; rule: string | null } {
  if (MODE_RANK[next] <= MODE_RANK[current.mode]) return current;
  return { mode: next, rule };
}

export function decideVoiceOutput(input: VoiceDecisionInput): VoiceDecision {
  const { text, classification, settings, recentSpoken, consecutiveCount } = input;
  const category = classification.category;
  const settingMode = settings.categories[category] ?? 'speak';

  // Errors and host-status notices have no on-screen equivalent, so they are
  // outside the whole mechanism.
  if (category === 'system') {
    return { category, settingMode: 'speak', mode: 'speak', spokenText: text, rule: null };
  }

  let state: { mode: VoiceMode; rule: string | null } = { mode: settingMode, rule: null };

  if (settings.smartSkip) {
    const normalized = normalizeForCompare(text);

    const normalizedRecent = recentSpoken.map(normalizeForCompare);

    // `respond` carries everything the participant is told, including the
    // agent's failure notices ("Planner request failed this turn.", "None of
    // the options match that filter."), which repeat verbatim precisely when
    // something is going wrong. Silencing a repeat there means the participant
    // asks a question and hears nothing while the screen does not move. So the
    // repeat rules shorten conversation; they never mute it.
    const repeatMode: VoiceMode = category === 'respond' ? 'brief' : 'silent';

    // R1 — the agent said this exact sentence already. 2.8% of the corpus.
    // `normalized` can still come back empty (an utterance of pure punctuation
    // or an unhandled script), and empty matching empty would silence every
    // such utterance after the first. Nothing is a repeat of nothing.
    if (normalized.length > 0 && normalizedRecent.includes(normalized)) {
      state = downgrade(state, repeatMode, 'exact-repeat');
    } else {
      // R2 — near-duplicate. 9.2% of the corpus. Guarded so that two sentences
      // about different options never count as the same sentence.
      const mine = distinguishingTokens(text);
      // Muting needs a stronger duplicate test than shortening, for the same
      // reason `repeatMode` exists at all.
      //
      // `distinguishingTokens` only sees numbers, dates and proper nouns, so
      // two sentences differing by an ordinary word look identical to it:
      // "Sorting theaters by distance." scores 0.755 against "…by price.",
      // "…start after 6." scores 0.800 against "…start before 6.", and
      // "…each movie's rating" against "…each movie's genre". Those are
      // opposite actions, and for narration the penalty is silence — the
      // participant watches the screen change with no account of it. So a
      // narration repeat must also agree on its content words.
      //
      // Conversation keeps the looser test. Its penalty is `brief`, which
      // preserves the question, so calling a genuine reword a repeat costs a
      // clause rather than the message: "Which time works for you?" after
      // "Which showtime do you want?" is worth shortening.
      const myContent = repeatMode === 'silent' ? new Set(contentTokens(text)) : null;
      const isNearDuplicate = normalized.length > 0 && recentSpoken
        .slice(-NEAR_DUPLICATE_WINDOW)
        .some(
          (past) =>
            trigramSimilarity(normalized, normalizeForCompare(past)) >= NEAR_DUPLICATE_THRESHOLD &&
            sameSet(mine, distinguishingTokens(past)) &&
            (myContent === null || sameSet(myContent, new Set(contentTokens(past))))
        );
      if (isNearDuplicate) state = downgrade(state, repeatMode, 'near-duplicate');
    }

    // R3 — narration whose every word is already printed on screen.
    if (
      category !== 'respond' &&
      isAlreadyOnScreen(text, classification, input.visibleLabels, input.screenTitle)
    ) {
      state = downgrade(state, 'silent', 'on-screen-narration');
    }

    // R5 — the utterance recites options that are on screen right now. Brief
    // resolves to "keep the question, drop the preamble", which is exactly the
    // right cut: the list stays visible, the question stays audible.
    if (
      category === 'respond' &&
      countRecitedLabels(text, input.visibleLabels) >= LIST_READBACK_LABELS
    ) {
      state = downgrade(state, 'brief', 'list-readback');
    }

    // R4 — the agent is monologuing. 13.1% of turns are two or more
    // back-to-back utterances; this trips on the third.
    if (consecutiveCount >= MONOLOGUE_LIMIT) {
      state = downgrade(state, category === 'respond' ? 'brief' : 'silent', 'monologue-cap');
    }
  }

  // Floor: a question is never silent. Whatever the participant is being asked,
  // they get to hear it — this is what makes an aggressive preset safe, and it
  // covers the handful of conversational utterances the classifier mislabels.
  if (state.mode === 'silent' && classification.hasQuestion) {
    state = { mode: 'brief', rule: state.rule ? `${state.rule}+question-floor` : 'question-floor' };
  }

  if (state.mode === 'silent') {
    return { category, settingMode, mode: 'silent', spokenText: '', rule: state.rule };
  }
  if (state.mode === 'brief') {
    const spokenText = shortenForBrief(text, classification);
    return { category, settingMode, mode: 'brief', spokenText, rule: state.rule };
  }
  return { category, settingMode, mode: 'speak', spokenText: text, rule: state.rule };
}
