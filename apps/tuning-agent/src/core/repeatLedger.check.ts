/**
 * Executable check for the booth's cross-turn repeat ledger:
 *
 *   npx tsx apps/tuning-agent/src/core/repeatLedger.check.ts
 *
 * The shapes are the KSEA poster session's (Round 3 of
 * docs/scenarios/ksea2026-korean-simulation.md), with the agent's own sentences
 * and made-up visitor fragments; no participant words. `noiseRepeat.regress.ts`
 * runs the same ledger over the real logged sequences.
 *
 * Exit code 0 means every case passed.
 */
import {
  asksAboutHidden,
  createStageRepeatLedger,
  hiddenCountKey,
  isBareAgreement,
  isClosedQuestion,
  isHiddenCountSentence,
  isNearRepeat,
  repeatSimilarity,
  splitSentences,
} from './repeatLedger';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const READ_BACK = 'Klara and the Sun, Cinema Detroit, 오늘 9:30 PM, C4 좌석으로 총 $12.00예요. 예약을 확정할까요?';
const TIME_Q = '어느 시간으로 할까요?';
const HIDDEN_FILTER_STEP = '오후 10시 이전 종료 조건으로 4개 상영을 숨겼어요.';
const HIDDEN_RESPOND = '오후 10시 이전 종료 조건 때문에 4개 상영이 숨겨져 있어요. 3D 상영 중 어느 시간으로 할까요?';

const quiet = { nothingNew: false, askedAboutHidden: false, keepIfEmptied: false };

console.log('\n1. text helpers');
{
  check('a price keeps its decimal point', splitSentences(READ_BACK).length === 2 && splitSentences(READ_BACK)[0].endsWith('$12.00예요.'));
  check('a time keeps its colon', splitSentences('9:30 PM로 할까요?').length === 1);
  check('identical text is similarity 1', repeatSimilarity(TIME_Q, '어느 시간으로 할까요?') === 1);
  check('punctuation and spacing do not count', isNearRepeat('어느 시간으로 할까요', '어느  시간으로 할까요?!'));
  check('a different question is not a near repeat', !isNearRepeat(TIME_Q, '어느 좌석으로 할까요?'), String(repeatSimilarity(TIME_Q, '어느 좌석으로 할까요?')));
  check('a read-back minus its question is not a near repeat of the whole', !isNearRepeat(READ_BACK, '예약을 확정할까요?'));
  check('Korean hidden-count sentences are found', isHiddenCountSentence(HIDDEN_FILTER_STEP) && isHiddenCountSentence(splitSentences(HIDDEN_RESPOND)[0]));
  check('the question after it is not one', !isHiddenCountSentence(splitSentences(HIDDEN_RESPOND)[1]));
  check('two wordings of one count share a key', hiddenCountKey(HIDDEN_FILTER_STEP) === '4' && hiddenCountKey(splitSentences(HIDDEN_RESPOND)[0]) === '4');
  check('the requirement\'s own number is not the count', hiddenCountKey('15마일 조건 때문에 1곳이 숨겨져 있어요.') === '1');
  check('English counts in words are keyed too', hiddenCountKey('Four showtimes are hidden by your 10 PM limit.') === '4', hiddenCountKey('Four showtimes are hidden by your 10 PM limit.'));
  check('English digits on a noun', hiddenCountKey('Your 15-mile limit is hiding 2 theaters.') === '2');
  check('a Korean native count is keyed', hiddenCountKey('세 편이 숨겨져 있어요.') === '3');
  check('an open question is not closed', !isClosedQuestion(TIME_Q) && !isClosedQuestion('토요일과 일요일 중 어느 날로 할까요?'));
  check('a yes/no question is closed', isClosedQuestion('Cinema Detroit로 할까요?') && isClosedQuestion('예약을 확정할까요?') && isClosedQuestion('Would you like Clayface?'));
  check('a statement is not a question', !isClosedQuestion('C4를 추천해요.'));
}

console.log('\n2. agreements and questions about what is hidden');
{
  for (const text of ['네.', '네, 좋아요.', '그걸로 할게요.', '거기로 해 줘.', '7시 40분으로 해 줘.', '좋습니다.', 'yes', 'Sounds good.', 'That one, please.', 'はい', '好的']) {
    check(`agreement: ${text}`, isBareAgreement(text));
  }
  for (const text of ['저기 그게...', '이걸', '응?', '와 신기하다', '아 잠깐만요 이거 뭐예요', 'what?', 'Clayface · R.']) {
    check(`not an agreement: ${text}`, !isBareAgreement(text));
  }
  check('"다른 시간은 없어요?" asks about hidden options', asksAboutHidden('다른 시간은 없어요?'));
  check('"what else is there?" too', asksAboutHidden('what else is there?'));
  check('"네." does not', !asksAboutHidden('네.'));
}

console.log('\n3. the confirm read-back is not read again to noise (the 9b9d4210 shape)');
{
  const ledger = createStageRepeatLedger();
  ledger.beginTurn();
  const first = ledger.filter({ stage: 'confirm', text: READ_BACK, ...quiet });
  check('the read-back on entering the stage is said', first.text === READ_BACK);
  ledger.noteSpoken('confirm', first.text);
  let spoken = 0;
  for (const text of [READ_BACK, 'Klara and the Sun, Cinema Detroit, 오늘 9:30 PM, C4 좌석으로 총 $12.00예요.', '예약을 확정할까요?', READ_BACK, READ_BACK, READ_BACK, READ_BACK, READ_BACK]) {
    ledger.beginTurn();
    const result = ledger.filter({ stage: 'confirm', text, nothingNew: true, askedAboutHidden: false, keepIfEmptied: false });
    if (result.text) spoken += 1;
    check(`noise turn: "${text.slice(0, 24)}…" is silenced`, result.silenced && result.droppedRepeats.length > 0);
    ledger.noteSpoken('confirm', result.text);
  }
  check('eight noise turns, nothing re-read', spoken === 0);
  ledger.beginTurn();
  const yes = ledger.filter({ stage: 'confirm', text: READ_BACK, nothingNew: true, agreement: true, askedAboutHidden: false, keepIfEmptied: false });
  check('after a "네" the yes/no question survives (the planner failed to book; say so)', yes.text === '예약을 확정할까요?', yes.text);
  ledger.beginTurn();
  const changed = ledger.filter({ stage: 'confirm', text: READ_BACK, ...quiet });
  check('a turn that changed memory is not filtered by rule 1', changed.text === READ_BACK);
}

console.log('\n4. the stage question is not asked again to noise (open question)');
{
  const ledger = createStageRepeatLedger();
  ledger.noteSpoken('time', TIME_Q);
  ledger.beginTurn();
  const noise = ledger.filter({ stage: 'time', text: TIME_Q, nothingNew: true, askedAboutHidden: false, keepIfEmptied: false });
  check('noise: silent', noise.silenced);
  ledger.beginTurn();
  const yes = ledger.filter({ stage: 'time', text: TIME_Q, nothingNew: true, agreement: true, askedAboutHidden: false, keepIfEmptied: false });
  check('a "네" to an open question agrees to nothing: silent too', yes.silenced);
  ledger.beginTurn();
  const mixed = ledger.filter({ stage: 'time', text: `9:30 PM이 마지막 상영이에요. ${TIME_Q}`, nothingNew: true, askedAboutHidden: false, keepIfEmptied: false });
  check('a new sentence survives; only the repeated question goes', mixed.text === '9:30 PM이 마지막 상영이에요.', mixed.text);
  const other = createStageRepeatLedger();
  other.noteSpoken('time', TIME_Q);
  const moved = other.filter({ stage: 'seat', text: '어느 좌석으로 할까요?', nothingNew: true, askedAboutHidden: false, keepIfEmptied: false });
  check('a new stage starts empty: its question is said', moved.text === '어느 좌석으로 할까요?' && other.stage() === 'seat');
  other.noteSpoken('seat', moved.text);
  other.clear('stage-change');
  check('clear() empties it', other.spokenSentences().length === 0 && other.stage() === null);
}

console.log('\n5. the hidden count, said once (the dc803c81 shape)');
{
  const ledger = createStageRepeatLedger();
  ledger.noteFilterChanged();
  const step = ledger.filter({ stage: 'time', text: HIDDEN_FILTER_STEP, ...quiet });
  check('the filter step states the count', step.text === HIDDEN_FILTER_STEP);
  ledger.noteSpoken('time', step.text);
  const respond = ledger.filter({ stage: 'time', text: HIDDEN_RESPOND, ...quiet });
  check('the respond after it, in another wording, loses the count and keeps the question', respond.text === '3D 상영 중 어느 시간으로 할까요?' && respond.droppedHidden.length === 1, respond.text);
  ledger.noteSpoken('time', respond.text);
  ledger.beginTurn();
  const nextTurn = ledger.filter({ stage: 'time', text: '오후 10시 이전 종료 조건 때문에 4개 상영이 숨겨져 있어요. 6:20 PM 3D로 할까요?', ...quiet });
  check('a later turn that changed memory still loses the restated count', nextTurn.text === '6:20 PM 3D로 할까요?', nextTurn.text);
  ledger.beginTurn();
  const asked = ledger.filter({ stage: 'time', text: HIDDEN_RESPOND, nothingNew: false, askedAboutHidden: true, keepIfEmptied: false });
  check('when the visitor asks what is hidden, it is said', asked.text === HIDDEN_RESPOND);
  const twice = createStageRepeatLedger().filter({ stage: 'movie', text: '3개 옵션을 숨겼어요. 3개 옵션은 PG 조건 때문에 숨겨져 있어요. 어떤 영화를 볼까요?', ...quiet });
  check('twice in one message is once', twice.text === '3개 옵션을 숨겼어요. 어떤 영화를 볼까요?', twice.text);
  ledger.noteFilterChanged();
  ledger.beginTurn();
  const changed = ledger.filter({ stage: 'time', text: '오후 9시 이후 시작 조건까지 더해 5개 상영이 숨겨져 있어요.', ...quiet });
  check('after a filter change the count may be said again', changed.droppedHidden.length === 0);
  ledger.noteSpoken('time', changed.text);
  ledger.beginTurn();
  const onlyHidden = ledger.filter({ stage: 'time', text: '오후 9시 이후 시작 조건으로 5개 상영이 숨겨져 있어요.', nothingNew: false, askedAboutHidden: false, keepIfEmptied: true });
  check('a turn that changed something is not ended in silence by the count rule alone', onlyHidden.text.length > 0 && !onlyHidden.silenced);
}

console.log('\n5b. within one visitor turn a sentence is said once (card A, live)');
{
  const ledger = createStageRepeatLedger();
  ledger.beginTurn();
  ledger.noteFilterChanged();
  const step = ledger.filter({ stage: 'theater', text: '15마일 이내 조건으로 1곳을 숨겼어요. 어느 곳으로 할까요?', ...quiet });
  ledger.noteSpoken('theater', step.text);
  const respond = ledger.filter({ stage: 'theater', text: '어느 곳으로 할까요?', nothingNew: false, askedAboutHidden: false, keepIfEmptied: false });
  check('the respond after the filter step does not ask the same question again', respond.silenced, respond.text);
  ledger.beginTurn();
  const nextTurn = ledger.filter({ stage: 'theater', text: '어느 곳으로 할까요?', ...quiet });
  check('a turn that changed something may ask it again', nextTurn.text === '어느 곳으로 할까요?');
}

console.log('\n6. off the booth path nothing changes: a fresh ledger with nothing new passes text through');
{
  const ledger = createStageRepeatLedger();
  for (const text of [TIME_Q, READ_BACK, HIDDEN_RESPOND]) {
    const result = ledger.filter({ stage: 'time', text, ...quiet });
    check(`unchanged: "${text.slice(0, 20)}…"`, result.text === text && !result.silenced);
  }
  check('empty in, empty out, not "silenced"', !ledger.filter({ stage: 'time', text: '  ', nothingNew: true, askedAboutHidden: false, keepIfEmptied: false }).silenced);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall repeat-ledger checks passed');
