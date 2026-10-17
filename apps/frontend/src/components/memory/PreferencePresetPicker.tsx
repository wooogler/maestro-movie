import type { AgentMemorySnapshot } from '../../agent/protocol';
import { AgentMemoryPanel } from './AgentMemoryPanel';
import { PREFERENCE_PRESETS, localizePreset, type PreferencePreset } from '../../study/preferenceProfile';
import { useLanguage } from '../../i18n';

/**
 * The preset dressed as a memory snapshot, so the preview below the picker IS
 * the memory panel -- same tabs, same hard/soft split, same stage dots -- and
 * not a lookalike. Everything the agent would add during a session (dead ends,
 * commitments, forgotten items) is empty, which is also true of the real
 * snapshot the agent publishes right after loading a profile.
 */
function presetAsSnapshot(preset: PreferencePreset): AgentMemorySnapshot {
  return {
    updatedAt: '',
    reason: 'preset-preview',
    stage: null,
    preferences: preset.preferences,
    deadEnds: [],
    attemptedBranches: [],
    committedWorkflow: null,
    pendingConflict: null,
    backtrackContinuation: null,
    stageBindings: [],
    forgottenPreferences: [],
    revokedAdaptations: [],
  };
}

interface PreferencePresetPickerProps {
  /** Id of the loaded preset, or null for a session that starts empty. */
  selectedPresetId: string | null;
  onSelect: (presetId: string | null) => void;
  disabled?: boolean;
}

/**
 * Loads a preference memory before the session opens.
 *
 * This is the demo's stand-in for a memory that outlived an earlier session.
 * Nothing is stored — picking a preset just decides what the agent is handed on
 * its first snapshot, so the visitor meets an agent that already knows
 * something about them and can watch what that changes.
 *
 * The preview underneath is not a summary. It renders the chips with the very
 * component the memory rail uses, so what the visitor agrees to here is
 * literally what they will see on the rail thirty seconds later.
 */
export function PreferencePresetPicker({
  selectedPresetId,
  onSelect,
  disabled = false,
}: PreferencePresetPickerProps) {
  const { s, language } = useLanguage();
  const presets = PREFERENCE_PRESETS.map((preset) => localizePreset(preset, language));
  const selected = presets.find((preset) => preset.id === selectedPresetId) ?? null;

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={s.preferenceMemoryTitle} className="grid gap-2">
        <PresetOption
          label={s.presetStartEmpty}
          blurb={s.presetStartEmptyBlurb}
          isSelected={selectedPresetId === null}
          disabled={disabled}
          onSelect={() => onSelect(null)}
        />
        {presets.map((preset) => (
          <PresetOption
            key={preset.id}
            label={preset.label}
            blurb={preset.blurb}
            count={preset.preferences.length}
            isSelected={selectedPresetId === preset.id}
            disabled={disabled}
            onSelect={() => onSelect(preset.id)}
          />
        ))}
      </div>

      {selected && (
        <div className="rounded-xl border border-dark-border bg-dark px-3 py-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
            {s.presetPreviewTitle}
          </h3>
          <div className="mt-2">
            <AgentMemoryPanel snapshot={presetAsSnapshot(selected)} showHeading={false} />
          </div>
          <p className="mt-2.5 text-xs leading-relaxed text-fg-faint">
            {s.presetPreviewNote}
          </p>
        </div>
      )}
    </div>
  );
}

function PresetOption({
  label,
  blurb,
  count,
  isSelected,
  disabled,
  onSelect,
}: {
  label: string;
  blurb: string;
  count?: number;
  isSelected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      disabled={disabled}
      onClick={onSelect}
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        isSelected
          ? 'border-primary/70 bg-primary/10'
          : 'border-dark-border bg-dark hover:border-dark-lighter'
      }`}
    >
      <span
        aria-hidden
        className={`mt-1 h-4 w-4 shrink-0 rounded-full border-2 transition-colors ${
          isSelected ? 'border-primary bg-primary' : 'border-fg-faint'
        }`}
      />
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-fg-strong">{label}</span>
          {typeof count === 'number' && (
            <span className="rounded bg-dark-lighter px-1.5 py-0.5 text-[10px] font-bold text-fg-muted">
              {count}
            </span>
          )}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-fg-muted">{blurb}</span>
      </span>
    </button>
  );
}
