/**
 * How the memory panel lays out its two halves, handed down by whoever owns
 * the space it sits in.
 *
 * A context rather than a prop because the page builds the panel once and the
 * split view decides where it goes: in the portrait kiosk's bottom band it is
 * preferences and workflow side by side, everywhere else (desktop rail, phone
 * sheet, second screen) the default — tabs — and none of those callers has to
 * know this exists.
 */
import { createContext } from 'react';
import type { MemoryPanelArrangement } from '../chat/fullTuningLayout';

export interface MemoryArrangement {
  arrangement: MemoryPanelArrangement;
  /** Side by side only: classes for each of the two panels' frames. */
  panelClassName?: string;
  /** Side by side only: classes for each panel's content (the kiosk zoom). */
  contentClassName?: string;
}

export const MemoryArrangementContext = createContext<MemoryArrangement>({ arrangement: 'tabs' });
