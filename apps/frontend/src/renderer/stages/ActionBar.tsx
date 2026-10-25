/**
 * ActionBar Component for Stage System
 *
 * Back/Continue 버튼
 */

import { useContext } from 'react';
import { useLanguage } from '../../i18n';
import { StageKeyHintsContext } from './stageKeyHints';

interface ActionBarProps {
  onBack?: () => void;
  onNext?: () => void;
  backLabel?: string;
  nextLabel?: string;
  backDisabled?: boolean;
  nextDisabled?: boolean;
  showBack?: boolean;
}

/** The key cap drawn on a button in the kiosk. Decorative: the label is the name. */
function KeyHint({ children }: { children: string }) {
  return (
    <kbd
      aria-hidden="true"
      data-testid="stage-key-hint"
      className="rounded border border-current/40 px-1.5 py-0.5 font-sans text-[0.7em] font-semibold leading-none opacity-80"
    >
      {children}
    </kbd>
  );
}

export function ActionBar({
  onBack,
  onNext,
  backLabel,
  nextLabel,
  backDisabled = false,
  nextDisabled = false,
  showBack = true,
}: ActionBarProps) {
  const { s } = useLanguage();
  const back = backLabel ?? s.back;
  const next = nextLabel ?? s.continue;
  // `data-stage-action` is what `useStageKeys` presses; it changes nothing on
  // screen. The hints and shortcut attributes exist only inside the demo's
  // split view, which provides this context.
  const { shortcuts, hints } = useContext(StageKeyHintsContext);

  return (
    <div className="mt-6 flex w-full flex-col items-center gap-3">
      <div className="flex w-full max-w-sm flex-col justify-center gap-3 sm:w-auto sm:max-w-none sm:flex-row sm:gap-4">
        {showBack && onBack && (
          <button
            type="button"
            data-stage-action="back"
            aria-keyshortcuts={shortcuts ? 'ArrowLeft' : undefined}
            title={hints ? s.keyHintTitle : undefined}
            className={`w-full rounded-lg px-6 py-3 transition-colors sm:w-auto ${
              hints ? 'inline-flex items-center justify-center gap-2' : ''
            } ${
              backDisabled
                ? 'bg-dark-border/50 text-fg-muted cursor-not-allowed'
                : 'bg-dark-border text-fg-strong hover:bg-dark-lighter'
            }`}
            onClick={() => onBack()}
            disabled={backDisabled}
          >
            {hints ? <KeyHint>←</KeyHint> : null}
            {back}
          </button>
        )}

        {onNext && (
          <button
            type="button"
            data-stage-action="next"
            aria-keyshortcuts={shortcuts ? 'Enter ArrowRight' : undefined}
            title={hints ? s.keyHintTitle : undefined}
            className={`w-full rounded-lg px-6 py-3 transition-colors sm:w-auto ${
              hints ? 'inline-flex items-center justify-center gap-2' : ''
            } ${
              nextDisabled
                ? 'bg-primary/50 text-primary-fg/50 cursor-not-allowed'
                : 'bg-primary hover:bg-primary-hover text-primary-fg'
            }`}
            onClick={() => onNext()}
            disabled={nextDisabled}
          >
            {next}
            {hints ? <KeyHint>{s.keyHintNext}</KeyHint> : null}
          </button>
        )}
      </div>
    </div>
  );
}
