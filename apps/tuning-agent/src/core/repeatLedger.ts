/**
 * What the agent has already SAID at the current stage, across visitor turns.
 * Booth demo only (AGENT_STUDY_MODE=demo); a study session never builds one.
 *
 * KSEA poster session, 2026-10-24 (.notes/ksea-2026-poster-session-analysis.md,
 * "Repetition"): in a loud hall 30 of 102 visitor turns were noise, bystander
 * chat or the kiosk's own voice, and each of them was answered by planning
 * again from an unchanged screen, which produced the same sentence again — 32
 * exact and 16 near repeats of the stage question, and the confirm read-back
 * nine times in 35 s. `repeatGuard.ts` already drops a sentence repeated inside
 * one turn, but it resets on every user message, and a noise turn IS a user
 * message, so it never saw any of these.
 *
 * Three rules, all on the spoken text only. Nothing here ever changes which tool
 * runs, so a select or next that a turn plans still runs whatever happens to its
 * sentence — that is how a bare "네" keeps its commit.
 *
 *   0. Within one visitor turn, a sentence is said once. repeatGuard.ts
 *      compares whole messages, so "…1곳을 숨겼어요. 어느 곳으로 할까요?" on the
 *      filter step and "어느 곳으로 할까요?" on the respond after it both went
 *      out (Round 3 live run, card A). `beginTurn` marks the boundary.
 *   1. Nothing-new turns. When the visitor's turn changed nothing — the
 *      preference extractor added or changed nothing — a sentence that is an
 *      exact or near (>= 0.8) repeat of one already spoken at this stage is
 *      dropped. If nothing is left, the agent stays silent: the question is
 *      still on screen and still on the floor, and the empty-respond guard is
 *      told the silence is deliberate. A bare agreement ("네", "그걸로 할게요")
 *      is nothing new too when it agrees to nothing — every agreement-turn
 *      repeat in the poster logs was a "네" to an OPEN question ("어느 좌석으로
 *      할까요?") — but a repeated yes/no question ("Cinema Detroit로 할까요?")
 *      after an agreement is kept: that is the planner failing to act on a yes,
 *      and the visitor should hear it rather than wait in silence.
 *   2. The hidden count, said once (report item 3). A sentence that states how
 *      many options a filter is hiding is dropped when the same count was
 *      already stated at this stage and no filter changed since, in any turn —
 *      unless the visitor asked about hidden options in this turn. This is the
 *      runtime half of HIDDEN_COUNT_ONCE_RULES in llmPlanner.ts; the prompt
 *      half alone cannot catch a restatement in a different wording.
 *
 * Entries live for one stage. A stage change (forward, or a backtrack) clears
 * them, and so does a session reset or a language switch.
 *
 * Pure and synchronous, so `repeatLedger.check.ts` and
 * `noiseRepeat.regress.ts` run it on the logged poster sequences offline.
 */

/** Near-repeat threshold: char-bigram Dice over the normalised sentence. */
export const NEAR_REPEAT_SIMILARITY = 0.8;

/** Lower-case, NFKC, letters and digits only. "9:30 PM로 할까요?" → "930pm로할까요". */
export function normalizeForRepeat(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Sentences, split after ? ! 。 ？ ！ always and after "." only when a space
 * follows — "$12.00예요" and "9:30" must survive whole.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[?!。？！])\s*|(?<=\.)\s+/u)
    .map((part) => part.trim())
    .filter((part) => normalizeForRepeat(part).length > 0);
}

function bigrams(value: string): Map<string, number> {
  const out = new Map<string, number>();
  const chars = Array.from(value);
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const gram = chars[index] + chars[index + 1];
    out.set(gram, (out.get(gram) ?? 0) + 1);
  }
  return out;
}

/**
 * Dice coefficient over character bigrams of the normalised text, 0..1.
 * Character bigrams rather than words because Korean glues particles onto
 * words ("시간으로" / "시간이"), and Japanese and Chinese have no spaces at all.
 */
export function repeatSimilarity(a: string, b: string): number {
  const left = normalizeForRepeat(a);
  const right = normalizeForRepeat(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of leftGrams.values()) leftTotal += count;
  for (const count of rightGrams.values()) rightTotal += count;
  if (leftTotal === 0 || rightTotal === 0) return 0;
  let shared = 0;
  for (const [gram, count] of leftGrams) shared += Math.min(count, rightGrams.get(gram) ?? 0);
  return (2 * shared) / (leftTotal + rightTotal);
}

export function isNearRepeat(a: string, b: string): boolean {
  return repeatSimilarity(a, b) >= NEAR_REPEAT_SIMILARITY;
}

/**
 * A question with an open slot — which, what, when, where, how many, one of
 * two — as opposed to a yes/no confirmation of one option. A "네" answers the
 * second and agrees to nothing in the first. ko/en from the poster logs;
 * ja/zh/de/fr/es one obvious form each (UNMEASURED).
 */
const OPEN_QUESTION =
  /어느|어떤|어디|언제|몇|무엇|뭘|뭐가|누구|중\s*(에서|에)?\s*(어느|어떤|하나|무엇|뭐)|아니면|\bwhich\b|\bwhat\b|\bwhen\b|\bwhere\b|\bhow (many|far|much|long)\b|\bor\b[^?]*\?|どの|どれ|どこ|いつ|何|哪|什么|什麼|几|幾|welche|wann|\bwo\b|quel|quand|\boù\b|cuál|qué|cuándo|dónde/iu;

export function isClosedQuestion(sentence: string): boolean {
  return /[?？]\s*$/u.test(sentence.trim()) && !OPEN_QUESTION.test(sentence);
}

// ── Hidden-count sentences ──────────────────────────────────────────────────

/** "…숨겨져 있어요", "…숨겼어요", "… are hidden", "…非表示", "…隐藏". */
const HIDDEN_WORDS =
  /숨겨|숨겼|숨긴|숨길|가려져|가렸|\bhidden\b|\bhiding\b|\bhid\b|\bhide\b|非表示|隠れ|隠し|隐藏|隱藏|ausgeblendet|verborgen|masqu|ocult/iu;

const EN_NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const KO_NATIVE_COUNTS: Record<string, number> = {
  한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
};

/** True for a sentence that tells the visitor options are being hidden. */
export function isHiddenCountSentence(sentence: string): boolean {
  return HIDDEN_WORDS.test(sentence);
}

/**
 * The count a hidden-count sentence states, as a key: "4" for "4개 상영이
 *숨겨져 있어요" and for "Four showtimes are hidden", "?" when it states none.
 * Keyed on the number, not on the wording, because the same count came back
 * as "…조건으로 4개 상영을 숨겼어요" and "…조건 때문에 4개 상영이 숨겨져 있어요"
 * in one turn (dc803c81, 17:59:51 and 17:59:55).
 */
export function hiddenCountKey(sentence: string): string {
  // A number on a counter first: "4개", "1곳", "3편" — never the "10" of "오후
  // 10시 이전" or the "15" of "15마일", which name the requirement, not the count.
  const counted = /(\d+)\s*(개|곳|편|회|가지|건|군데)/u.exec(sentence);
  if (counted) return String(Number(counted[1]));
  const NOUN = '(?:other\\s+)?(?:options?|showtimes?|showings?|screenings?|movies?|films?|theat(?:er|re)s?|cinemas?|seats?|dates?|days?|ones?)';
  const enDigits = new RegExp(`(\\d+)\\s+${NOUN}`, 'i').exec(sentence);
  if (enDigits) return String(Number(enDigits[1]));
  const lower = sentence.toLowerCase();
  for (const [word, value] of Object.entries(EN_NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\s+${NOUN}`, 'i').test(lower)) return String(value);
  }
  const native = /(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열)\s*(개|곳|편|회|상영|좌석|자리|가지)/u.exec(sentence);
  if (native) return String(KO_NATIVE_COUNTS[native[1]]);
  // Any other number that is not a clock time, a distance or a price.
  const bare = /(\d+)(?![\d:.]|\s*(시|분|마일|miles?|mi\b|km|pm|am|달러|\$))/iu.exec(sentence.replace(/\$\s*\d+(\.\d+)?/gu, ''));
  if (bare) return String(Number(bare[1]));
  for (const [word, value] of Object.entries(EN_NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return String(value);
  }
  return '?';
}

// ── What the visitor said ───────────────────────────────────────────────────

/**
 * A bare agreement or a commit phrase: "네", "좋아요", "그걸로 할게요", "거기로
 * 해 줘", "yes", "that one". These are how a visitor commits, and the
 * extractor finds nothing in them by design. The ledger never touches the
 * select or next such a turn plans; it only keeps a repeated yes/no question
 * audible after one (rule 1).
 */
const AGREEMENT_PATTERNS: readonly RegExp[] = [
  // ko
  /^(어|아|음|오)?\s*[,.]?\s*(네|넵|예|응|웅|좋아요|좋습니다|좋아|그래요|그래|그럼요|맞아요|맞아|맞습니다|오케이|됐어요|됐습니다)(?![가-힣])/u,
  /(할게요|할께요|할래요|할래|하겠습니다|해\s*줘|해\s*주세요|해\s*줄래|해요|갈게요|볼게요|볼래요|됐습니다|됐어요|좋아요|좋습니다|주세요)\s*[.!?~]*$/u,
  /(그걸로|그거로|그것으로|이걸로|이거로|저걸로|거기로|여기로|그\s*날짜로|그\s*시간으로)/u,
  // en
  /^(yes|yeah|yep|yup|sure|ok|okay|alright|all right|fine|great|perfect|sounds good|go ahead|do it|confirm)\b/iu,
  /\b(that one|this one|that's fine|that works|works for me|i'll take|let's go with|let's do|go with)\b/iu,
  // ja / zh / de / fr / es (unmeasured: one obvious form each)
  /^(はい|うん|ええ|それで|お願いします|それにします)/u,
  /^(好|是|对|對|可以|行|就这个|就這個|嗯)/u,
  /^(ja|genau|gerne|oui|d'accord|sí|si|vale|claro)\b/iu,
];

export function isBareAgreement(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // "네?", "응?" alone are "pardon?", not a yes.
  if (/^[^\s]{1,3}\s*[?？]$/u.test(trimmed)) return false;
  return AGREEMENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * The visitor asked about what is hidden ("다른 건 없어요?", "what else is
 * there?"): the count may be said again on that turn.
 */
const ASKS_ABOUT_HIDDEN =
  /숨|가려|안\s*보이|나머지|다른\s*(거|것|건|게|옵션|영화|극장|영화관|시간|상영|날|날짜|좌석|자리)|더\s*(있|없)|hidden|\bhide|\bother (options|ones|showtimes|movies|films|theaters|theatres|times|days|seats)|anything else|what else|any more|more options|the rest/iu;

export function asksAboutHidden(text: string): boolean {
  return ASKS_ABOUT_HIDDEN.test(text);
}

// ── The ledger ──────────────────────────────────────────────────────────────

export interface LedgerFilterInput {
  stage: string | null;
  text: string;
  /**
   * This visitor turn changed nothing: the extractor added or changed no
   * preference. Rule 1 applies only then.
   */
  nothingNew: boolean;
  /** The turn was a bare agreement (isBareAgreement): see rule 1. */
  agreement?: boolean;
  /** The visitor asked about hidden options this turn: rule 2 stands down. */
  askedAboutHidden: boolean;
  /**
   * Rule 2 would leave the message empty and the visitor has heard nothing
   * since they spoke: keep the message whole rather than end a turn that DID
   * change something in silence.
   */
  keepIfEmptied: boolean;
}

export interface LedgerFilterResult {
  /** What to say. Empty means say nothing. */
  text: string;
  droppedHidden: string[];
  droppedRepeats: string[];
  /** The input had words and the result has none. */
  silenced: boolean;
}

export interface StageRepeatLedger {
  /** The stage the entries belong to, or null when empty. */
  stage(): string | null;
  clear(reason: string): void;
  lastClearReason(): string;
  /**
   * A filter was applied, changed or removed at this stage: the count said
   * before no longer describes the screen, so the next statement of it is new.
   * Called BEFORE the filter step's own sentence is filtered.
   */
  noteFilterChanged(): void;
  /** A visitor turn opens (a user message): rule 0's memory starts over. */
  beginTurn(): void;
  filter(input: LedgerFilterInput): LedgerFilterResult;
  /** Record what was actually sent, after `filter`. */
  noteSpoken(stage: string | null, text: string): void;
  spokenSentences(): string[];
}

export function createStageRepeatLedger(): StageRepeatLedger {
  let currentStage: string | null = null;
  let sentences: string[] = [];
  let hiddenCounts = new Set<string>();
  /** Sentences said at this stage since the visitor last spoke (rule 0). */
  let turnSentences: string[] = [];
  let clearReason = 'init';

  function enter(stage: string | null): void {
    if (stage === currentStage) return;
    currentStage = stage;
    sentences = [];
    hiddenCounts = new Set();
    turnSentences = [];
    clearReason = 'stage-moved';
  }

  return {
    stage: () => currentStage,
    clear(reason: string): void {
      currentStage = null;
      sentences = [];
      hiddenCounts = new Set();
      turnSentences = [];
      clearReason = reason;
    },
    beginTurn(): void {
      turnSentences = [];
    },
    lastClearReason: () => clearReason,
    noteFilterChanged(): void {
      hiddenCounts = new Set();
    },
    filter({ stage, text, nothingNew, agreement = false, askedAboutHidden, keepIfEmptied }): LedgerFilterResult {
      enter(stage);
      const original = splitSentences(text);
      if (original.length === 0) {
        return { text: text.trim(), droppedHidden: [], droppedRepeats: [], silenced: false };
      }
      const droppedHidden: string[] = [];
      const droppedRepeats: string[] = [];
      const kept: string[] = [];
      const seenHiddenHere = new Set<string>();
      for (const sentence of original) {
        if (isHiddenCountSentence(sentence) && !askedAboutHidden) {
          const key = hiddenCountKey(sentence);
          // Twice in one message is a restatement too.
          if (hiddenCounts.has(key) || seenHiddenHere.has(key)) {
            droppedHidden.push(sentence);
            continue;
          }
          seenHiddenHere.add(key);
        }
        if (turnSentences.some((earlier) => isNearRepeat(earlier, sentence))) {
          droppedRepeats.push(sentence);
          continue;
        }
        if (
          nothingNew &&
          !(agreement && isClosedQuestion(sentence)) &&
          sentences.some((earlier) => isNearRepeat(earlier, sentence))
        ) {
          droppedRepeats.push(sentence);
          continue;
        }
        kept.push(sentence);
      }
      if (kept.length === 0 && droppedRepeats.length === 0 && keepIfEmptied) {
        // Only rule 2 emptied it, on a turn that changed something: say it.
        return { text: text.trim(), droppedHidden: [], droppedRepeats: [], silenced: false };
      }
      if (droppedHidden.length === 0 && droppedRepeats.length === 0) {
        return { text: text.trim(), droppedHidden, droppedRepeats, silenced: false };
      }
      const result = kept.join(' ');
      return { text: result, droppedHidden, droppedRepeats, silenced: result.length === 0 };
    },
    noteSpoken(stage: string | null, text: string): void {
      enter(stage);
      for (const sentence of splitSentences(text)) {
        sentences.push(sentence);
        turnSentences.push(sentence);
        if (isHiddenCountSentence(sentence)) hiddenCounts.add(hiddenCountKey(sentence));
      }
    },
    spokenSentences: () => [...sentences],
  };
}
