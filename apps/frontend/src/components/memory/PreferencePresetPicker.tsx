import { PreferenceChip } from './PreferenceChip';
import { PREFERENCE_PRESETS } from '../../study/preferenceProfile';

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
  const selected = PREFERENCE_PRESETS.find((preset) => preset.id === selectedPresetId) ?? null;

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Preference memory" className="grid gap-2">
        <PresetOption
          label="Start empty"
          blurb="The agent begins knowing nothing, as it does today."
          isSelected={selectedPresetId === null}
          disabled={disabled}
          onSelect={() => onSelect(null)}
        />
        {PREFERENCE_PRESETS.map((preset) => (
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
            The agent will start with
          </h3>
          <ul className="mt-2 space-y-1.5">
            {selected.preferences.map((preference) => (
              <PreferenceChip
                key={preference.id}
                preference={preference}
                isNew={false}
                isBlocked={false}
              />
            ))}
          </ul>
          <p className="mt-2.5 text-xs leading-relaxed text-fg-faint">
            Anything here can be removed from the memory panel once the session
            starts.
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
