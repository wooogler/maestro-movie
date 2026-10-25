/**
 * An empty `respond` is never how a visitor's turn ends. Booth demo only.
 *
 * KSEA simulation run C1v (2026-10-24, docs/scenarios/ksea2026-korean-simulation.md):
 * the visitor said "첫 번째 걸로 할게요." at the movie stage and the planner
 * returned `respond` with assistantMessage "". Its own reason said "select is
 * available and should be used instead of responding". A respond is the turn's
 * last step, an empty one carries no text, and `maybeSendAssistantMessage`
 * drops empty text, so the result was no speech, no GUI change and no retry.
 * The visitor stood in silence for 90 s.
 *
 * Under spoken brevity an empty assistantMessage is legitimate on a GUI step
 * ("a step on the way to something else"), but SPOKEN_BREVITY_RULES already say
 * silence is never how the turn is handed back. The model sometimes breaks
 * that, so the runtime enforces it:
 *
 *   1. an empty respond that would end a visitor's turn before anything was said
 *      to them is planned again ONCE, with a runtime note in history saying the
 *      previous answer was empty;
 *   2. if the second answer is an empty respond too, the agent asks the stage's
 *      question itself, in the session language (never the English
 *      "I will run <tool> next" fallback, which is a voice-off study sentence).
 *
 * An empty respond is also left alone when the repeat ledger silenced this
 * visitor turn on purpose (KSEA poster session: noise answered with the same
 * question); see `deliberateSilence`.
 *
 * An empty respond is left alone when the visitor has already heard something
 * since they last spoke. Then the question was asked on an earlier step of the
 * same turn ("어느 극장으로 할까요?" on the select before `next`), and asking
 * again would repeat it. Rule-sourced decisions (no session, no key) are also
 * left alone: their silence is deliberate and their notices are separate.
 *
 * Off outside the booth: a study session never reaches any of this, so its
 * behaviour, including an occasional silent respond, is the one the study ran.
 *
 * Pure, with the planner passed in, so `emptyRespond.check.ts` drives the
 * whole path without the API.
 */
import type { PerceivedContext, PlanDecision } from '../types';

export type EmptyRespondStep =
  /** Use the decision as it is. */
  | { kind: 'accept' }
  /** Plan again with `withEmptyRespondNote`. */
  | { kind: 'replan' }
  /** Still empty after the re-plan: say this instead. */
  | { kind: 'fallback'; text: string };

export interface EmptyRespondInput {
  /** Booth demo session (AGENT_STUDY_MODE=demo). False: always `accept`. */
  enabled: boolean;
  decision: Pick<PlanDecision, 'action' | 'explainText' | 'source'>;
  /** The visitor spoke and nothing has been said to them since. */
  userTurnAwaitingAnswer: boolean;
  /** This decision already is the re-plan. */
  replanned: boolean;
  stage: string | null;
  language?: string;
  /**
   * The repeat ledger (core/repeatLedger.ts) already chose silence for this
   * visitor turn: it changed nothing, and everything the planner wanted to say
   * had been said at this stage. An empty respond after that is the same
   * decision, not a failure to answer, so it is accepted — re-planning would
   * only fetch the stage question the ledger just dropped. Booth only, absent
   * elsewhere.
   */
  deliberateSilence?: boolean;
}

export function isEmptyRespond(decision: Pick<PlanDecision, 'action' | 'explainText' | 'source'>): boolean {
  return decision.source === 'llm' && decision.action === null && !(decision.explainText ?? '').trim();
}

export function decideEmptyRespond(input: EmptyRespondInput): EmptyRespondStep {
  if (!input.enabled) return { kind: 'accept' };
  if (!isEmptyRespond(input.decision)) return { kind: 'accept' };
  if (!input.userTurnAwaitingAnswer) return { kind: 'accept' };
  if (input.deliberateSilence === true) return { kind: 'accept' };
  if (!input.replanned) return { kind: 'replan' };
  return { kind: 'fallback', text: stageQuestion(input.stage, input.language) };
}

/**
 * The note the re-plan sees, as the newest history entry. A `system` entry
 * with an annotation and no spec: `buildPlannerHistory` keeps kind, source and
 * reason, the workflow selection state ignores it (it reads specs only), and
 * `chainOpenedByUserUtterance` skips annotated system entries, so the visitor's
 * utterance still opens the chain and select stays available.
 */
export const EMPTY_RESPOND_NOTE_REASON =
  "Runtime note: your previous answer to the user's last message was respond with an empty assistantMessage. " +
  'That ends the turn in silence: nothing is said and nothing changes on screen, so it is never a valid end of turn. ' +
  "Answer the user's last message again. If their words name or pick an option (a position such as \"the first one\" counts), call the tool for it. " +
  'Otherwise respond with a non-empty assistantMessage: the question this stage calls for, in the conversation language.';

export function buildEmptyRespondNote(stage: string | null): Record<string, unknown> {
  return {
    type: 'system',
    ...(stage ? { stage } : {}),
    annotation: { kind: 'runtime-note', source: 'runtime', reason: EMPTY_RESPOND_NOTE_REASON },
  };
}

/** A copy of the context for the re-plan only; the live context is not touched. */
export function withEmptyRespondNote(context: PerceivedContext): PerceivedContext {
  return {
    ...context,
    messageHistoryTail: [...context.messageHistoryTail, buildEmptyRespondNote(context.stage)],
  };
}

type Stage = 'movie' | 'theater' | 'date' | 'time' | 'seat' | 'confirm';

/**
 * The question each stage asks, for the fallback. English is the default for
 * an unknown language. MACHINE-DRAFTED outside en/ko: needs native review,
 * like agentNotices.ts.
 */
const STAGE_QUESTIONS: Readonly<Record<string, Record<Stage | 'other', string>>> = {
  en: {
    movie: 'Which movie would you like to see?',
    theater: 'Which theater would you like?',
    date: 'Which date works for you?',
    time: 'Which showtime would you like?',
    seat: 'Which seats would you like?',
    confirm: 'Shall I confirm this booking?',
    other: 'How would you like to continue?',
  },
  ko: {
    movie: '어떤 영화를 보고 싶으세요?',
    theater: '어느 영화관으로 할까요?',
    date: '어느 날짜로 할까요?',
    time: '몇 시 상영으로 할까요?',
    seat: '어느 좌석으로 할까요?',
    confirm: '이대로 예매를 확정할까요?',
    other: '어떻게 할까요?',
  },
  ja: {
    movie: 'どの映画をご覧になりますか？',
    theater: 'どの映画館にしますか？',
    date: 'どの日にしますか？',
    time: 'どの上映時間にしますか？',
    seat: 'どの座席にしますか？',
    confirm: 'この内容で予約を確定しますか？',
    other: 'どうしますか？',
  },
  'zh-Hans': {
    movie: '您想看哪部电影？',
    theater: '您想选哪家影院？',
    date: '您想选哪一天？',
    time: '您想选哪个场次？',
    seat: '您想选哪些座位？',
    confirm: '要确认这次预订吗？',
    other: '接下来怎么做？',
  },
  'zh-Hant': {
    movie: '您想看哪部電影？',
    theater: '您想選哪家影院？',
    date: '您想選哪一天？',
    time: '您想選哪個場次？',
    seat: '您想選哪些座位？',
    confirm: '要確認這次訂票嗎？',
    other: '接下來怎麼做？',
  },
  de: {
    movie: 'Welchen Film möchten Sie sehen?',
    theater: 'Welches Kino möchten Sie?',
    date: 'Welcher Tag passt Ihnen?',
    time: 'Welche Vorstellung möchten Sie?',
    seat: 'Welche Plätze möchten Sie?',
    confirm: 'Soll ich diese Buchung bestätigen?',
    other: 'Wie möchten Sie weitermachen?',
  },
  fr: {
    movie: 'Quel film voulez-vous voir ?',
    theater: 'Quel cinéma voulez-vous ?',
    date: 'Quel jour vous convient ?',
    time: 'Quelle séance voulez-vous ?',
    seat: 'Quelles places voulez-vous ?',
    confirm: 'Je confirme cette réservation ?',
    other: 'Comment voulez-vous continuer ?',
  },
  es: {
    movie: '¿Qué película quiere ver?',
    theater: '¿Qué cine prefiere?',
    date: '¿Qué día le viene bien?',
    time: '¿Qué sesión prefiere?',
    seat: '¿Qué asientos quiere?',
    confirm: '¿Confirmo esta reserva?',
    other: '¿Cómo quiere continuar?',
  },
};

const STAGES: readonly Stage[] = ['movie', 'theater', 'date', 'time', 'seat', 'confirm'];

export function stageQuestion(stage: string | null, language?: string): string {
  const table = (language ? STAGE_QUESTIONS[language] : undefined) ?? STAGE_QUESTIONS.en;
  const key = STAGES.includes(stage as Stage) ? (stage as Stage) : 'other';
  return table[key];
}

/** For checks: which languages have their own stage questions. */
export function stageQuestionLanguages(): string[] {
  return Object.keys(STAGE_QUESTIONS);
}

export interface EmptyRespondGuardOptions {
  enabled: boolean;
  userTurnAwaitingAnswer: boolean;
  language?: string;
  /** See `EmptyRespondInput.deliberateSilence`. */
  deliberateSilence?: boolean;
  /** Told about each step, for the monitor. */
  onStep?: (step: EmptyRespondStep, decision: PlanDecision, replanned: boolean) => void;
}

export interface EmptyRespondGuardResult {
  decision: PlanDecision;
  /** Non-empty only when both answers were empty: the sentence to say instead. */
  fallbackText: string;
  replanned: boolean;
}

/**
 * Plan, and if the answer is a silent end of the visitor's turn, plan once
 * more with the note; if that is silent too, hand back the stage question.
 */
export async function planWithEmptyRespondGuard(
  context: PerceivedContext,
  plan: (context: PerceivedContext) => Promise<PlanDecision>,
  options: EmptyRespondGuardOptions
): Promise<EmptyRespondGuardResult> {
  const step = (decision: PlanDecision, replanned: boolean): EmptyRespondStep => {
    const verdict = decideEmptyRespond({
      enabled: options.enabled,
      decision,
      userTurnAwaitingAnswer: options.userTurnAwaitingAnswer,
      replanned,
      stage: context.stage,
      language: options.language,
      ...(options.deliberateSilence ? { deliberateSilence: true } : {}),
    });
    options.onStep?.(verdict, decision, replanned);
    return verdict;
  };

  const first = await plan(context);
  const firstStep = step(first, false);
  if (firstStep.kind !== 'replan') {
    return { decision: first, fallbackText: firstStep.kind === 'fallback' ? firstStep.text : '', replanned: false };
  }
  const second = await plan(withEmptyRespondNote(context));
  const secondStep = step(second, true);
  return { decision: second, fallbackText: secondStep.kind === 'fallback' ? secondStep.text : '', replanned: true };
}
