/**
 * Executable check for the booth's two chain shortcuts (core/autoNext.ts):
 *
 *   npx tsx apps/tuning-agent/src/core/autoNext.check.ts
 *
 * `decideAutoNext` — when the runtime runs `next` itself after a select instead
 * of spending a planner call on it — and `isPurePick` — which utterances the
 * first planner call need not wait for the extractor on. Made-up utterances in
 * the shapes of the KSEA cards and walk-through; no participant words.
 *
 * Exit code 0 means every case passed.
 */
import { asksQuestion, decideAutoNext, isPurePick, readRuleTag, type AutoNextInput } from './autoNext';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const BASE: AutoNextInput = {
  demo: true,
  stage: 'movie',
  stageNow: 'movie',
  toolName: 'select',
  ok: true,
  reason: '[named-option] The visitor named Klara and the Sun, which is on screen.',
  assistantMessage: '',
  userTurn: true,
  agreementTurn: false,
  nextOffered: true,
  suppressNavigation: false,
  backtrackActive: false,
  prevInTurn: false,
  selectedId: 'm2',
  selectedListCount: 0,
};

function runs(overrides: Partial<AutoNextInput>): boolean {
  return decideAutoNext({ ...BASE, ...overrides }).run;
}
function why(overrides: Partial<AutoNextInput>): string {
  const decision = decideAutoNext({ ...BASE, ...overrides });
  return decision.run ? 'run' : decision.why;
}

console.log('decideAutoNext: the commits that advance');
check('[named-option] select, empty sentence → next', runs({}));
{
  const decision = decideAutoNext(BASE);
  check(
    'the synthetic reason opens with the same rule tag, like a planned next',
    decision.run && readRuleTag(decision.reason) === 'named-option',
    decision.run ? decision.reason : decision.why
  );
}
check(
  '[single-viable] with its one-sentence statement → next',
  runs({ reason: '[single-viable] Only one horror film.', assistantMessage: 'Clayface가 유일한 공포 영화라 골랐어요.' })
);
check(
  '[superlative] → next',
  runs({ stage: 'theater', stageNow: 'theater', reason: '[superlative] Closest theater.', assistantMessage: 'Cinema Detroit가 가장 가까워요.' })
);
check(
  'seat selectMultiple [named-option] with seats selected → next',
  runs({ stage: 'seat', stageNow: 'seat', toolName: 'selectMultiple', selectedId: null, selectedListCount: 2 })
);
check(
  '[other] on an agreement turn (accepted recommendation) → next',
  runs({ stage: 'seat', stageNow: 'seat', toolName: 'selectMultiple', reason: '[other] Accepts C4.', agreementTurn: true, selectedId: null, selectedListCount: 1 })
);
check(
  '[seat-recommend] on a delegation ("추천해 주시는 자리로") → next',
  runs({ stage: 'seat', stageNow: 'seat', toolName: 'selectMultiple', reason: '[seat-recommend] Delegated.', assistantMessage: 'C4와 C5를 추천해요.', selectedId: null, selectedListCount: 2 })
);
check('[seat-recommend] off the seat stage is not a commit', why({ reason: '[seat-recommend] ?' }) === 'not-committed:seat-recommend');
check('date-entry select ("Tonight, then.") → next', runs({ stage: 'date', stageNow: 'date', assistantMessage: '오늘로 할게요.' }));

console.log('decideAutoNext: where next must not follow');
check('study session never', why({ demo: false }) === 'not-demo');
check('confirm stage: a next there books', why({ stage: 'confirm', stageNow: 'confirm' }) === 'confirm-stage');
check('a select paired with a question waits', why({ assistantMessage: 'Cinema Detroit로 할까요?' }) === 'select-asks-question');
check('…full-width question mark too', why({ assistantMessage: '这家可以吗？' }) === 'select-asks-question');
check('pending backtrack continuation / conflict', why({ backtrackActive: true }) === 'backtrack-pending');
check('suppressNavigationToolsOnce', why({ suppressNavigation: true }) === 'navigation-suppressed');
check('a prev-driven flow', why({ prevInTurn: true }) === 'prev-in-turn');
check('host does not offer next', why({ nextOffered: false }) === 'next-not-offered');
check('proceed rule unmet (selection toggled off)', why({ selectedId: null }) === 'proceed-rule-unmet');
check(
  'seat: a toggle that left no seat selected',
  why({ stage: 'seat', stageNow: 'seat', selectedId: null, selectedListCount: 0 }) === 'proceed-rule-unmet'
);
check('[other] without an agreement', why({ reason: '[other] Seems best.' }) === 'not-committed:other');
check('[answer] — a question turn never commits', why({ reason: '[answer] Clayface is the horror film.' }) === 'not-committed:answer');
check('[ask-multiple]', why({ reason: '[ask-multiple] Two remain.' }) === 'not-committed:ask-multiple');
check('untagged reason', why({ reason: 'User chose it.' }) === 'not-committed:untagged');
check('not a select', why({ toolName: 'highlight' }) === 'not-select');
check('select rejected by the host', why({ ok: false }) === 'select-failed');
check('no visitor turn open (a tap, a hand edit)', why({ userTurn: false }) === 'no-user-turn');
check('stage moved under the select', why({ stageNow: 'theater' }) === 'stage-moved');
check('asksQuestion: statement', !asksQuestion('오늘로 할게요.'));

console.log('isPurePick: nothing for the extractor');
for (const text of [
  '네',
  '네.',
  '넵!',
  '네, 좋아요.',
  '그걸로 할게요.',
  '네, 그걸로 할게요.',
  '첫 번째 걸로',
  '첫 번째 걸로 할게요.',
  '상관없어요, 첫 번째 걸로 할게요.',
  '네 번째 거요',
  '마지막 걸로 해 주세요',
  '오케이',
  '좋아요',
  '거기로 할게요',
  'yes',
  'Yes please.',
  'yeah, that one',
  'that one',
  'the first one',
  "I'll take the second one.",
  "Let's go with that.",
  'okay',
  "doesn't matter, the first one",
]) {
  check(`pure pick: ${text}`, isPurePick(text));
}

console.log('isPurePick: extraction first, as before');
for (const text of [
  '',
  '네?',
  '아니요',
  '아니요, 다른 거요',
  '8시 이후로 할게요.',
  '15마일 넘는 데는 안 돼요.',
  '오늘 밤에 클라라와 태양 보고 싶어요.',
  '상관없어요',
  '목요일로 할게요.',
  'IMAX로 할게요',
  '응 그거 말고',
  '가운데쯤으로 할게요',
  '두 자리요',
  'no',
  'not that one',
  "doesn't matter",
  'the cheapest one',
  'yes but closer to downtown',
  '7:40 works',
  'D1 and D2',
  'take',
]) {
  check(`not a pure pick: ${JSON.stringify(text)}`, !isPurePick(text));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall autoNext checks passed');
