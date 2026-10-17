/**
 * The planner-model setting, wherever it is being changed from.
 *
 * `null` means "whatever the server is configured with" and is the state until
 * a visitor picks something; like the voice-verbosity hook, nothing is written
 * to storage until a person chooses. The choice lives in localStorage so it
 * survives the installed PWA being closed, and is pushed to the agent by the
 * bridge on join and on every change.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isPlannerModelId } from '../agent/plannerModels';

// Not in plannerModels.ts: that file is a byte-identical copy of the agent's.
const PLANNER_MODEL_STORAGE_KEY = 'tuning-movie-planner-model';

export interface PlannerModelController {
  /** The chosen model id, or null for the server default. */
  model: string | null;
  handleChange: (model: string | null) => void;
}

function readStored(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PLANNER_MODEL_STORAGE_KEY);
    // A model that has since left the allow-list is treated as unset rather
    // than sent and refused on every join.
    return isPlannerModelId(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeStored(model: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (model) {
      window.localStorage.setItem(PLANNER_MODEL_STORAGE_KEY, model);
    } else {
      window.localStorage.removeItem(PLANNER_MODEL_STORAGE_KEY);
    }
  } catch {
    // Storage disabled: the setting still applies to this session.
  }
}

export function usePlannerModelSetting(options: {
  /** Fires once per real change, with a payload ready to log. */
  onChange?: (model: string | null, detail: Record<string, unknown>) => void;
} = {}): PlannerModelController {
  const [model, setModel] = useState<string | null>(readStored);
  const onChangeRef = useRef(options.onChange);

  useEffect(() => {
    onChangeRef.current = options.onChange;
  }, [options.onChange]);

  const handleChange = useCallback(
    (next: string | null) => {
      const normalized = next && isPlannerModelId(next) ? next : null;
      if (normalized === model) return;
      setModel(normalized);
      writeStored(normalized);
      onChangeRef.current?.(normalized, { previousModel: model, model: normalized });
    },
    [model]
  );

  return { model, handleChange };
}
