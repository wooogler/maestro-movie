/**
 * The voice-verbosity setting, wherever it is being changed from.
 *
 * It lives in `localStorage`, is read at mount and written only when someone
 * changes it. That used to happen on the booking page alone; the setup screen
 * now shows the same sheet, because "how much should it talk" is a question a
 * visitor would rather answer before the agent starts talking than during. Two
 * copies of the state would be two copies of the persistence rule — including
 * the one about not writing a default — so both screens come through here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  VOICE_VERBOSITY_PRESETS,
  VOICE_VERBOSITY_STORAGE_KEY,
  matchPreset,
  parseVerbosity,
  serializeVerbosity,
  type VoiceCategory,
  type VoiceMode,
  type VoiceVerbosityPreset,
  type VoiceVerbositySettings,
} from '../voice';

export interface VoiceVerbosityController {
  settings: VoiceVerbositySettings;
  handlePresetChange: (preset: Exclude<VoiceVerbosityPreset, 'custom'>) => void;
  handleCategoryChange: (category: VoiceCategory, mode: VoiceMode) => void;
  handleSmartSkipChange: (enabled: boolean) => void;
}

/** null means nothing usable is stored, not that the setting is unknown. */
function readStored(): VoiceVerbositySettings | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseVerbosity(window.localStorage.getItem(VOICE_VERBOSITY_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(settings: VoiceVerbositySettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VOICE_VERBOSITY_STORAGE_KEY, serializeVerbosity(settings));
  } catch {
    // A booth browser with storage disabled still gets the setting for this
    // session; only the persistence is lost.
  }
}

export function useVoiceVerbositySettings(options: {
  /**
   * What the setting is while nothing is stored and nothing has been changed —
   * `defaultVerbosityFor(isDemo)`. Read on every render rather than at mount,
   * so a setup screen that switches between demo and a study condition shows
   * the default that condition will actually run with.
   */
  fallback: VoiceVerbositySettings;
  /**
   * Fires once per real change, with a payload ready to log. Kept in a ref so a
   * caller may pass an inline closure without re-creating the handlers.
   */
  onChange?: (next: VoiceVerbositySettings, detail: Record<string, unknown>) => void;
}): VoiceVerbosityController {
  /*
    `null` until someone actually chooses, and storage is written only then.

    Persisting the fallback at mount would be a quiet condition change: the
    setup screen opens in demo mode, whose default is `balanced`, and writing
    that would hand `balanced` to a C3/C4 participant whose build must speak
    everything. Nothing is written until a person changes something.
  */
  const [chosen, setChosen] = useState<VoiceVerbositySettings | null>(readStored);
  const settings = chosen ?? options.fallback;
  const onChangeRef = useRef(options.onChange);

  useEffect(() => {
    onChangeRef.current = options.onChange;
  }, [options.onChange]);

  /**
   * One place to change the setting, persist it and report it. The value handed
   * to `setChosen` is a plain object rather than an updater on purpose: React
   * may call an updater more than once, which would double-report the change.
   */
  const apply = useCallback(
    (next: VoiceVerbositySettings, detail: Record<string, unknown>) => {
      setChosen(next);
      writeStored(next);
      onChangeRef.current?.(next, {
        ...detail,
        previousPreset: settings.preset,
        preset: next.preset,
        smartSkip: next.smartSkip,
        categories: next.categories,
      });
    },
    [settings]
  );

  const handlePresetChange = useCallback(
    (preset: Exclude<VoiceVerbosityPreset, 'custom'>) => {
      apply({ preset, ...VOICE_VERBOSITY_PRESETS[preset] }, { source: 'preset' });
    },
    [apply]
  );

  const handleCategoryChange = useCallback(
    (category: VoiceCategory, mode: VoiceMode) => {
      // `system` has no other channel, so it is not user-settable.
      const categories = { ...settings.categories, [category]: mode, system: 'speak' as const };
      const smartSkip = settings.smartSkip;
      apply(
        { categories, smartSkip, preset: matchPreset({ categories, smartSkip }) },
        {
          source: 'category',
          category,
          previousMode: settings.categories[category],
          nextMode: mode,
        }
      );
    },
    [apply, settings]
  );

  const handleSmartSkipChange = useCallback(
    (enabled: boolean) => {
      const categories = settings.categories;
      apply(
        { categories, smartSkip: enabled, preset: matchPreset({ categories, smartSkip: enabled }) },
        { source: 'smart_skip' }
      );
    },
    [apply, settings]
  );

  return { settings, handlePresetChange, handleCategoryChange, handleSmartSkipChange };
}
