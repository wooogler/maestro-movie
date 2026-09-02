import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  getStudyModeLabel,
  normalizeStudyMode,
  type StudyModeId,
} from './studyOptions';

interface PerTrialSurveyPageProps {
  loggingParticipantId: string;
}

interface SurveyQuestion {
  id: string;
  prompt: string;
  sectionId: SurveySectionId;
  scaleId: SurveyScaleId;
}

type SurveySectionId = 'comparison-conflict' | 'ubs' | 'tam-pu';
type SurveyScaleId = 'likert-7' | 'ubs-type-1' | 'ubs-type-2';

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
const UBS_OPTIONS = [0, 1, 2, 3, 4] as const;
const UBS_TYPE_1_LABELS: Record<(typeof UBS_OPTIONS)[number], string> = {
  0: 'Never',
  1: 'Rarely',
  2: 'Sometimes',
  3: 'Often',
  4: 'All of the time',
};
const UBS_TYPE_2_LABELS: Record<(typeof UBS_OPTIONS)[number], string> = {
  0: 'Not at all',
  1: 'Slightly',
  2: 'Moderately',
  3: 'Very',
  4: 'Extremely',
};
const SURVEY_SCALES = {
  'likert-7': {
    values: LIKERT_OPTIONS,
    labels: LIKERT_LABELS,
    helperText: '(1 = Strongly disagree, 7 = Strongly agree)',
    gridClassName: 'grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7',
  },
  'ubs-type-1': {
    values: UBS_OPTIONS,
    labels: UBS_TYPE_1_LABELS,
    helperText: '(0 = Never, 4 = All of the time)',
    gridClassName: 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5',
  },
  'ubs-type-2': {
    values: UBS_OPTIONS,
    labels: UBS_TYPE_2_LABELS,
    helperText: '(0 = Not at all, 4 = Extremely)',
    gridClassName: 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5',
  },
} as const;
const SURVEY_SECTIONS: ReadonlyArray<{
  id: SurveySectionId;
  title: string;
  description: string;
}> = [
  {
    id: 'comparison-conflict',
    title: 'A. Options and Decision Process',
    description:
      'Please rate how well the system supported your understanding and comparison of options during the task.',
  },
  {
    id: 'ubs',
    title: 'B. Effort and Information Load',
    description:
      'Please rate the amount of mental effort and information load you experienced during the task.',
  },
  {
    id: 'tam-pu',
    title: 'C. Overall Usefulness',
    description:
      'Please rate how useful the system felt for completing the task.',
  },
] as const;
const PER_TRIAL_SURVEY_QUESTIONS: readonly SurveyQuestion[] = [
  {
    id: 'C1',
    sectionId: 'comparison-conflict',
    scaleId: 'likert-7',
    prompt: 'I could identify and compare the differences among the options presented at each stage.',
  },
  {
    id: 'C2',
    sectionId: 'comparison-conflict',
    scaleId: 'likert-7',
    prompt: 'I could understand how preferences I expressed in earlier stages affected the options available in later stages.',
  },
  {
    id: 'C3',
    sectionId: 'comparison-conflict',
    scaleId: 'likert-7',
    prompt: 'The system helped surface potential conflicts or dead-end choices before I spent too much time on them.',
  },
  {
    id: 'U1',
    sectionId: 'ubs',
    scaleId: 'ubs-type-1',
    prompt: 'This system required too much mental effort.',
  },
  {
    id: 'U2',
    sectionId: 'ubs',
    scaleId: 'ubs-type-1',
    prompt: 'It took too long to do what I wanted with this system.',
  },
  {
    id: 'U3',
    sectionId: 'ubs',
    scaleId: 'ubs-type-2',
    prompt: 'This system was difficult to learn.',
  },
  {
    id: 'U4',
    sectionId: 'ubs',
    scaleId: 'ubs-type-1',
    prompt: 'This system required me to remember too much information.',
  },
  {
    id: 'U5',
    sectionId: 'ubs',
    scaleId: 'ubs-type-1',
    prompt: 'This system presented too much information at once.',
  },
  {
    id: 'PU1',
    sectionId: 'tam-pu',
    scaleId: 'likert-7',
    prompt: 'Using this system allowed me to complete the task more quickly.',
  },
  {
    id: 'PU2',
    sectionId: 'tam-pu',
    scaleId: 'likert-7',
    prompt: 'Using this system allowed me to accomplish the task more effectively.',
  },
  {
    id: 'PU3',
    sectionId: 'tam-pu',
    scaleId: 'likert-7',
    prompt: 'Using this system made the task easier to perform.',
  },
  {
    id: 'PU4',
    sectionId: 'tam-pu',
    scaleId: 'likert-7',
    prompt: 'I found this system useful.',
  },
] as const;

function getScaleLabel(scaleId: SurveyScaleId, value: number): string {
  const scale = SURVEY_SCALES[scaleId];
  return (scale.labels as Record<number, string>)[value] ?? String(value);
}

function deriveSetLabel(scenarioId: string | null): string | null {
  if (!scenarioId) return null;

  const match = scenarioId.match(/^scn_s(\d+)_t[12]_/i);
  if (!match) return null;

  const setNumber = Number.parseInt(match[1], 10);
  if (!Number.isInteger(setNumber) || setNumber < 1 || setNumber > 26) return null;
  const setLetter = String.fromCharCode(64 + setNumber);
  return `Set ${setLetter}`;
}

export function PerTrialSurveyPage({
  loggingParticipantId,
}: PerTrialSurveyPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [responses, setResponses] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const studyModeParam = searchParams.get('studyMode');
  const studyMode = normalizeStudyMode(studyModeParam);
  const scenarioId = searchParams.get('scenarioId');
  const setLabel = useMemo(() => deriveSetLabel(scenarioId), [scenarioId]);
  const conditionLabel = getStudyModeLabel(studyMode);
  const questionsBySection = useMemo(
    () =>
      SURVEY_SECTIONS.map((section) => ({
        ...section,
        questions: PER_TRIAL_SURVEY_QUESTIONS.filter(
          (question) => question.sectionId === section.id
        ),
      })),
    []
  );
  const answeredCount = Object.keys(responses).length;
  const isComplete = answeredCount === PER_TRIAL_SURVEY_QUESTIONS.length;

  const handleSelect = (questionId: string, value: number) => {
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
    if (!isComplete) {
      setError('Please answer every survey item before submitting.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await api.submitPerTrialSurvey({
        participantId: loggingParticipantId.trim(),
        studyMode: studyMode as StudyModeId,
        conditionLabel,
        scenarioId: scenarioId ?? undefined,
        setLabel: setLabel ?? undefined,
        responses,
      });
      setSubmitSuccess(true);
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
            <h1 className="text-3xl font-semibold tracking-tight text-slate-700">Survey</h1>
            <p className="mt-2 max-w-3xl text-base leading-7 text-slate-500">
              Please answer based on the Hard task you just completed in this round.
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

        <div className="mb-6 grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-stone-300 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">PID</div>
            <div className="mt-2 text-sm font-medium text-slate-700">
              {loggingParticipantId.trim() || 'Not provided'}
            </div>
          </div>
          <div className="rounded-2xl border border-stone-300 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Condition</div>
            <div className="mt-2 text-sm font-medium text-slate-700">{conditionLabel}</div>
          </div>
          <div className="rounded-2xl border border-stone-300 bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Set</div>
            <div className="mt-2 text-sm font-medium text-slate-700">{setLabel ?? 'Not tagged'}</div>
          </div>
        </div>

        <div className="mb-8 rounded-2xl border border-stone-300 bg-white px-5 py-4 text-base leading-7 text-slate-500">
          Please rate each statement below based on your Hard task experience.
          <br />
          <span className="text-slate-400">
            Some questions use a 1-7 agreement scale, and some use a 0-4 frequency or intensity scale.
          </span>
        </div>

        <div className="space-y-8">
          {questionsBySection.map((section) => (
            <section key={section.id} className="space-y-5">
              <div className="space-y-2">
                <h2 className="text-[1.55rem] font-semibold tracking-tight text-slate-600 sm:text-[1.7rem]">
                  {section.title}
                </h2>
                <p className="max-w-4xl text-[1.2rem] leading-[1.45] text-slate-500 sm:text-[1.3rem]">
                  {section.description}
                </p>
              </div>

              <div className="space-y-10">
                {section.questions.map((question) => (
                  <article key={question.id} className="space-y-6">
                    <div className="max-w-5xl text-[1.2rem] leading-[1.55] text-slate-600 sm:text-[1.3rem]">
                      {question.prompt}
                    </div>
                    <p className="text-[1rem] text-slate-400">
                      {SURVEY_SCALES[question.scaleId].helperText}
                    </p>
                    <div className={SURVEY_SCALES[question.scaleId].gridClassName}>
                      {SURVEY_SCALES[question.scaleId].values.map((value) => {
                        const selected = responses[question.id] === value;
                        // The teal border, tint and dot carry the selection; the label
                        // stays charcoal because teal on the teal tint is only 3.9:1.
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() => handleSelect(question.id, value)}
                            className={`flex min-h-40 flex-col items-center justify-between rounded-sm border px-3 py-4 text-center transition-all ${
                              selected
                                ? 'border-uist-teal bg-uist-teal/10 text-uist-charcoal shadow-[0_0_0_1px_rgba(2,131,146,0.2)]'
                                : 'border-stone-200 bg-stone-100 text-slate-500 hover:border-stone-300 hover:bg-stone-50'
                            }`}
                          >
                            <div className="space-y-2">
                              <div className="text-[1.1rem] font-medium">{value} -</div>
                              <div className="text-[0.95rem] leading-6 sm:text-[1rem]">
                                {getScaleLabel(question.scaleId, value)}
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
                                  selected
                                    ? 'h-5 w-5 bg-uist-teal'
                                    : 'h-0 w-0 bg-transparent'
                                }`}
                              />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>

        {error ? (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {submitSuccess ? (
          <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            Survey submitted successfully. You can return to the setup page for the next step.
          </div>
        ) : null}

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-6">
          <div className="text-sm text-slate-500">
            {answeredCount}/{PER_TRIAL_SURVEY_QUESTIONS.length} answered
          </div>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded-xl bg-slate-700 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Submitting...' : 'Submit Survey'}
          </button>
        </div>
      </div>
    </main>
  );
}
