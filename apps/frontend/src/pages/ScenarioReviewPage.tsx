import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { StudyModeId } from './studyOptions';
import { ScenarioBriefing } from '../components/scenario/ScenarioBriefing';
import type { StudyScenarioDetail, StudySessionState } from '../study/sessionStorage';
import { formatScenarioTitle } from '../utils/displayFormats';
import { queuePendingStudyLogEvent } from '../study/pendingInteractionEvents';

interface ScenarioReviewPageProps {
  studyMode: StudyModeId;
  selectedScenarioId: string;
  loggingParticipantId: string;
  apiKey: string;
  accessCode: string;
  demoCredentialMode: 'code' | 'key';
  demoMode: boolean;
  onSessionCreated: (session: StudySessionState) => void;
}

export function ScenarioReviewPage({
  studyMode,
  selectedScenarioId,
  loggingParticipantId,
  apiKey,
  accessCode,
  demoCredentialMode,
  demoMode,
  onSessionCreated,
}: ScenarioReviewPageProps) {
  const navigate = useNavigate();
  const [loadingScenarios, setLoadingScenarios] = useState(true);
  const [startingSession, setStartingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<StudyScenarioDetail[]>([]);

  useEffect(() => {
    let mounted = true;
    setLoadingScenarios(true);
    setError(null);

    api.getStudyScenarios()
      .then((result) => {
        if (!mounted) return;
        setScenarios(result.scenarios);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'Failed to load scenario details');
      })
      .finally(() => {
        if (!mounted) return;
        setLoadingScenarios(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    // Demo mode logs nothing at all.
    if (demoMode) return;
    queuePendingStudyLogEvent({
      type: 'user.gui_action',
      clientTimestamp: new Date().toISOString(),
      payload: {
        action: 'openScenario',
        source: 'participant',
        location: 'scenario-review',
        scenarioId: selectedScenarioId,
        studyMode,
      },
    });
  }, [demoMode, selectedScenarioId, studyMode]);

  const selectedScenario =
    scenarios.find((scenario) => scenario.id === selectedScenarioId) ?? null;

  const handleStartBooking = async () => {
    if (!selectedScenario || startingSession) return;

    const trimmedApiKey = apiKey.trim();
    const trimmedAccessCode = accessCode.trim();
    // In demo mode exactly one credential is sent: the access code redeems the
    // operator key server-side, so sending both would be ambiguous.
    const usingAccessCode = demoMode && demoCredentialMode === 'code';
    if (demoMode && usingAccessCode && !trimmedAccessCode) {
      setError('Enter the access code from the presenter on the start page before beginning the demo.');
      return;
    }
    if (demoMode && !usingAccessCode && !trimmedApiKey) {
      setError('Enter your OpenAI API key on the start page before beginning the demo.');
      return;
    }

    setStartingSession(true);
    setError(null);
    try {
      const session = await api.createStudySession({
        scenarioId: selectedScenario.id,
        studyMode,
        // No participant ID is sent in demo mode: there is nothing to log it against.
        loggingParticipantId: demoMode ? undefined : loggingParticipantId.trim() || undefined,
        ...(usingAccessCode
          ? { accessCode: trimmedAccessCode }
          : trimmedApiKey
          ? { apiKey: trimmedApiKey }
          : {}),
      });
      onSessionCreated(session);
      navigate('/booking');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start task session');
    } finally {
      setStartingSession(false);
    }
  };

  // A demo visitor has already read their card on paper. Showing them a briefing
  // for a world they did not choose only stands between the access code and the
  // thing they came to see, so the session starts on arrival.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!demoMode || autoStartedRef.current || startingSession) return;
    if (!selectedScenario) return;
    autoStartedRef.current = true;
    void handleStartBooking();
  }, [demoMode, selectedScenario, startingSession]);

  if (demoMode) {
    return (
      <main className="flex h-full items-center justify-center bg-dark px-6">
        <div className="w-full max-w-md text-center">
          <p className="text-lg font-medium text-fg-strong">
            {error ? 'Could not start the demo' : 'Starting the demo…'}
          </p>
          {error ? (
            <>
              <p className="mt-3 text-sm text-red-400">{error}</p>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="mt-6 rounded border border-dark-border px-4 py-2 text-sm text-fg hover:border-primary hover:text-fg-strong"
              >
                Back
              </button>
            </>
          ) : (
            <p className="mt-2 text-sm text-fg-muted">One moment while the booking session comes up.</p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="h-full overflow-y-auto bg-dark px-4 py-8">
      <div className="mx-auto w-full max-w-5xl rounded-2xl border border-dark-border bg-dark-light p-6 sm:p-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-fg-strong">Scenario Review</h1>
            <p className="mt-1 text-sm text-fg-muted">
              Review the story and preferences before entering the booking task.
            </p>
          </div>
        </div>

        {loadingScenarios ? (
          <div className="rounded-xl border border-dark-border bg-dark p-4 text-sm text-fg-muted">
            Loading scenario details...
          </div>
        ) : selectedScenario ? (
          <ScenarioBriefing
            title={formatScenarioTitle(selectedScenario.title)}
            background={selectedScenario.background}
            story={selectedScenario.story}
            stepBriefs={selectedScenario.stepBriefs}
            narratorPreferenceTypes={selectedScenario.narratorPreferenceTypes}
            seatRows={selectedScenario.seatRows}
          />
        ) : (
          <div className="rounded-xl border border-primary/40 bg-primary/10 p-4 text-sm text-primary">
            Selected scenario was not found.
          </div>
        )}

        {demoMode ? (
          <div className="mt-4 rounded-xl border border-dark-border bg-dark px-4 py-3 text-sm">
            <span className="font-medium text-fg-strong">Demo mode:</span>{' '}
            <span className="text-fg-muted">
              no participant ID, and nothing from this session is recorded.
            </span>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dark-border bg-dark px-4 py-3 text-sm">
            <span className="font-medium text-fg-strong">PID logging:</span>{' '}
            {loggingParticipantId.trim() ? (
              <span className="text-fg-muted">
                enabled for <span className="text-fg-strong">{loggingParticipantId.trim()}</span>
              </span>
            ) : (
              <span className="text-fg-muted">enabled with timestamp-only filename</span>
            )}
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary">
            {error}
          </div>
        )}

        <div className="mt-8 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded-lg border border-dark-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-primary hover:text-fg-strong"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleStartBooking}
            disabled={loadingScenarios || startingSession || !selectedScenario}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {startingSession ? 'Starting...' : 'Start Booking'}
          </button>
        </div>
      </div>
    </main>
  );
}
