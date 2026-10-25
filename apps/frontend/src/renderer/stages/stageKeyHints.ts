/**
 * Whether the stage's Continue/Back buttons advertise their keyboard keys.
 *
 * Off by default, so every renderer outside the demo's split view — the study
 * conditions, the chat view, the second screen — draws exactly the buttons it
 * always did. The split view turns `shortcuts` on where `useStageKeys` listens
 * (kiosk and desktop) and `hints` on in the kiosk only, where a visitor
 * standing at the screen has to be told the keys exist.
 */
import { createContext } from 'react';

export interface StageKeyHints {
  /** The keys work here: the buttons say so to assistive tech (`aria-keyshortcuts`). */
  shortcuts: boolean;
  /** And say so visibly, with a small key cap on each button. */
  hints: boolean;
}

export const StageKeyHintsContext = createContext<StageKeyHints>({ shortcuts: false, hints: false });
