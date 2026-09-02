import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { StudyModeId } from './studyOptions';
import { ScenarioBriefing } from '../components/scenario/ScenarioBriefing';
import type { StudyScenarioDetail, StudySessionState } from '../study/sessionStorage';
import { formatScenarioTitle } from '../utils/displayFormats';
import {
  clearPendingStudyLogEvents,
  queuePendingStudyLogEvent,
} from '../study/pendingInteractionEvents';
import { CompanionPairingCard } from '../components/companion/CompanionPairingCard';
import { DeviceRosterCard } from '../components/companion/DeviceRosterCard';
import { useMemoryViewer } from '../components/memory';
import { useDevicePresence } from '../hooks/useDevicePresence';
import type { VoiceOutputTarget } from '../hooks/useVoiceCompanionHost';
import { useLanguage } from '../i18n';

interface ScenarioReviewPageProps {
  studyMode: StudyModeId;
  selectedScenarioId: string;
  loggingParticipantId: string;
  apiKey: string;
  accessCode: string;
  demoCredentialMode: 'code' | 'key';
  demoMode: boolean;
  /** What the visitor answered on the setup screen. Demo sessions only. */
  researchConsent: boolean;
  /**
   * Phone-pairing token, minted once per session by App.
   *
   * Arrives a moment after the session does, because minting is its own request.
   * The card renders nothing until it lands, so the screen fills in rather than
   * flashing an empty box.
   */
  companionToken: string | null;
  /**
   * Where the visitor wants to hear and speak. A preference at this point: no
   * phone has attached and nothing is capturing, so choosing the phone here
   * cannot mute anything — the booking page applies it when one appears.
   */
  voiceTarget: VoiceOutputTarget;
  onVoiceTargetChange: (target: VoiceOutputTarget) => void;
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
  researchConsent,
  companionToken,
  voiceTarget,
  onVoiceTargetChange,
  onSessionCreated,
}: ScenarioReviewPageProps) {
  const navigate = useNavigate();
  const { s: ui } = useLanguage();
  const [loadingScenarios, setLoadingScenarios] = useState(true);
  const [startingSession, setStartingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<StudyScenarioDetail[]>([]);
  /*
    The demo used to go straight from "start" into the booking UI. It now stops
    here once, with the pairing QR: the code is minted with the session, so it
    cannot exist any earlier than this, and a visitor who is already inside the
    booking task has stopped looking for a QR to scan.
  */
  const [pairedSession, setPairedSession] = useState<StudySessionState | null>(null);

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
    // A demo visitor's steps are only queued once they have consented.
    if (demoMode && !researchConsent) return;
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
  }, [demoMode, researchConsent, selectedScenarioId, studyMode]);

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
      // Nothing queued by a visitor who declined may reach the backend, and the
      // queue outlives this page: drop it before a session that could flush it
      // exists.
      if (demoMode && !researchConsent) {
        clearPendingStudyLogEvents();
      }
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
        ...(demoMode ? { researchConsent } : {}),
      });
      onSessionCreated(session);
      // A demo visitor gets the pairing screen first; everyone else goes
      // straight in, because their scenario briefing was the stop.
      if (demoMode) {
        setPairedSession(session);
        return;
      }
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

  /*
    Watch the session read-only, purely to answer "did my phone actually
    connect?" on the screen where the visitor is scanning.

    A VIEWER socket, not a host one. The host slot is newest-wins — joining as
    host here would evict whichever host arrived next, and a moment later
    ChatPage joins as host for real. A viewer cannot write, is refused on any
    outbound frame, and deliberately does not hold a session open.
  */
  const viewer = useMemoryViewer(pairedSession?.viewToken ?? null);
  const phonePresence = useDevicePresence({
    pairable: Boolean(companionToken),
    linked: viewer.status === 'watching',
    endedMessage: viewer.status === 'error' ? (viewer.message ?? null) : null,
    roster: viewer.devices?.roster ?? null,
    rosterAtMs: viewer.devices?.atMs ?? null,
  });

  if (demoMode) {
    return (
      <main className="h-full overflow-y-auto bg-dark px-6 py-8">
        <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center text-center">
          {pairedSession ? (
            <>
              <p className="text-xl font-semibold text-fg-strong">{ui.pairReadyTitle}</p>
              {/*
                One QR, deliberately.

                The read-only pairing this screen used to offer is a strict
                subset of this one: the companion page shows the same memory
                panel AND carries the session's voice, so a second code here
                only asked the visitor to choose between "watch" and "watch and
                talk". No `companionActive` is passed — nothing is paired yet
                and nothing is capturing, so both audio targets are live
                choices rather than a switch that could mute the session.
              */}
              <div className="mt-5 text-left">
                {companionToken ? (
                  <CompanionPairingCard
                    companionToken={companionToken}
                    target={voiceTarget}
                    onTargetChange={onVoiceTargetChange}
                  />
                ) : (
                  /*
                    The pairing code is its own request and lands a moment after
                    the session. The card renders nothing without one, which
                    would leave a gap between the title and the button that reads
                    as a broken screen rather than a pending one. The button
                    below stays live throughout: a visitor must never be stuck
                    here because a pairing code did not arrive.
                  */
                  <p className="rounded-xl border border-dashed border-dark-border px-4 py-6 text-center text-sm text-fg-muted">
                    {ui.preparingDemo}
                  </p>
                )}
                {/* So the visitor can see the scan land, rather than pressing
                    Start booking and finding out in front of everyone. */}
                <DeviceRosterCard roster={viewer.devices?.roster ?? null} phone={phonePresence} />
              </div>
              <button
                type="button"
                onClick={() => navigate('/booking')}
                autoFocus
                className="mt-6 w-full rounded-xl bg-primary px-4 py-4 text-base font-semibold text-primary-fg transition-colors hover:bg-primary-hover"
              >
                {ui.startBooking}
              </button>
            </>
          ) : (
            <>
              <p className="text-lg font-medium text-fg-strong">
                {error ? 'Could not start the demo' : ui.preparingDemo}
              </p>
              {error ? (
                <>
                  <p className="mt-3 text-sm text-danger-text">{error}</p>
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
            </>
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
          <div className="rounded-xl border border-danger bg-danger/10 p-4 text-sm text-danger-text">
            Selected scenario was not found.
          </div>
        )}

        {demoMode ? (
          <div className="mt-4 rounded-xl border border-dark-border bg-dark px-4 py-3 text-sm">
            <span className="font-medium text-fg-strong">Demo mode:</span>{' '}
            <span className="text-fg-muted">
              no participant ID, and{' '}
              {researchConsent
                ? 'this session is recorded for research, as agreed on the setup screen.'
                : 'nothing from this session is recorded.'}
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
          <div className="mt-4 rounded-lg border border-danger bg-danger/10 px-3 py-2 text-sm text-danger-text">
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
