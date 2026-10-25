/**
 * One place for the settings a visitor can change mid-session: the language,
 * and how much the agent says out loud.
 *
 * They used to sit in the composer's toolbar — a language pill and a verbosity
 * pill beside the mic — which is the row with the least space on a phone and
 * the one the booking UI most wants back. Moving them behind a single header
 * button costs a tap and returns the whole strip.
 *
 * The voice section is only shown when voice is available at all; a text-only
 * condition has nothing to configure there, and an empty section reads as
 * something broken.
 */

import { useEffect, useRef } from 'react';
import { LANGUAGES, LANGUAGE_LABELS, languagePack, useLanguage } from '../../i18n';
import { VoiceVerbosityPanel } from '../voice/VoiceVerbosityPanel';
import { PushToTalkSettings } from './PushToTalkSettings';
import type { FullTuningLayoutMode } from '../chat/fullTuningLayout';
import {
  setFullTuningLayoutOverride,
  useFullTuningLayoutOverride,
} from '../chat/useFullTuningLayoutMode';
import { useReduceMotionSetting } from '../../study/tabletProfileStorage';
import {
  DEFAULT_PLANNER_MODEL,
  PLANNER_MODEL_OPTIONS,
  plannerModelDescription,
} from '../../agent/plannerModels';
import type {
  VoiceCategory,
  VoiceMode,
  VoiceVerbosityPreset,
  VoiceVerbositySettings,
} from '../../voice';

interface SettingsModalProps {
  onClose: () => void;
  voiceSettingsAvailable: boolean;
  voiceVerbosity: VoiceVerbositySettings;
  onPresetChange: (preset: Exclude<VoiceVerbosityPreset, 'custom'>) => void;
  onCategoryChange: (category: VoiceCategory, mode: VoiceMode) => void;
  onSmartSkipChange: (enabled: boolean) => void;
  voiceGateStats?: { silenced: number; shortened: number } | null;
  /**
   * Demo only. In a study condition the planner model is part of the condition
   * and is set by the researcher through the environment, not by the person in
   * the chair.
   */
  plannerModelAvailable?: boolean;
  /** null = the server's configured model. */
  plannerModel?: string | null;
  onPlannerModelChange?: (model: string | null) => void;
  /** This session's measured planner latency per model, newest model last. */
  plannerTurnStats?: Array<{ model: string; turns: number; avgMs: number; lastMs: number }>;
  /**
   * Demo (booth) only, like the planner model: a study session's turn
   * detection is part of the condition, and the backend refuses manual turns
   * for it anyway.
   */
  pushToTalkAvailable?: boolean;
  /**
   * Demo only: pin the screen arrangement (kiosk / desktop / phone) or let it
   * be detected. The study conditions have one layout and nothing to pick.
   */
  layoutOverrideAvailable?: boolean;
}

const LAYOUT_CHOICES: ReadonlyArray<{
  key: 'layoutAuto' | 'layoutKiosk' | 'layoutDesktop' | 'layoutCompact';
  mode: FullTuningLayoutMode | null;
}> = [
  { key: 'layoutAuto', mode: null },
  { key: 'layoutKiosk', mode: 'kiosk' },
  { key: 'layoutDesktop', mode: 'desktop' },
  { key: 'layoutCompact', mode: 'compact' },
];

export function SettingsModal({
  onClose,
  voiceSettingsAvailable,
  voiceVerbosity,
  onPresetChange,
  onCategoryChange,
  onSmartSkipChange,
  voiceGateStats,
  plannerModelAvailable = false,
  plannerModel = null,
  onPlannerModelChange,
  plannerTurnStats = [],
  pushToTalkAvailable = false,
  layoutOverrideAvailable = false,
}: SettingsModalProps) {
  const { language, setLanguage, s } = useLanguage();
  const layoutOverride = useFullTuningLayoutOverride();
  const [reduceMotion, setReduceMotion] = useReduceMotionSetting();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes it, and focus starts on the close button — the modal covers
  // the booking UI, so getting out of it must not depend on hitting a small
  // target in a corner.
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={s.settingsTitle}
      onClick={onClose}
    >
      {/*
        A bottom sheet on a phone and a centred card above `sm`: on a phone the
        top of a centred dialog is out of thumb reach, and the settings are
        short enough that anchoring them to the bottom edge costs nothing.
      */}
      <div
        className="max-h-[85dvh] w-full max-w-xl overflow-y-auto overscroll-contain rounded-t-2xl border border-dark-border bg-dark-light p-5 shadow-2xl sm:rounded-2xl sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-fg-strong">{s.settingsTitle}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-lg border border-dark-border px-3 py-1.5 text-xs font-medium text-fg hover:border-primary hover:text-fg-strong"
          >
            {s.close}
          </button>
        </div>

        <section className="mb-6">
          <div className="mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {s.languageLabel}
            </h3>
          </div>
          <div
            role="radiogroup"
            aria-label={s.languageLabel}
            className="grid grid-cols-4 gap-2"
          >
            {LANGUAGES.map((candidate) => {
              const selected = candidate === language;
              return (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  lang={languagePack(candidate).htmlLang}
                  onClick={() => setLanguage(candidate)}
                  className={`rounded-xl border px-2 py-3 text-sm font-medium transition-colors ${
                    selected
                      ? 'border-primary bg-primary text-primary-fg'
                      : 'border-dark-border bg-dark text-fg hover:border-primary hover:text-fg-strong'
                  }`}
                >
                  {LANGUAGE_LABELS[candidate]}
                </button>
              );
            })}
          </div>
        </section>

        {layoutOverrideAvailable ? (
          <section className="mb-6">
            <div className="mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                {s.layoutLabel}
              </h3>
              <p className="mt-1 text-xs text-fg-muted">{s.layoutHint}</p>
            </div>
            {/*
              The same choice as `?layout=`, and remembered the same way. For
              the presenter whose rotated monitor reports itself as landscape,
              or who wants the desktop columns back on a portrait screen.
            */}
            <div role="radiogroup" aria-label={s.layoutLabel} className="grid grid-cols-4 gap-2">
              {LAYOUT_CHOICES.map((choice) => {
                const selected = choice.mode === layoutOverride;
                return (
                  <button
                    key={choice.key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setFullTuningLayoutOverride(choice.mode)}
                    className={`min-h-11 rounded-xl border px-2 py-2 text-sm font-medium transition-colors ${
                      selected
                        ? 'border-primary bg-primary text-primary-fg'
                        : 'border-dark-border bg-dark text-fg hover:border-primary hover:text-fg-strong'
                    }`}
                  >
                    {s[choice.key]}
                  </button>
                );
              })}
            </div>
            {/*
              The app's reduced-motion path, the one `prefers-reduced-motion`
              takes, for a slow tablet whose OS setting nobody wants to change.
              Remembered on the device, like the layout above.
            */}
            <label className="mt-3 flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl border border-dark-border bg-dark px-4 py-2">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-fg-strong">{s.reduceMotionLabel}</span>
                <span className="block text-xs text-fg-muted">{s.reduceMotionHint}</span>
              </span>
              <input
                type="checkbox"
                className="h-5 w-5 shrink-0 accent-primary"
                checked={reduceMotion}
                onChange={(event) => setReduceMotion(event.target.checked)}
              />
            </label>
          </section>
        ) : null}

        {plannerModelAvailable ? (
          <section className="mb-6">
            <div className="mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                {s.plannerModelLabel}
              </h3>
              <p className="mt-1 text-xs text-fg-muted">{s.plannerModelHint}</p>
            </div>
            {/*
              A native select rather than a radio list: eight stacked cards
              pushed the voice settings below the fold on a phone, and the
              choice is made once per session, not compared at a glance. The
              chosen model's one-line description sits under it so the
              trade-off is still readable without opening the list.
            */}
            <select
              aria-label={s.plannerModelLabel}
              value={plannerModel ?? ''}
              onChange={(event) => onPlannerModelChange?.(event.target.value || null)}
              className="h-11 w-full rounded-xl border border-dark-border bg-dark px-3 text-sm font-medium text-fg-strong focus:border-primary focus:outline-none sm:h-10"
            >
              <option value="">
                {s.plannerModelDefault} ({DEFAULT_PLANNER_MODEL})
              </option>
              {PLANNER_MODEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} ({option.id})
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-fg-muted">
              {plannerModel
                ? (() => {
                    const option = PLANNER_MODEL_OPTIONS.find((candidate) => candidate.id === plannerModel);
                    if (!option) return '';
                    return plannerModelDescription(option, language);
                  })()
                : s.plannerModelDefaultHint}
            </p>
            {plannerTurnStats.length > 0 ? (
              <div className="mt-3 rounded-xl border border-dark-border bg-dark px-4 py-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {s.plannerModelStatsTitle}
                </div>
                <dl className="mt-2 grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-xs tabular-nums">
                  {plannerTurnStats.map((entry) => (
                    <div key={entry.model} className="contents">
                      <dt className="truncate text-fg">{entry.model}</dt>
                      <dd className="text-fg-muted">
                        {s.plannerModelStatsAvg
                          .replace('{seconds}', (entry.avgMs / 1000).toFixed(1))
                          .replace('{turns}', String(entry.turns))}
                      </dd>
                      <dd className="text-fg-muted">
                        {s.plannerModelStatsLast.replace('{seconds}', (entry.lastMs / 1000).toFixed(1))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </section>
        ) : null}

        {pushToTalkAvailable ? <PushToTalkSettings /> : null}

        {voiceSettingsAvailable ? (
          <VoiceVerbosityPanel
            settings={voiceVerbosity}
            onPresetChange={onPresetChange}
            onCategoryChange={onCategoryChange}
            onSmartSkipChange={onSmartSkipChange}
            onClose={onClose}
            stats={voiceGateStats}
          />
        ) : null}
      </div>
    </div>
  );
}
