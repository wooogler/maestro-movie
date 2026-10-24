import type { AgentPreference } from '../../agent/protocol';
import { MEMORY_STAGE_ORDER, isMemoryStage, memoryStageLabel } from './memoryFormat';
import { useLanguage } from '../../i18n';

/**
 * The chip vocabulary, in its own module so the setup screen can preview a
 * preset with the very same component the rail renders live.
 *
 * A preview drawn with lookalike markup drifts. These are the shapes a visitor
 * is asked to recognise across three surfaces — the rail, the projected second
 * screen and the setup screen — so a solid border has to mean Hard in all of
 * them, and it should be impossible to change that in one place only.
 */

/**
 * Which booking steps a preference applies to, as the steps' own names.
 *
 * Every step is shown, in booking order, so the row has the same shape on
 * every chip and the lit words stand out by position as well as by fill. It
 * used to be one letter per step (M T D S St C); visitors at the booth could
 * not tell what the letters meant, and the letters were English on a Korean
 * screen. The words are `memoryStageLabel`, the same per-language names the
 * workflow graph uses.
 *
 * Applied steps are filled; the others are an outline with muted text, kept
 * legible rather than faded out, because "not this step" is information too.
 * The row wraps rather than shrinking: English needs about 300px for all six
 * words, which the phone sheet does not have.
 *
 * The pills are hidden from assistive tech and the row carries one label
 * ("Applies to: Seat"), so a screen reader hears the applied steps rather
 * than all six words with no way to tell which are lit.
 */
export function StageWords({ stages }: { stages: string[] }) {
  const { s, language } = useLanguage();
  const active = new Set(stages);
  const names = stages
    .map((stage) => (isMemoryStage(stage) ? memoryStageLabel(stage, language) : stage))
    .join(', ');
  return (
    <span
      role="img"
      className="flex min-w-0 flex-wrap items-center gap-1"
      aria-label={s.memoryAppliesTo.replace('{stages}', names)}
    >
      {MEMORY_STAGE_ORDER.map((stage) => {
        const applies = active.has(stage);
        return (
          <span
            key={stage}
            aria-hidden="true"
            data-active={applies ? 'true' : 'false'}
            className={`inline-flex items-center whitespace-nowrap rounded-full px-1.5 text-[11px] leading-4 ${
              applies
                ? 'bg-fg-strong/85 font-semibold text-dark'
                : 'font-medium text-fg-muted ring-1 ring-inset ring-dark-border'
            }`}
          >
            {memoryStageLabel(stage, language)}
          </span>
        );
      })}
    </span>
  );
}

export function PreferenceChip({
  preference,
  isNew,
  isBlocked,
  onDelete,
  isPending,
  isArmed = false,
}: {
  preference: AgentPreference;
  isNew: boolean;
  isBlocked: boolean;
  /** Omitted where the panel is read-only. Fires on the SECOND press. */
  onDelete?: (preferenceId: string) => void;
  isPending?: boolean;
  /** Whether this chip is one press away from being forgotten. */
  isArmed?: boolean;
}) {
  const { s } = useLanguage();
  const hard = preference.strength === 'hard';
  return (
    <li
      className={`rounded-lg border px-2.5 py-2 transition-colors ${
        hard ? 'border-solid border-fg-muted/70' : 'border-dashed border-fg-faint/70'
      } ${isBlocked ? 'bg-danger/10' : 'bg-dark-light/60'} ${
        isNew ? 'animate-[memory-flash_1.6s_ease-out]' : ''
      } ${isPending ? 'opacity-50' : ''} ${isArmed ? 'ring-1 ring-danger' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm leading-5 text-fg-strong">{preference.description}</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
            hard ? 'bg-fg-strong/85 text-dark' : 'bg-dark-lighter text-fg-muted'
          }`}
        >
          {hard ? s.memoryHard : s.memorySoft}
        </span>
      </div>
      {/* The control sits on the stage-word row, not beside the description:
          the description wraps to whatever length the agent wrote. The words
          wrap too on a narrow chip, so the control is pinned to the row's top. */}
      <div className="mt-1.5 flex items-start justify-between gap-2">
        <StageWords stages={preference.relevantStages} />
        {onDelete && (
          /*
            Two presses, not one.

            The first arms and the second commits, in place on the chip itself
            rather than behind a dialog: this panel is projected on a second
            screen and held on a visitor's phone, and a modal on either is worse
            than the mistake it prevents. Undo exists, but a stray thumb should
            not be spending it.
          */
          <button
            type="button"
            onClick={() => onDelete(preference.id)}
            disabled={isPending}
            title={
              isArmed
                ? `${s.memoryForgetConfirm} ${preference.description}`
                : `${s.memoryForget}: ${preference.description}`
            }
            aria-label={
              isArmed
                ? `${s.memoryForgetConfirm} ${preference.description}`
                : `${s.memoryForget}: ${preference.description}`
            }
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${
              isArmed
                ? 'bg-danger/25 text-fg-strong'
                : 'text-fg-muted hover:bg-danger/20 hover:text-fg-strong'
            }`}
          >
            {isArmed ? s.memoryForgetConfirm : s.memoryForget}
          </button>
        )}
      </div>
    </li>
  );
}
