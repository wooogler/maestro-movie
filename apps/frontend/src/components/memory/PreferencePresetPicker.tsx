import type React from 'react';
import { PreferenceChip } from './PreferenceChip';
import { PREFERENCE_PRESETS, localizePreset, type PreferencePreset } from '../../study/preferenceProfile';
import { useLanguage } from '../../i18n';

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
 * The preview is not a summary and it is not a separate box: the chosen card
 * opens to show its preferences with the very chip the memory rail uses --
 * hard ones first, then soft, stage dots and all -- so what the visitor agrees
 * to here is literally what they will see on the rail thirty seconds later.
 * Only the preferences: the rail's workflow graph has nothing to say before a
 * session exists.
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
        >
          {selected?.id === preset.id ? <PresetPreview preset={selected} note={s.presetPreviewNote} /> : null}
        </PresetOption>
      ))}
    </div>
  );
}

/** The rail's preferences tab, minus the tab: hard first, then soft. */
function PresetPreview({ preset, note }: { preset: PreferencePreset; note: string }) {
  const hard = preset.preferences.filter((entry) => entry.strength === 'hard');
  const soft = preset.preferences.filter((entry) => entry.strength === 'soft');
  return (
    <div className="mt-3 border-t border-dark-border pt-3">
      <ul className="space-y-1.5">
        {hard.map((preference) => (
          <PreferenceChip key={preference.id} preference={preference} isNew={false} isBlocked={false} />
        ))}
      </ul>
      {soft.length > 0 ? (
        <ul className="mt-1.5 space-y-1.5">
          {soft.map((preference) => (
            <PreferenceChip key={preference.id} preference={preference} isNew={false} isBlocked={false} />
          ))}
        </ul>
      ) : null}
      <p className="mt-2.5 text-xs leading-relaxed text-fg-faint">{note}</p>
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
  children,
}: {
  label: string;
  blurb: string;
  count?: number;
  isSelected: boolean;
  disabled: boolean;
  onSelect: () => void;
  /** Rendered inside the card, under the row, when the option is chosen. */
  children?: React.ReactNode;
}) {
  return (
    /*
      The card is a div and only the row is the radio: the preview holds list
      items with their own titles and labels, which a <button> may not contain.
    */
    <div
      className={`rounded-xl border px-4 py-3 transition-colors ${
        isSelected
          ? 'border-primary/70 bg-primary/10'
          : 'border-dark-border bg-dark hover:border-dark-lighter'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={isSelected}
        disabled={disabled}
        onClick={onSelect}
        className="flex w-full items-start gap-3 text-left disabled:cursor-not-allowed"
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
      {children}
    </div>
  );
}
