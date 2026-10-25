/**
 * Executable check for the empty-respond guard (booth demo only). No API:
 * the planner is a stub, so this drives the whole path, re-plan and fallback
 * included.
 *
 *   npx tsx apps/tuning-agent/src/core/emptyRespond.check.ts
 *
 * Section 1 replays the C1v turn from the 2026-10-24 KSEA simulation: "첫 번째
 * 걸로 할게요." answered with respond + "" (planner-8 of
 * demo-st_3a7e79b6…-20261024-102843), which left the visitor in silence for 90 s.
 */
import { chainOpenedByUserUtterance } from './planner';
import {
  EMPTY_RESPOND_NOTE_REASON,
  decideEmptyRespond,
  planWithEmptyRespondGuard,
  stageQuestion,
  stageQuestionLanguages,
  withEmptyRespondNote,
} from './emptyRespond';
import { SUPPORTED_CONVERSATION_LANGUAGES } from '../llm/llmPlanner';
import type { PerceivedContext, PlanDecision } from '../types';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** The C1v movie-stage history at planner-8, trimmed to what matters. */
function c1vContext(): PerceivedContext {
  return {
    sessionId: 'st_c1v',
    stage: 'movie',
    uiSpec: { stage: 'movie', items: [], visibleItems: [] },
    messageHistoryTail: [
      { type: 'agent', stage: 'movie', text: '어떤 영화를 보고 싶으세요?' },
      { type: 'user', stage: 'movie', action: 'input', label: 'PG 이하여야 하고, 짧을수록 좋아요.' },
      { type: 'system', stage: 'movie', annotation: { kind: 'tool-modification', toolName: 'sort', source: 'agent' } },
      { type: 'agent', stage: 'movie', text: 'PG 조건 때문에 다른 영화 3편은 숨겨져 있어요. 어떤 영화를 볼까요?' },
      { type: 'user', stage: 'movie', action: 'input', label: '첫 번째 걸로 할게요.' },
    ],
    toolSchema: [],
    plannerCpMemoryLimit: 6,
    guiAdaptationEnabled: true,
    narrateAdaptations: false,
    spokenBrevity: true,
    lastUserMessage: { text: '첫 번째 걸로 할게요.', stage: 'movie' } as PerceivedContext['lastUserMessage'],
    lastUpdatedAt: '2026-10-24T14:29:18.070Z',
  };
}

const EMPTY_RESPOND: PlanDecision = {
  action: null,
  explainText: '',
  source: 'llm',
};
const SELECT_M3: PlanDecision = {
  action: { type: 'tool.call', reason: '[named-option]', payload: { toolName: 'select', params: { itemId: 'm3' } } },
  explainText: '',
  source: 'llm',
};
const ASKS: PlanDecision = { action: null, explainText: '어느 영화로 할까요?', source: 'llm' };

/** A planner stub that answers from a script and records what it was shown. */
function scripted(answers: PlanDecision[]) {
  const seen: PerceivedContext[] = [];
  return {
    seen,
    plan: async (context: PerceivedContext) => {
      seen.push(context);
      return answers[Math.min(seen.length - 1, answers.length - 1)];
    },
  };
}

function lastEntry(context: PerceivedContext): Record<string, unknown> {
  return context.messageHistoryTail.at(-1) as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log('\n1. C1v: an empty respond after "첫 번째 걸로 할게요." is planned again, with the note');
  {
    const context = c1vContext();
    const before = JSON.stringify(context);
    const planner = scripted([EMPTY_RESPOND, SELECT_M3]);
    const result = await planWithEmptyRespondGuard(context, planner.plan, {
      enabled: true,
      userTurnAwaitingAnswer: true,
      language: 'ko',
    });
    check('the planner was called twice', planner.seen.length === 2, String(planner.seen.length));
    check('the second call carries the note as its newest history entry', (lastEntry(planner.seen[1]).annotation as Record<string, unknown>)?.reason === EMPTY_RESPOND_NOTE_REASON);
    check('the note is a system entry on the current stage', lastEntry(planner.seen[1]).type === 'system' && lastEntry(planner.seen[1]).stage === 'movie');
    check('the first call saw the history unchanged', lastEntry(planner.seen[0]).label === '첫 번째 걸로 할게요.');
    check('the live context is not modified', JSON.stringify(context) === before);
    check('the re-plan\'s select is what runs', result.decision === SELECT_M3 && result.replanned && result.fallbackText === '');
    check(
      'the visitor\'s utterance still opens the chain, so select stays offered after a GUI step',
      chainOpenedByUserUtterance(planner.seen[1].messageHistoryTail, 'movie') ===
        chainOpenedByUserUtterance(context.messageHistoryTail, 'movie') &&
        chainOpenedByUserUtterance(planner.seen[1].messageHistoryTail, 'movie') === true
    );
  }

  console.log('\n2. empty twice: the stage question, in the session language');
  {
    const planner = scripted([EMPTY_RESPOND, EMPTY_RESPOND]);
    const result = await planWithEmptyRespondGuard(c1vContext(), planner.plan, {
      enabled: true,
      userTurnAwaitingAnswer: true,
      language: 'ko',
    });
    check('planned exactly twice, not more', planner.seen.length === 2);
    check('falls back to the Korean movie question', result.fallbackText === '어떤 영화를 보고 싶으세요?', result.fallbackText);
    check('never the English tool fallback', !/I will run/.test(result.fallbackText));
    const en = await planWithEmptyRespondGuard({ ...c1vContext(), stage: 'seat' }, scripted([EMPTY_RESPOND]).plan, {
      enabled: true,
      userTurnAwaitingAnswer: true,
      language: 'en',
    });
    check('English seat stage: the English seat question', en.fallbackText === 'Which seats would you like?', en.fallbackText);
  }

  console.log('\n3. a re-plan that speaks is used as it is');
  {
    const planner = scripted([EMPTY_RESPOND, ASKS]);
    const result = await planWithEmptyRespondGuard(c1vContext(), planner.plan, {
      enabled: true,
      userTurnAwaitingAnswer: true,
      language: 'ko',
    });
    check('its question, no fallback', result.decision === ASKS && result.fallbackText === '');
  }

  console.log('\n4. left alone');
  {
    for (const [label, options, answer] of [
      ['a study session (enabled: false)', { enabled: false, userTurnAwaitingAnswer: true }, EMPTY_RESPOND],
      ['the visitor already heard something this turn', { enabled: true, userTurnAwaitingAnswer: false }, EMPTY_RESPOND],
      ['a respond with text', { enabled: true, userTurnAwaitingAnswer: true }, ASKS],
      ['a tool call with an empty message (a brevity GUI step)', { enabled: true, userTurnAwaitingAnswer: true }, SELECT_M3],
      ['a rule decision (no session, no key)', { enabled: true, userTurnAwaitingAnswer: true }, { action: null, source: 'rule', fallbackReason: 'NO_SESSION' } as PlanDecision],
    ] as const) {
      const planner = scripted([answer]);
      const result = await planWithEmptyRespondGuard(c1vContext(), planner.plan, { ...options, language: 'ko' });
      check(`${label}: one call, decision untouched, no fallback`, planner.seen.length === 1 && result.decision === answer && result.fallbackText === '' && !result.replanned);
    }
    check(
      'whitespace counts as empty',
      decideEmptyRespond({ enabled: true, decision: { action: null, explainText: '  ', source: 'llm' }, userTurnAwaitingAnswer: true, replanned: false, stage: 'movie' }).kind === 'replan'
    );
  }

  console.log('\n4b. a silence the repeat ledger chose is deliberate (KSEA poster session, Round 3)');
  {
    const planner = scripted([EMPTY_RESPOND, ASKS]);
    const result = await planWithEmptyRespondGuard(c1vContext(), planner.plan, {
      enabled: true,
      userTurnAwaitingAnswer: true,
      language: 'ko',
      deliberateSilence: true,
    });
    check('one call, the empty respond accepted, no stage-question fallback', planner.seen.length === 1 && result.decision === EMPTY_RESPOND && result.fallbackText === '' && !result.replanned);
    check(
      'without the flag the same respond is still re-planned',
      decideEmptyRespond({ enabled: true, decision: EMPTY_RESPOND, userTurnAwaitingAnswer: true, replanned: false, stage: 'time', deliberateSilence: false }).kind === 'replan'
    );
  }

  console.log('\n5. a stage question for every stage, in every supported language');
  {
    const languages = new Set(stageQuestionLanguages());
    check(
      'every conversation language the planner accepts has its own table',
      SUPPORTED_CONVERSATION_LANGUAGES.every((language) => languages.has(language)),
      SUPPORTED_CONVERSATION_LANGUAGES.filter((language) => !languages.has(language)).join(', ')
    );
    for (const language of SUPPORTED_CONVERSATION_LANGUAGES) {
      const questions = ['movie', 'theater', 'date', 'time', 'seat', 'confirm', null].map((stage) => stageQuestion(stage, language));
      check(`${language}: seven distinct non-empty questions`, new Set(questions).size === 7 && questions.every((q) => q.trim().length > 0));
    }
    check('Korean questions are Hangul', ['movie', 'theater', 'date', 'time', 'seat', 'confirm'].every((stage) => /[가-힣]/.test(stageQuestion(stage, 'ko'))));
    check('an unknown language gets English', stageQuestion('time', 'xx') === stageQuestion('time', 'en'));
    check('withEmptyRespondNote adds exactly one entry', withEmptyRespondNote(c1vContext()).messageHistoryTail.length === c1vContext().messageHistoryTail.length + 1);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall empty-respond checks passed');
}

void main();
