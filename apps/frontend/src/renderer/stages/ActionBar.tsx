/**
 * ActionBar Component for Stage System
 *
 * Back/Continue 버튼
 */

import { useLanguage } from '../../i18n';

interface ActionBarProps {
  onBack?: () => void;
  onNext?: () => void;
  backLabel?: string;
  nextLabel?: string;
  backDisabled?: boolean;
  nextDisabled?: boolean;
  showBack?: boolean;
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

  return (
    <div className="mt-6 flex w-full flex-col items-center gap-3">
      <div className="flex w-full max-w-sm flex-col justify-center gap-3 sm:w-auto sm:max-w-none sm:flex-row sm:gap-4">
        {showBack && onBack && (
          <button
            type="button"
            className={`w-full rounded-lg px-6 py-3 transition-colors sm:w-auto ${
              backDisabled
                ? 'bg-dark-border/50 text-fg-muted cursor-not-allowed'
                : 'bg-dark-border text-fg-strong hover:bg-dark-lighter'
            }`}
            onClick={() => onBack()}
            disabled={backDisabled}
          >
            {back}
          </button>
        )}

        {onNext && (
          <button
            type="button"
            className={`w-full rounded-lg px-6 py-3 transition-colors sm:w-auto ${
              nextDisabled
                ? 'bg-primary/50 text-primary-fg/50 cursor-not-allowed'
                : 'bg-primary hover:bg-primary-hover text-primary-fg'
            }`}
            onClick={() => onNext()}
            disabled={nextDisabled}
          >
            {next}
          </button>
        )}
      </div>
    </div>
  );
}
