/**
 * Booth demo only (AGENT_STUDY_MODE=demo): two shortcuts that shorten the chain
 * of planner calls between the visitor's last word and the agent's first one.
 * A study session never calls either; `index.ts` gates both on `isDemoMode`.
 *
 * KSEA poster session, 2026-10-24 (.notes/ksea-2026-poster-session-analysis.md,
 * "Latency"): the first spoken word came a median 3.8 s after the visitor
 * stopped, and the chain was the cost — one planner call before speaking gave
 * 3.1 s, three gave 5.7 s. A turn that advanced a stage (select → next → the
 * next stage's opening) took a median 6.0 s against 3.1 s for an answer-only
 * turn, and the preference extractor, which every planner call waited for, was
 * 21% of the silent wait.
 *
 *  1. `decideAutoNext`: after a committed select, the planner call that follows
 *     is offered exactly one tool (`next`, see getPlannerToolSchema), and in the
 *     58 booth traces on disk on 24 Oct every select was followed by a planned
 *     next (the 75 tagged ones that day: [named-option] 66, [single-viable] 6,
 *     [superlative] 1, [other] 2 — both seat agreements). That call is
 *     1.5 s of silence spent on a foregone conclusion, so the runtime makes it
 *     itself, under the conditions below, and the chain carries on with the
 *     stage-entry planning exactly as after a planned `next`.
 *  2. `isPurePick`: a bare agreement or a pure pick («네», «첫 번째 걸로
 *     할게요», "that one") carries nothing for the extractor to find, so the
 *     first planner call need not wait for it. The runtime starts both, and
 *     reconciles before executing anything: if extraction did change memory,
 *     the decision is thrown away and planned again.
 *
 * Both pure and synchronous, so `autoNext.check.ts` pins them offline.
 */

/** The rule tag DECISIVE_SELECTION_RULES asks the planner to open `reason` with. */
export function readRuleTag(reason: string): string | null {
  const match = /^\s*\[([a-z-]+)\]/u.exec(reason);
  return match ? match[1] : null;
}

/** Tags under which a select is the visitor's own choice, not a pointer. */
const COMMIT_TAGS = new Set(['named-option', 'single-viable', 'superlative']);
/** Stages whose `next` only advances. At the confirm stage `next` books. */
const ADVANCE_STAGES = new Set(['movie', 'theater', 'date', 'time', 'seat']);

export interface AutoNextInput {
  /** AGENT_STUDY_MODE=demo. */
  demo: boolean;
  /** Stage the select ran at (the planning context's stage). */
  stage: string | null;
  /** Stage on screen now, after the select's outcome and resync. */
  stageNow: string | null;
  /** The tool that just ran, and whether the host accepted it. */
  toolName: string;
  ok: boolean;
  /** The planner's `reason` and `assistantMessage` for that tool call. */
  reason: string;
  assistantMessage: string;
  /** A visitor utterance opened this turn (booth turn state is live). */
  userTurn: boolean;
  /** That utterance was a bare agreement (repeatLedger.isBareAgreement). */
  agreementTurn: boolean;
  /** The host's tool schema offers `next` now. */
  nextOffered: boolean;
  /** Navigation tools were withheld for this planning call, or are to be for the next. */
  suppressNavigation: boolean;
  /** A backtrack continuation or a pending backtrack conflict was live. */
  backtrackActive: boolean;
  /** The agent ran `prev` since the visitor last spoke. */
  prevInTurn: boolean;
  /** After the select: what proceedRule reads. */
  selectedId: string | null;
  selectedListCount: number;
}

export type AutoNextDecision =
  | { run: true; rule: string; reason: string }
  | { run: false; why: string };

/** Does the sentence ask something? A select paired with a question waits for the answer. */
export function asksQuestion(text: string): boolean {
  return /[?？]/u.test(text);
}

export function decideAutoNext(input: AutoNextInput): AutoNextDecision {
  if (!input.demo) return { run: false, why: 'not-demo' };
  if (input.toolName !== 'select' && input.toolName !== 'selectMultiple') return { run: false, why: 'not-select' };
  if (!input.ok) return { run: false, why: 'select-failed' };
  const stage = input.stage ?? '';
  if (!ADVANCE_STAGES.has(stage)) return { run: false, why: stage === 'confirm' ? 'confirm-stage' : 'unknown-stage' };
  if (input.stageNow !== input.stage) return { run: false, why: 'stage-moved' };
  if (!input.userTurn) return { run: false, why: 'no-user-turn' };
  if (input.suppressNavigation) return { run: false, why: 'navigation-suppressed' };
  if (input.backtrackActive) return { run: false, why: 'backtrack-pending' };
  if (input.prevInTurn) return { run: false, why: 'prev-in-turn' };
  if (!input.nextOffered) return { run: false, why: 'next-not-offered' };
  if (asksQuestion(input.assistantMessage)) return { run: false, why: 'select-asks-question' };

  const tag = readRuleTag(input.reason);
  const committed =
    (tag !== null && COMMIT_TAGS.has(tag)) ||
    // SEAT_CHOICE_RULES: the visitor delegated the seats and the agent picked
    // one whole choice for them, said as a recommendation, asking nothing.
    (tag === 'seat-recommend' && stage === 'seat') ||
    // A yes or "that one" to an option the agent named or marked: the planner
    // files it under [named-option] mostly, [other] sometimes (a seat
    // delegation, an accepted recommendation). Only on an agreement turn.
    (tag === 'other' && input.agreementTurn);
  if (!committed) return { run: false, why: `not-committed:${tag ?? 'untagged'}` };

  const proceed = stage === 'seat' ? input.selectedListCount > 0 : input.selectedId !== null;
  if (!proceed) return { run: false, why: 'proceed-rule-unmet' };

  const rule = tag as string;
  return {
    run: true,
    rule,
    reason: `[${rule}] The ${stage} choice is committed and proceedRule is satisfied, so advance to the next stage.`,
  };
}

// ── Pure picks ──────────────────────────────────────────────────────────────

/*
  Korean is matched with the spaces and punctuation removed, as a sequence of
  pieces drawn only from these lists; English as a sequence of words. Anything
  else in the utterance — a title, a time, a number, "but", a requirement —
  makes it not a pure pick, and it goes through extraction first as before.
  Indifference words («상관없어요», "doesn't matter") count only next to a pick:
  alone they can relax a requirement, which is the extractor's business.
*/
const KO_FILLER = ['어', '아', '음', '오', '자', '그럼', '그러면', '그냥'];
const KO_AGREE = [
  '네', '넵', '예', '응', '웅', '좋아요', '좋습니다', '좋아', '좋네요', '그래요', '그래', '그럼요', '맞아요', '맞아', '맞습니다',
  '오케이', '콜', '됐어요', '됐습니다',
];
const KO_PICK = [
  '그걸로', '그거로', '그것으로', '이걸로', '이거로', '이것으로', '저걸로', '저거로', '거기로', '여기로', '그거', '이거', '저거',
  '그것', '그쪽으로', '이쪽으로',
  '첫번째', '두번째', '세번째', '네번째', '다섯번째', '마지막', '맨위', '맨앞', '맨처음', '처음', '첫째', '둘째', '셋째',
];
/** Particles and nouns that only hang off a pick: «첫 번째 걸로», «마지막 거요». */
const KO_PICK_TAIL = ['걸로', '거로', '것으로', '거요', '거', '것', '꺼', '으로', '로', '요'];
const KO_COMMIT = [
  '할게요', '할께요', '할래요', '할래', '하겠습니다', '할게', '해주세요', '해줘요', '해줘', '해요', '갈게요', '볼게요', '주세요',
  '부탁해요', '부탁합니다', '그렇게',
];
const KO_INDIFFERENT = ['상관없어요', '상관없습니다', '상관없어', '아무거나', '아무데나', '괜찮으니까'];

const EN_FILLER = ['um', 'uh', 'oh', 'well', 'so', 'then', 'okay so', 'and'];
const EN_AGREE = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'alright', 'all right', 'fine', 'great', 'perfect', 'sounds good',
  'that works', 'works for me', "that's fine", 'thats fine', "that's good", 'good', 'go ahead', 'please',
];
const EN_PICK = [
  'that one', 'this one', 'the first one', 'the second one', 'the third one', 'the last one', 'the top one', 'first one',
  'second one', 'third one', 'last one', 'top one', 'the first', 'the second', 'the third', 'the last', 'the top', 'first',
  'second', 'third', 'last', 'that', 'this', 'it', 'one',
];
const EN_COMMIT = ["i'll take", 'ill take', "let's go with", 'lets go with', "let's do", 'lets do', 'go with', 'take', 'i want', "i'll go with", 'do'];
const EN_INDIFFERENT = ["doesn't matter", 'doesnt matter', 'no preference', 'any is fine', 'anything is fine', "i don't mind", 'i dont mind'];

/**
 * Can `text` be split, left to right, into pieces drawn from `groups`? Returns
 * the set of groups one such split used (the first found), or null. Searches
 * every split, so «네 번째» is a position and not «네» + junk, and «아니요» is
 * not the filler «아» + something.
 */
function consume(text: string, groups: Record<string, readonly string[]>, words: boolean): Set<string> | null {
  const pieces = Object.entries(groups).flatMap(([name, list]) => list.map((piece) => ({ name, piece })));
  const dead = new Set<number>();
  const walk = (at: number): string[] | null => {
    let index = at;
    if (words) while (text[index] === ' ') index += 1;
    if (index >= text.length) return [];
    if (dead.has(index)) return null;
    for (const { name, piece } of pieces) {
      if (!text.startsWith(piece, index)) continue;
      const end = index + piece.length;
      // English pieces end on a word boundary; Korean pieces abut.
      if (words && end < text.length && text[end] !== ' ') continue;
      const rest = walk(end);
      if (rest) return [name, ...rest];
    }
    dead.add(index);
    return null;
  };
  const used = walk(0);
  return used ? new Set(used) : null;
}

/**
 * A bare agreement or a pure pick: nothing in it for the preference extractor.
 * Narrower than repeatLedger's isBareAgreement on purpose — that one matches
 * any sentence ending in «할게요», which includes «8시 이후로 할게요».
 */
export function isPurePick(text: string): boolean {
  const trimmed = text.normalize('NFKC').trim();
  if (!trimmed || trimmed.length > 60) return false;
  // "네?" is "pardon?"; a question is never a pick.
  if (/[?？]/u.test(trimmed)) return false;
  if (/\d/u.test(trimmed)) return false;

  if (/[가-힣]/u.test(trimmed)) {
    const compact = trimmed.replace(/[\s.,!~…·'"]+/gu, '');
    const used = consume(
      compact,
      { filler: KO_FILLER, agree: KO_AGREE, pick: KO_PICK, tail: KO_PICK_TAIL, commit: KO_COMMIT, indifferent: KO_INDIFFERENT },
      false
    );
    if (!used) return false;
    if (used.has('tail') && !used.has('pick')) return false;
    if (used.has('indifferent') && !used.has('pick')) return false;
    return used.has('agree') || used.has('pick');
  }

  if (/^[\p{Script=Latin}\s.,!'’-]+$/u.test(trimmed)) {
    const lower = trimmed.toLowerCase().replace(/’/gu, "'").replace(/[.,!-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    const used = consume(
      lower,
      { indifferent: EN_INDIFFERENT, commit: EN_COMMIT, pick: EN_PICK, agree: EN_AGREE, filler: EN_FILLER },
      true
    );
    if (!used) return false;
    if (used.has('indifferent') && !used.has('pick')) return false;
    // "take" or "do" alone commits to nothing.
    return used.has('agree') || used.has('pick');
  }
  return false;
}
