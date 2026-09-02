import {
  CONFIGURABLE_VOICE_CATEGORIES,
  VOICE_VERBOSITY_PRESETS,
  type VoiceCategory,
  type VoiceMode,
  type VoiceVerbosityPreset,
  type VoiceVerbositySettings,
} from '../../voice';
import {
  SMART_SKIP_HINT,
  SMART_SKIP_LABEL,
  VOICE_CATEGORY_HINTS,
  VOICE_CATEGORY_LABELS,
  VOICE_MODE_HINTS,
  VOICE_MODE_LABELS,
  VOICE_PRESET_HINTS,
  VOICE_PRESET_LABELS,
} from './verbosityFormat';

interface VoiceVerbosityPanelProps {
  settings: VoiceVerbositySettings;
  onPresetChange: (preset: Exclude<VoiceVerbosityPreset, 'custom'>) => void;
  onCategoryChange: (category: VoiceCategory, mode: VoiceMode) => void;
  onSmartSkipChange: (enabled: boolean) => void;
  onClose: () => void;
  /** Live count of utterances the gate has silenced or shortened this session. */
  stats?: { silenced: number; shortened: number } | null;
}

const PRESETS: Array<Exclude<VoiceVerbosityPreset, 'custom'>> = ['full', 'balanced', 'minimal'];
const MODES: VoiceMode[] = ['speak', 'brief', 'silent'];

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h3>
      {hint ? <p className="mt-0.5 text-[11px] text-fg-faint">{hint}</p> : null}
    </div>
  );
}

function ModeSegments({
  category,
  value,
  onChange,
}: {
  category: VoiceCategory;
  value: VoiceMode;
  onChange: (mode: VoiceMode) => void;
}) {
  return (
    <div
      className="flex h-8 shrink-0 items-center rounded-md bg-dark p-0.5"
      role="radiogroup"
      aria-label={`How much to speak for: ${VOICE_CATEGORY_LABELS[category]}`}
    >
      {MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          title={VOICE_MODE_HINTS[mode]}
          onClick={() => onChange(mode)}
          className={`h-full rounded px-2.5 text-[11px] font-semibold transition-colors ${
            value === mode
              ? 'bg-dark-light text-fg-strong shadow-sm'
              : 'text-fg-muted hover:text-fg-strong'
          }`}
        >
          {VOICE_MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}

export function VoiceVerbosityPanel({
  settings,
  onPresetChange,
  onCategoryChange,
  onSmartSkipChange,
  onClose,
  stats = null,
}: VoiceVerbosityPanelProps) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-fg-strong">How much the agent speaks</h2>
          <p className="mt-0.5 text-xs text-fg">
            Anything not spoken still appears in the chat, so nothing is lost.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-dark-border px-3 py-1 text-xs text-fg transition-colors hover:border-primary hover:text-fg-strong"
        >
          Done
        </button>
      </header>

      <section>
        <SectionHeading title="Preset" hint={VOICE_PRESET_HINTS[settings.preset]} />
        <div
          className="flex h-9 items-center rounded-md bg-dark p-0.5"
          role="radiogroup"
          aria-label="Voice verbosity preset"
        >
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={settings.preset === preset}
              title={VOICE_PRESET_HINTS[preset]}
              onClick={() => onPresetChange(preset)}
              className={`h-full flex-1 rounded px-3 text-xs font-semibold transition-colors ${
                settings.preset === preset
                  ? 'bg-dark-light text-fg-strong shadow-sm'
                  : 'text-fg-muted hover:text-fg-strong'
              }`}
            >
              {VOICE_PRESET_LABELS[preset]}
            </button>
          ))}
          {settings.preset === 'custom' ? (
            <span className="ml-1 shrink-0 rounded bg-dark-lighter px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-fg">
              {VOICE_PRESET_LABELS.custom}
            </span>
          ) : null}
        </div>
      </section>

      <section>
        <SectionHeading title="By what the agent is doing" />
        <ul className="space-y-1.5">
          {CONFIGURABLE_VOICE_CATEGORIES.map((category) => (
            <li
              key={category}
              className="flex items-center justify-between gap-3 rounded-lg border border-dark-border bg-dark-light/60 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg-strong">
                  {VOICE_CATEGORY_LABELS[category]}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-fg-faint">
                  {VOICE_CATEGORY_HINTS[category]}
                </p>
              </div>
              <ModeSegments
                category={category}
                value={settings.categories[category]}
                onChange={(mode) => onCategoryChange(category, mode)}
              />
            </li>
          ))}
          <li className="flex items-center justify-between gap-3 rounded-lg border border-dark-border/60 bg-dark-light/30 px-3 py-2 opacity-60">
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">{VOICE_CATEGORY_LABELS.system}</p>
              <p className="mt-0.5 truncate text-[11px] text-fg-faint">
                {VOICE_CATEGORY_HINTS.system}
              </p>
            </div>
            <span className="shrink-0 rounded bg-dark-lighter px-2.5 py-1 text-[11px] font-semibold text-fg-muted">
              {VOICE_MODE_LABELS.speak}
            </span>
          </li>
        </ul>
      </section>

      <section>
        <button
          type="button"
          aria-pressed={settings.smartSkip}
          onClick={() => onSmartSkipChange(!settings.smartSkip)}
          className={`flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
            settings.smartSkip
              ? 'border-primary/60 bg-primary/10'
              : 'border-dark-border bg-dark-light/40 hover:border-dark-border'
          }`}
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-fg-strong">{SMART_SKIP_LABEL}</span>
            <span className="mt-0.5 block text-[11px] text-fg-faint">{SMART_SKIP_HINT}</span>
          </span>
          <span
            className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
              settings.smartSkip ? 'bg-primary' : 'bg-dark-lighter'
            }`}
          >
            <span
              className={`h-4 w-4 rounded-full bg-white transition-transform ${
                settings.smartSkip ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </span>
        </button>
      </section>

      {stats && stats.silenced + stats.shortened > 0 ? (
        <p className="text-[11px] text-fg-faint">
          This session: {stats.silenced} sentence{stats.silenced === 1 ? '' : 's'} not spoken,{' '}
          {stats.shortened} shortened.
        </p>
      ) : null}
    </div>
  );
}

/** Exported so ChatPage can reset to a named preset without importing the table. */
export { VOICE_VERBOSITY_PRESETS };
