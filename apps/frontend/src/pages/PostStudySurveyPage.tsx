import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

interface PostStudySurveyPageProps {
  loggingParticipantId: string;
}

const CONDITION_OPTIONS = [
  { id: 'C1', label: 'Interface A + Text' },
  { id: 'C2', label: 'Interface B + Text' },
  { id: 'C3', label: 'Interface A + Voice' },
  { id: 'C4', label: 'Interface B + Voice' },
] as const;

const RANK_SLOTS = [1, 2, 3, 4] as const;
const LIKERT_OPTIONS = [1, 2, 3, 4, 5, 6, 7] as const;
const LIKERT_LABELS: Record<(typeof LIKERT_OPTIONS)[number], string> = {
  1: 'Strongly disagree',
  2: 'Disagree',
  3: 'Somewhat disagree',
  4: 'Neutral',
  5: 'Somewhat agree',
  6: 'Agree',
  7: 'Strongly agree',
};
const POST_STUDY_LIKERT_QUESTIONS = [
  {
    id: 'P3',
    prompt:
      "Interface B's screen changes (highlighting, sorting, filtering, adding information) helped me compare options at each stage.",
  },
  {
    id: 'P4',
    prompt:
      "Interface B's alerts about conflicts between preferences I expressed in an earlier stage and options available in a later stage were helpful for navigation.",
  },
  {
    id: 'P5',
    prompt:
      'It was helpful that Interface B remembered the preferences I expressed and took them into account in later stages.',
  },
  {
    id: 'P6',
    prompt:
      "Interface B's split layout (separate GUI panel and chat panel) helped me complete the tasks.",
  },
] as const;

export function PostStudySurveyPage({
  loggingParticipantId,
}: PostStudySurveyPageProps) {
  const navigate = useNavigate();
  const [slotAssignments, setSlotAssignments] = useState<Array<string | null>>([
    null,
    null,
    null,
    null,
  ]);
  const [draggedConditionId, setDraggedConditionId] = useState<string | null>(null);
  const [rankingReason, setRankingReason] = useState('');
  const [responses, setResponses] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assignedConditionIds = useMemo(
    () => new Set(slotAssignments.filter((value): value is string => Boolean(value))),
    [slotAssignments]
  );
  const isDraggingAssignedCondition =
    draggedConditionId !== null && assignedConditionIds.has(draggedConditionId);
  const rankedConditions = useMemo(
    () =>
      slotAssignments.map((conditionId) =>
        CONDITION_OPTIONS.find((option) => option.id === conditionId) ?? null
      ),
    [slotAssignments]
  );

  const rankings = useMemo(
    () =>
      Object.fromEntries(
        slotAssignments
          .map((conditionId, index) => {
            if (!conditionId) return null;
            return [conditionId, index + 1] as const;
          })
          .filter((entry): entry is readonly [string, number] => Boolean(entry))
      ) as Record<string, number>,
    [slotAssignments]
  );

  const likertComplete = POST_STUDY_LIKERT_QUESTIONS.every((question) =>
    Number.isInteger(responses[question.id])
  );
  const formComplete =
    slotAssignments.every((value) => typeof value === 'string' && value.length > 0) &&
    rankingReason.trim().length > 0 &&
    likertComplete;

  const moveConditionToSlot = (conditionId: string, targetSlotIndex: number) => {
    setSlotAssignments((current) => {
      const next = [...current];
      const sourceSlotIndex = next.indexOf(conditionId);
      const displacedConditionId = next[targetSlotIndex];

      if (sourceSlotIndex !== -1) {
        next[sourceSlotIndex] = displacedConditionId ?? null;
      }
      next[targetSlotIndex] = conditionId;
      return next;
    });
  };

  const returnConditionToPool = (conditionId: string) => {
    setSlotAssignments((current) => {
      const next = [...current];
      const sourceSlotIndex = next.indexOf(conditionId);
      if (sourceSlotIndex === -1) {
        return current;
      }
      next[sourceSlotIndex] = null;
      return next;
    });
  };

  const handleLikertChange = (questionId: (typeof POST_STUDY_LIKERT_QUESTIONS)[number]['id'], value: number) => {
    setResponses((current) => ({
      ...current,
      [questionId]: value,
    }));
  };

  const handleSubmit = async () => {
    if (submitting) return;
    if (!loggingParticipantId.trim()) {
      setError('Enter Participant PID on the setup page before opening the survey.');
      return;
    }
    if (!formComplete) {
      setError('Please complete every item before submitting.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await api.submitPostStudySurvey({
        participantId: loggingParticipantId.trim(),
        rankings,
        rankingReason: rankingReason.trim(),
        responses,
      });
      navigate('/', { replace: true });
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : 'Failed to submit survey'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-dark px-4 py-6 sm:py-8">
      <div className="mx-auto w-full max-w-6xl rounded-[28px] border border-stone-300/70 bg-stone-50 p-6 shadow-[0_18px_60px_rgba(15,23,42,0.22)] sm:p-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-700">
              Post-Study Survey
            </h1>
            <p className="mt-2 max-w-3xl text-base leading-7 text-slate-500">
              Please compare all four conditions overall and share your final impressions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:border-slate-400 hover:text-slate-700"
          >
            Back to Setup
          </button>
        </div>

        <div className="mb-6 rounded-2xl border border-stone-300 bg-white p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            PID
          </div>
          <div className="mt-2 text-sm font-medium text-slate-700">
            {loggingParticipantId.trim() || 'Not provided'}
          </div>
        </div>

        <section className="space-y-6">
          <div className="space-y-2">
            <h2 className="text-[1.55rem] font-semibold tracking-tight text-slate-600 sm:text-[1.7rem]">
              P1. Overall Ranking
            </h2>
            <p className="max-w-4xl text-[1.2rem] leading-[1.45] text-slate-500 sm:text-[1.3rem]">
              If you were to use one of the four conditions for real bookings, rank them in
              order of preference.
            </p>
            <p className="text-[1rem] text-slate-400">
              Drag a condition card into each slot. Rank 1 is your most preferred condition and
              Rank 4 is your least preferred. To remove a ranked card, drag it back to the
              Available Conditions area.
            </p>
          </div>

          <div className="rounded-2xl border border-stone-300 bg-white p-5">
            <div className="mb-5">
              <div className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-slate-400">
                Available Conditions
              </div>
              <div
                onDragOver={(event) => {
                  if (!isDraggingAssignedCondition) return;
                  event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!draggedConditionId) return;
                  returnConditionToPool(draggedConditionId);
                  setDraggedConditionId(null);
                }}
                className={`rounded-2xl border border-dashed p-3 transition-colors ${
                  isDraggingAssignedCondition
                    ? 'border-uist-teal/50 bg-uist-teal/[0.06]'
                    : 'border-stone-200 bg-stone-50/50'
                }`}
              >
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {CONDITION_OPTIONS.map((option) => {
                  const isAssigned = assignedConditionIds.has(option.id);
                  const isDragged = draggedConditionId === option.id;

                  // The teal border and tint carry the active card; its text stays
                  // charcoal because teal on the teal tint is only 3.9:1.
                  return (
                    <button
                      key={option.id}
                      type="button"
                      draggable={!isAssigned}
                      onDragStart={() => {
                        if (isAssigned) return;
                        setDraggedConditionId(option.id);
                      }}
                      onDragEnd={() => setDraggedConditionId(null)}
                      disabled={isAssigned}
                      className={`flex min-h-28 flex-col items-start justify-between rounded-2xl border px-4 py-4 text-left transition-all ${
                        isAssigned
                          ? 'cursor-not-allowed border-stone-200 bg-stone-100 text-slate-400 opacity-60'
                          : isDragged
                          ? 'border-uist-teal bg-uist-teal/10 text-uist-charcoal shadow-[0_0_0_1px_rgba(2,131,146,0.2)]'
                          : 'border-stone-200 bg-stone-50 text-slate-600 hover:border-stone-300 hover:bg-white'
                      }`}
                    >
                      <div>
                        <div className="text-[1.05rem] font-semibold leading-7">{option.id}</div>
                        <div className="mt-2 text-[0.98rem] leading-6">{option.label}</div>
                      </div>
                      <div className="mt-4 rounded-full border border-stone-300 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                        {isAssigned ? 'Placed below' : 'Drag to rank'}
                      </div>
                    </button>
                  );
                })}
                </div>
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-4">
              {RANK_SLOTS.map((rank, index) => {
                const option = rankedConditions[index];
                const isDragged = option ? draggedConditionId === option.id : false;
                return (
                  <div
                    key={rank}
                    onDragOver={(event) => {
                      event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (!draggedConditionId) return;
                      moveConditionToSlot(draggedConditionId, index);
                      setDraggedConditionId(null);
                    }}
                    className="flex min-h-[250px] flex-col rounded-2xl border border-stone-300 bg-stone-50 p-4"
                  >
                    <div className="mb-4 rounded-xl border border-uist-teal/30 bg-uist-teal/10 px-3 py-2 text-center">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-uist-teal/80">
                        Rank
                      </div>
                      <div className="mt-1 text-2xl font-semibold text-uist-teal">{rank}</div>
                    </div>

                    {option ? (
                      <button
                        type="button"
                        draggable
                        onDragStart={() => setDraggedConditionId(option.id)}
                        onDragEnd={() => setDraggedConditionId(null)}
                        className={`flex h-full flex-col items-start justify-between rounded-2xl border px-4 py-4 text-left transition-all ${
                          isDragged
                            ? 'border-uist-teal bg-uist-teal/10 text-uist-charcoal shadow-[0_0_0_1px_rgba(2,131,146,0.2)] opacity-80'
                            : 'border-stone-200 bg-white text-slate-600 hover:border-stone-300'
                        }`}
                      >
                        <div>
                          <div className="text-[1.1rem] font-semibold leading-7">{option.id}</div>
                          <div className="mt-2 text-[1rem] leading-6">{option.label}</div>
                        </div>
                        <div className="mt-6 flex w-full items-center justify-start gap-2">
                          <span className="rounded-full border border-stone-300 bg-stone-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                            Drag to move
                          </span>
                        </div>
                      </button>
                    ) : (
                      <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-white px-4 py-6 text-center text-sm leading-6 text-slate-400">
                        Drop one condition here
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="mt-10 space-y-5">
          <div className="space-y-2">
            <h2 className="text-[1.55rem] font-semibold tracking-tight text-slate-600 sm:text-[1.7rem]">
              P2. Ranking Reason
            </h2>
            <p className="max-w-4xl text-[1.2rem] leading-[1.45] text-slate-500 sm:text-[1.3rem]">
              What is the main reason for your ranking?
            </p>
          </div>

          <div className="rounded-2xl border border-stone-300 bg-white p-5">
            <textarea
              value={rankingReason}
              onChange={(event) => setRankingReason(event.target.value)}
              rows={6}
              className="w-full rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 text-base leading-7 text-slate-700 outline-none focus:border-uist-teal"
              placeholder="Please describe why you ranked the conditions this way."
            />
          </div>
        </section>

        <section className="mt-10 space-y-5">
          <div className="space-y-2">
            <h2 className="text-[1.55rem] font-semibold tracking-tight text-slate-600 sm:text-[1.7rem]">
              P3-P6. Comparison
            </h2>
            <p className="max-w-5xl text-[1.2rem] leading-[1.45] text-slate-500 sm:text-[1.3rem]">
              Please rate the following comparison statements about Interface B.
            </p>
            <p className="text-[1rem] text-slate-400">
              (1 = Strongly disagree, 7 = Strongly agree)
            </p>
          </div>

          <div className="rounded-2xl border border-stone-300 bg-white p-5">
            <div className="space-y-6">
              {POST_STUDY_LIKERT_QUESTIONS.map((question, index) => (
                <div
                  key={question.id}
                  className={`space-y-4 ${
                    index > 0 ? 'border-t border-stone-200 pt-6' : ''
                  }`}
                >
                  <div className="space-y-2">
                    <div className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {question.id}
                    </div>
                    <div className="max-w-5xl text-[1.15rem] leading-[1.55] text-slate-600 sm:text-[1.25rem]">
                      {question.prompt}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                    {LIKERT_OPTIONS.map((value) => {
                      const selected = responses[question.id] === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => handleLikertChange(question.id, value)}
                          className={`flex min-h-40 flex-col items-center justify-between rounded-sm border px-3 py-4 text-center transition-all ${
                            selected
                              ? 'border-uist-teal bg-uist-teal/10 text-uist-charcoal shadow-[0_0_0_1px_rgba(2,131,146,0.2)]'
                              : 'border-stone-200 bg-stone-100 text-slate-500 hover:border-stone-300 hover:bg-stone-50'
                          }`}
                        >
                          <div className="space-y-2">
                            <div className="text-[1.1rem] font-medium">{value} -</div>
                            <div className="text-[0.95rem] leading-6 sm:text-[1rem]">
                              {LIKERT_LABELS[value]}
                            </div>
                          </div>
                          <div
                            className={`mt-4 flex h-12 w-12 items-center justify-center rounded-full border ${
                              selected
                                ? 'border-uist-teal bg-white'
                                : 'border-slate-400 bg-transparent'
                            }`}
                          >
                            <div
                              className={`rounded-full transition-all ${
                                selected ? 'h-5 w-5 bg-uist-teal' : 'h-0 w-0 bg-transparent'
                              }`}
                            />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {error ? (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="mt-10 flex items-center justify-between gap-3 border-t border-stone-200 pt-6">
          <div className="text-sm text-slate-500">
            Complete the ranking, the reason, and all four comparison items before submitting.
          </div>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded-xl bg-slate-700 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Submitting...' : 'Submit Post-Study Survey'}
          </button>
        </div>
      </div>
    </main>
  );
}
