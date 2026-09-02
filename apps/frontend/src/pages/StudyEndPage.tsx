import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { StudySessionState } from '../study/sessionStorage';
import { isDemoStudyMode } from './studyOptions';
import { formatScenarioTitle, isHardTaskScenario } from '../utils/displayFormats';

function deriveSetLabel(scenarioId: string | null): string | null {
  if (!scenarioId) return null;
  const match = scenarioId.match(/^scn_s(\d+)_t[12]_/i);
  if (!match) return null;
  const setNumber = Number.parseInt(match[1], 10);
  if (!Number.isInteger(setNumber) || setNumber < 1 || setNumber > 26) return null;
  return `Set ${String.fromCharCode(64 + setNumber)}`;
}

interface StudyEndPageProps {
  selectedScenarioTitle?: string | null;
  studySession?: StudySessionState | null;
  onResetMode: () => void;
}

export function StudyEndPage({
  selectedScenarioTitle,
  studySession,
  onResetMode,
}: StudyEndPageProps) {
  const navigate = useNavigate();
  const [downloadingLog, setDownloadingLog] = useState(false);
  const [downloadingTrace, setDownloadingTrace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Demo sessions record nothing and have no surveys, so every log/survey
  // control here would be dead: hide them instead of offering dead ends.
  const demoMode = isDemoStudyMode(studySession?.studyMode);
  const canDownloadLog = Boolean(studySession?.interactionLogFile && studySession?.studyToken);
  const canDownloadTrace = Boolean(studySession?.interactionLogFile && studySession?.studyToken);
  const conditionCode = studySession?.conditionLabel ?? null;
  const setLabel = useMemo(() => deriveSetLabel(studySession?.scenario.id ?? null), [studySession]);
  const showPerTrialSurveyButton = useMemo(
    () =>
      !isDemoStudyMode(studySession?.studyMode) &&
      isHardTaskScenario({
        scenarioId: studySession?.scenario.id ?? null,
        scenarioTitle: studySession?.scenario.title ?? selectedScenarioTitle ?? null,
      }),
    [selectedScenarioTitle, studySession]
  );

  const handleBackToSetup = () => {
    onResetMode();
    navigate('/');
  };

  const handleOpenSurvey = () => {
    if (!studySession) return;
    const searchParams = new URLSearchParams({
      studyMode: studySession.studyMode,
    });
    if (studySession.scenario.id) {
      searchParams.set('scenarioId', studySession.scenario.id);
    }
    navigate(`/survey/per-trial?${searchParams.toString()}`);
  };

  const handleDownloadLog = useCallback(async () => {
    if (!studySession?.studyToken || !canDownloadLog || downloadingLog) return;

    setDownloadingLog(true);
    setError(null);

    try {
      const result = await api.downloadStudyLog(studySession.studyToken);
      const downloadUrl = window.URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download =
        result.fileName ??
        studySession.interactionLogFile?.split('/').pop() ??
        'study-interaction-log.jsonl';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download interaction log');
    } finally {
      setDownloadingLog(false);
    }
  }, [canDownloadLog, downloadingLog, studySession]);

  const handleDownloadTrace = useCallback(async () => {
    if (!studySession?.studyToken || !canDownloadTrace || downloadingTrace) return;

    setDownloadingTrace(true);
    setError(null);

    try {
      const result = await api.downloadStudyLlmTrace(studySession.studyToken);
      const downloadUrl = window.URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download =
        result.fileName ??
        `${studySession.interactionLogFile?.split('/').pop()?.replace(/\.jsonl$/i, '') ?? 'study-interaction-log'}.llm-trace.jsonl`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download LLM trace');
    } finally {
      setDownloadingTrace(false);
    }
  }, [canDownloadTrace, downloadingTrace, studySession]);

  return (
    <main className="h-full overflow-y-auto bg-dark px-4 py-6 sm:py-8">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-start sm:justify-center">
        <div className="w-full rounded-2xl border border-dark-border bg-dark-light p-6 sm:p-8">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold text-fg-strong">
              {demoMode ? 'Demo Complete' : 'Study Complete'}
            </h1>
          </div>

          <p className="mb-4 text-sm text-fg-muted">
            The session has ended. Thanks for {demoMode ? 'trying the demo' : 'completing it'}.
          </p>

          <div className="space-y-2 rounded-xl border border-dark-border bg-dark p-4">
            <div className="text-sm font-semibold text-fg-strong">Session summary</div>
            {selectedScenarioTitle ? (
              <div className="text-sm text-fg-strong">
                Scenario: {formatScenarioTitle(selectedScenarioTitle)}
              </div>
            ) : null}
            <div className="text-sm text-fg-muted">
              {demoMode
                ? 'Nothing from this demo session was recorded, so there is nothing to download.'
                : 'You can download both the interaction log and the LLM trace before leaving this page.'}
            </div>
          </div>

          {error ? <p className="mt-4 text-sm text-danger-text">{error}</p> : null}

          {studySession && showPerTrialSurveyButton ? (
            <button
              type="button"
              onClick={handleOpenSurvey}
              className="mt-8 w-full rounded-xl border-2 border-primary bg-primary px-5 py-4 text-center font-semibold text-primary-fg shadow-lg shadow-primary/40 transition-all hover:bg-primary-hover hover:shadow-primary/50 active:scale-[0.98]"
            >
              <span className="block text-base">Open Survey</span>
              <span className="mt-1 inline-block rounded-md border border-accent-line bg-accent px-2 py-0.5 text-lg font-black tracking-wide text-accent-fg">
                {conditionCode}{setLabel ? ` / ${setLabel}` : ''}
              </span>
            </button>
          ) : null}

          <div className="mt-4 flex flex-wrap justify-end gap-3">
            {demoMode ? null : (
              <>
                <button
                  type="button"
                  onClick={handleDownloadLog}
                  disabled={!canDownloadLog || downloadingLog}
                  title={
                    canDownloadLog
                      ? 'Download the current JSONL interaction log'
                      : 'Interaction log is unavailable for this session'
                  }
                  className="rounded-lg border border-dark-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-primary hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {downloadingLog ? 'Downloading...' : 'Download Log'}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadTrace}
                  disabled={!canDownloadTrace || downloadingTrace}
                  title={
                    canDownloadTrace
                      ? 'Download the current JSONL LLM trace log'
                      : 'LLM trace log is unavailable for this session'
                  }
                  className="rounded-lg border border-dark-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-primary hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {downloadingTrace ? 'Downloading Trace...' : 'Download Trace'}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={handleBackToSetup}
              className="rounded-lg border border-dark-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-primary hover:text-fg-strong"
            >
              Back to Setup
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
