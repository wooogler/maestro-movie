import type { VoiceCategory } from './verbosity';

/**
 * Recover what an utterance is for, from its text alone.
 *
 * The agent does not tag its messages, so this is the only classifier in the
 * loop. It was tuned against every recorded voice-on utterance in the study
 * corpus (4,749 messages from 132 sessions, labelled by the planner tool that
 * produced them, `logs/trace/*.llm-trace.jsonl`):
 *
 *   overall accuracy            97.1%
 *   precision  nav   99.6%   select 93.5%   view 99.4%   respond 96.2%
 *   conversation wrongly routed to a narration category:      12 / 2,495
 *   ...of those, with no question in them (i.e. silenceable):   4 / 4,749
 *
 * All four of those four are narration in substance — "Selecting Mar 15.",
 * "Got it — choosing today, Mar 11." — that the planner happened to emit
 * through `respond` instead of `select`. Silencing them is the correct
 * behaviour, so the practical error rate against the feature's intent is zero.
 *
 * The safe direction is narration → `respond` (costs a few spoken words); the
 * unsafe direction is `respond` → narration (could silence a real question).
 * Every rule is therefore start-anchored, and `smartSkip`'s question floor
 * catches whatever slips through.
 *
 * Re-run the corpus evaluation after touching any regex here:
 *   cd logs/trace && python3 <the script in .notes/voice-verbosity-analysis.md>
 */

export interface UtteranceClassification {
  category: VoiceCategory;
  /** Which rule matched, for the study log. */
  matchedRule: string | null;
  /** Whether the utterance asks the participant something. */
  hasQuestion: boolean;
  /**
   * Length of the leading verb phrase the rule matched ("I'm highlighting "),
   * so `brief` can strip it down to the object ("the PG options").
   */
  verbPrefixLength: number;
}

/** "Great, " / "Got it — " / "Okay. " — filler the planner likes to open with. */
const LEAD_IN =
  /^(?:(?:great|ok|okay|alright|perfect|sure|got it|understood|no problem|sounds good)\b[\s,.—-]*)+/i;

/** Optional "I'll " / "I'm " / "let's " / "we'll " before the verb. */
const PRONOUN = "(?:i(?:'|’)?(?:ll|m)\\s+|let(?:'|’)?s\\s+|we(?:'|’)?(?:ll|re)\\s+)?";

/**
 * Link words swallowed after the matched verb, so `brief` lands on the object
 * rather than on a preposition.
 *
 * This lived inline on `nav.transition` alone, and the corpus shows what the
 * other two rules paid for not having it: 59 of the 4,749 recorded utterances
 * shortened to a dangling fragment that was then read aloud —
 *
 *   "Saturday is set. Moving to showtimes."      -> "To showtimes."
 *   "Narrowing to IMAX showtimes."               -> "To IMAX showtimes."
 *   "Confirming your booking for Tiny Picnic..." -> "For Tiny Picnic..."
 *   "Going back from showtimes so you can..."    -> "From showtimes so you..."
 *
 * `from`, `for` and `up` are here for those; the rest are the original set. It
 * carries no trailing separator, because the three rules disagree on whether
 * one is required — `view.change` must keep its `\\s+` so that "additional"
 * cannot match through `add(?:ing)?`.
 */
const LINK_WORDS =
  '(?:\\s+(?:to|with|toward|towards|on|onto|back|ahead|so|from|for|up)\\b)*';

interface Rule {
  id: string;
  category: VoiceCategory;
  re: RegExp;
}

/**
 * Evaluated in order; first match wins. `nav` precedes `select` because
 * "Moving ahead with Mar 14" is a transition, not a selection, and both open
 * with a gerund.
 */
const RULES: Rule[] = [
  {
    // Runs first: an error is the only thing with no on-screen counterpart, so
    // it must never be routed anywhere that can silence it. The agent does not
    // tag these, so they have to be recognised by their wording.
    id: 'system.failure',
    category: 'system',
    re: /\b(?:request failed|failed this turn|please try again|is not ready yet|will retry once|something went wrong|an error occurred|unable to reach)\b/i,
  },
  {
    // The agent's own notices in German, French and Spanish (agentNotices.ts in
    // the agent). None of these words is English, so this cannot change what
    // the measured English rules decide; it only keeps a translated failure
    // out of a category that could silence it.
    id: 'system.failure.intl',
    category: 'system',
    re: /(?:fehlgeschlagen|schiefgelaufen|noch nicht bereit|nicht verfügbar|abgelehnt|a échoué|un problème est survenu|réessay|pas encore prête|indisponible|refusée|ha fallado|salió mal|inténtelo de nuevo|lo intento de nuevo|todavía no está lista|no está disponible|rechazada)/i,
  },
  {
    id: 'nav.transition',
    category: 'nav',
    re: new RegExp(
      '^' +
        PRONOUN +
        '(?:moving\\s+(?:on(?:ward)?|ahead|forward|toward(?:s)?|to|back)\\b|going\\s+back|stepping\\s+back|' +
        'heading\\s+back|taking\\s+you\\s+back|back\\s+to|continuing\\s+(?:to|back|with|on)|' +
        'proceeding\\s+(?:to|with)|next\\s+up|on\\s+to|confirming\\s+your\\s+booking|' +
        'submitting\\s+your\\s+booking|finalizing\\s+your\\s+booking|placing\\s+your\\s+booking)' +
        // `\\b` matters: the group ends in an optional-width tail, so without it
        // "Moving onward" matches "moving on" and the prefix slice lands
        // mid-word ("Ward to seats.").
        '\\b' +
        // Swallow trailing link words so `brief` lands on the object:
        // "Moving on to showtimes." -> "Showtimes."
        LINK_WORDS +
        // Trailing separator belongs to the prefix as well, or the object is
        // spoken with the punctuation still attached: ", showtimes."
        '[\\s,;:\u2014-]*',
      'i'
    ),
  },
  {
    // "Saturday is set. Moving to showtimes." — the transition is the payload.
    id: 'nav.settled',
    category: 'nav',
    re: new RegExp(
      "^[^.?!]{1,60}\\b(?:is|are)\\s+(?:set|selected|locked\\s+in|confirmed)\\b[\\s,.—-]*" +
        "(?:so\\s+)?(?:i(?:'|’)?ll\\s+)?(?:moving|going|continuing|proceeding|on\\s+to|next)" +
        // The same tail as `nav.transition`. Without it the prefix stopped at
        // the verb and `brief` spoke "To showtimes." / "Up, showtimes."
        "\\b" +
        LINK_WORDS +
        "[\\s,;:\u2014-]*",
      'i'
    ),
  },
  {
    id: 'select.verb',
    category: 'select',
    re: new RegExp(
      '^' +
        PRONOUN +
        '(?:select(?:ing)?|choos(?:e|ing)|going\\s+with|picking|switching\\s+to|' +
        // "Keeping Picture Shack" is a choice; "Keeping only the 6 p.m. shows"
        // is a filter, and view.change below claims it.
        'locking\\s+in|using|keeping(?!\\s+(?:only|just)))\\s+',
      'i'
    ),
  },
  {
    id: 'view.change',
    category: 'view',
    re: new RegExp(
      '^' +
        PRONOUN +
        '(?:highlight(?:ing)?|show(?:ing)?|surfac(?:e|ing)|sort(?:ing)?|order(?:ing)?|' +
        'putting|narrowing|filter(?:ing)?|keeping\\s+(?:only|just)|apply(?:ing)?|' +
        'add(?:ing)?|resett(?:ing)?|updat(?:ing)?|bringing\\s+back|clear(?:ing)?|' +
        'display(?:ing)?|listing|ranking)' +
        // "Narrowing to IMAX showtimes." stopped after the verb without this.
        LINK_WORDS +
        '\\s+',
      'i'
    ),
  },
];

/**
 * Korean rules, and why they look nothing like the English ones.
 *
 * Korean puts the verb last, so there is no leading verb phrase to anchor on
 * and none to strip — these are end-anchored and always report a
 * `verbPrefixLength` of 0, which sends `shortenForBrief` down its
 * first-sentence path instead of its strip-the-prefix path.
 *
 * They are also, unlike the English set, **unmeasured**. The 97.1% above comes
 * from replaying 4,749 recorded English utterances; there is no Korean corpus
 * to replay. So this set is deliberately narrow — specific sentence-final verbs
 * only, and nothing built on the bare `할게요`, which ends a selection
 * ("11월 5일로 할게요") and a view change ("정렬할게요") alike. Anything they do
 * not recognise falls through to `respond` and is spoken in full.
 *
 * In practice the agent now tags `agent.message` with the tool it narrates, so
 * these run only for messages that arrive untagged.
 */
const KO_RULES: Rule[] = [
  {
    id: 'system.failure.ko',
    category: 'system',
    // The tail after `연결할 수 없` covers the agent's own Korean notices
    // (agentNotices.ts) that carry none of the earlier phrases.
    re: /(?:실패했|오류가 (?:발생|생겼)|문제가 발생|다시 시도|준비되지 않았|아직 준비가|연결할 수 없|해석하지 못했|확인하지 못했|거부되|맞는 선택지가 없)/,
  },
  {
    id: 'nav.transition.ko',
    category: 'nav',
    re: /(?:넘어가|이동하|돌아가|진행하|넘어갈|이동할|돌아갈|진행할)(?:겠|게|요|ㅂ니다|습니다|ㄹ게요)?[^.!?]*[.!?]?\s*$/,
  },
  {
    id: 'select.verb.ko',
    category: 'select',
    re: /(?:선택하|선택할|선택했|고를|골랐|정할|정했|선택해)(?:겠|게|요|ㅂ니다|습니다|ㄹ게요)?[^.!?]*[.!?]?\s*$/,
  },
  {
    id: 'view.change.ko',
    category: 'view',
    re: /(?:정렬하|정렬할|강조하|강조할|걸러|거를|남길|남기|표시하|표시할|보여드릴|보여줄|해제하|해제할|초기화하|초기화할|적용하|적용할|추가하|추가할)(?:겠|게|요|ㅂ니다|습니다|ㄹ게요)?[^.!?]*[.!?]?\s*$/,
  },
];

/** Any Hangul syllable or jamo means the utterance is Korean, not English. */
const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;

/**
 * Korean asks with a sentence ending, not with punctuation, and the planner
 * does not always write the question mark. `hasQuestion` tested for a literal
 * "?" and nothing else, so "어느 좌석을 선택하시겠어요" was classified `select`,
 * silenced by `balanced`, and the question floor — the guarantee that makes an
 * aggressive preset safe — never fired. The participant is asked something and
 * hears nothing.
 *
 * The safety direction is the opposite of `KO_RULES` above, and that is why
 * this set is generous where those are narrow. Calling a statement a question
 * costs spoken words: the utterance is floored at `brief`, and `brief` on a
 * Korean question returns it whole. Missing a real one silences it.
 *
 * Still unmeasured, like everything Korean here — there is no Korean corpus to
 * replay.
 */
const KO_QUESTION_ENDING =
  /(?:습니까|ㅂ니까|입니까|나요|까요|시겠어요|실래요)(?=[\s.!?"'\u201d\u2019)\]]|$)/;

/**
 * The productive `-(으)ㄴ가요` / `-는가요` ending: 좋은가요, 맞는가요, 아닌가요,
 * 괜찮으신가요. Its surface form depends on the stem, so a character class
 * cannot spell it — what every form shares is a syllable whose final consonant
 * is ㄴ immediately before "가요", and that is a property of the code point.
 * (Jongseong index 4 of the 28; bare "가요" without it is the verb "go".)
 */
function hasNGayoEnding(text: string): boolean {
  for (let i = 1; i + 1 < text.length; i += 1) {
    if (text[i] !== '가' || text[i + 1] !== '요') continue;
    const code = text.charCodeAt(i - 1);
    if (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 4) return true;
  }
  return false;
}
/**
 * An interrogative word is ambiguous alone — "어떤 조건이든 맞춰드릴게요" is a
 * statement — so it counts only together with a polite sentence ending, which
 * is what "몇 시가 좋으세요" has and the statement above also has. Erring
 * here is the cheap direction.
 */
const KO_QUESTION_WORD =
  /(?:^|[\s"'(\[])(?:어느|어떤|무슨|무엇|언제|어디|누구|왜|어떻게|몇)/;
const KO_POLITE_END = /(?:요|까|니다)[.!]?\s*$/;

function hasKoreanQuestion(text: string): boolean {
  if (KO_QUESTION_ENDING.test(text) || hasNGayoEnding(text)) return true;
  return KO_QUESTION_WORD.test(text) && KO_POLITE_END.test(text);
}

/** Kana or Han without Hangul: Japanese or Chinese. */
const KANA_OR_HAN = /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿]/;

/**
 * Japanese and Chinese ask with a sentence-final particle as often as with a
 * question mark: か (ですか, ますか, でしょうか, かな) in Japanese, 吗/嗎/呢 in
 * Chinese. The particle counts when it ends a sentence — followed by sentence
 * punctuation, a closing quote or bracket, or the end of the text.
 *
 * Generous on purpose, for the reason the Korean test is: calling a statement a
 * question costs a few spoken words; missing a question silences it. UNMEASURED
 * — there is no Japanese or Chinese corpus to replay.
 */
const CJK_QUESTION_ENDING =
  /(?:か(?:な|ね)?|[吗嗎呢])(?=[。．.！!？?」』"'”’）)\]]|$)/;

/** A sentence that asks something, by its punctuation or a CJK question particle. */
export function sentenceAsksQuestion(sentence: string): boolean {
  const trimmed = sentence.trim();
  // Exactly the English test it replaces, plus the full-width mark.
  if (trimmed.endsWith('?') || trimmed.endsWith('？')) return true;
  if (!KANA_OR_HAN.test(trimmed) || HANGUL.test(trimmed)) return false;
  // A Japanese or Chinese sentence may close a quote or bracket after its mark.
  return /[?？]["'”’）)\]」』]*$/.test(trimmed) || CJK_QUESTION_ENDING.test(trimmed);
}

/**
 * The agent's own failure notices in Japanese and Chinese (agentNotices.ts in
 * the agent). Messages it sends as failures are tagged `system` already; this
 * is the fallback for one that arrives untagged.
 */
const CJK_FAILURE =
  /(?:失敗し|失败|失敗|問題が発生|準備ができていません|準備できていません|利用できません|拒否され|処理できません|照合できません|選択肢はありません|出了点问题|出了點問題|尚未就绪|尚未就緒|不可用|無法使用|被拒绝|遭到拒絕|没能解析|沒能解析|无法验证|無法驗證|(?:无法|無法)[^。！？]{0,20}(?:验证|驗證)|没有选项符合|沒有選項符合)/;

export function classifyUtterance(text: string): UtteranceClassification {
  const trimmed = text.trim();
  const isKorean = HANGUL.test(trimmed);
  const isCjk = !isKorean && KANA_OR_HAN.test(trimmed);
  const hasQuestion =
    trimmed.includes('?') ||
    trimmed.includes('？') ||
    (isKorean && hasKoreanQuestion(trimmed)) ||
    (isCjk && CJK_QUESTION_ENDING.test(trimmed));

  if (isCjk) {
    // No Japanese or Chinese narration rules exist: the agent tags its
    // messages, and an untagged one is spoken in full as conversation. Only a
    // failure is recognised, because that is the one thing that must never be
    // routed somewhere it could be silenced.
    if (CJK_FAILURE.test(trimmed)) {
      return { category: 'system', matchedRule: 'system.failure.cjk', hasQuestion, verbPrefixLength: 0 };
    }
    return { category: 'respond', matchedRule: null, hasQuestion, verbPrefixLength: 0 };
  }

  if (isKorean) {
    for (const rule of KO_RULES) {
      if (rule.re.test(trimmed)) {
        // No prefix to strip: the verb these matched is at the end.
        return {
          category: rule.category,
          matchedRule: rule.id,
          hasQuestion,
          verbPrefixLength: 0,
        };
      }
    }
    return { category: 'respond', matchedRule: null, hasQuestion, verbPrefixLength: 0 };
  }

  const leadIn = LEAD_IN.exec(trimmed);
  const leadLength = leadIn ? leadIn[0].length : 0;
  const body = trimmed.slice(leadLength);

  for (const rule of RULES) {
    const match = rule.re.exec(body);
    if (match) {
      return {
        category: rule.category,
        matchedRule: rule.id,
        hasQuestion,
        verbPrefixLength: leadLength + match[0].length,
      };
    }
  }

  // Anything unrecognised is treated as conversation — the one category that is
  // never silenced. Erring here costs spoken words, not comprehension.
  return { category: 'respond', matchedRule: null, hasQuestion, verbPrefixLength: 0 };
}
