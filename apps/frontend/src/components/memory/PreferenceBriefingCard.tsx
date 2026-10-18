import { useState } from 'react';
import type { AgentPreference } from '../../agent/protocol';
import type { PreferenceProfile } from '../../study/preferenceProfile';
import { PreferenceChip } from './PreferenceChip';
import { useLanguage } from '../../i18n';

interface PreferenceBriefingCardProps {
  /** Already localized: the words here are the words the agent will be handed. */
  profile: PreferenceProfile;
  /** Fires with what survived; an empty list is a legitimate answer. */
  onConfirm: (preferences: AgentPreference[]) => void;
}

/**
 * What the agent remembers, shown BEFORE it is allowed to act on it.
 *
 * The demo's preloaded memory stands in for a previous visit, and a stranger
 * walking up to the booth has no idea what that visit supposedly established.
 * Without this card the first thing they see is a movie list already narrowed
 * for reasons nobody told them. So the session does not start until they have
 * read the list and pressed the button: the host stays off the relay, the
 * agent keeps waiting for it, and the opening line is planned against the
 * memory the visitor actually agreed to.
 *
 * Removal here is one press, not the rail's two. Nothing is running yet, the
 * removed entry stays on screen with a way back, and this card is the one
 * place in the demo where the visitor is expected to be editing.
 */
export function PreferenceBriefingCard({ profile, onConfirm }: PreferenceBriefingCardProps) {
  const { s } = useLanguage();
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set());

  const kept = profile.preferences.filter((entry) => !removedIds.has(entry.id));
  const removed = profile.preferences.filter((entry) => removedIds.has(entry.id));
  const hard = kept.filter((entry) => entry.strength === 'hard');
  const soft = kept.filter((entry) => entry.strength === 'soft');

  const remove = (id: string) => setRemovedIds((current) => new Set([...current, id]));
  const restore = (id: string) =>
    setRemovedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="preference-briefing-title"
      data-testid="preference-briefing"
      className="w-full max-w-md rounded-2xl border border-dark-border bg-dark-light p-5 shadow-2xl"
    >
      <h2 id="preference-briefing-title" className="text-lg font-semibold text-fg-strong">
        {s.briefingTitle}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-fg-muted">{s.briefingBody}</p>

      {kept.length > 0 ? (
        <ul className="mt-4 space-y-1.5">
          {hard.map((preference) => (
            <PreferenceChip
              key={preference.id}
              preference={preference}
              isNew={false}
              isBlocked={false}
              onDelete={remove}
            />
          ))}
          {soft.map((preference) => (
            <PreferenceChip
              key={preference.id}
              preference={preference}
              isNew={false}
              isBlocked={false}
              onDelete={remove}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-dark-border px-3 py-4 text-center text-sm text-fg-muted">
          {s.briefingNothingLeft}
        </p>
      )}

      {removed.length > 0 && (
        <section className="mt-3 border-t border-dark-border pt-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
            {s.memoryForgotten}
          </h3>
          <ul className="mt-1.5 space-y-1">
            {removed.map((preference) => (
              <li
                key={preference.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-dark-border px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-xs leading-4 text-fg-muted line-through">
                  {preference.description}
                </span>
                <button
                  type="button"
                  onClick={() => restore(preference.id)}
                  title={`${s.memoryRestore}: ${preference.description}`}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted transition-colors hover:bg-primary/20 hover:text-fg-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                >
                  {s.memoryRestore}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <button
        type="button"
        onClick={() => onConfirm(kept)}
        className="mt-5 w-full rounded-xl bg-primary px-4 py-3 text-base font-semibold text-primary-fg transition-colors hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {kept.length > 0 ? s.briefingStart : s.briefingStartEmpty}
      </button>
    </section>
  );
}
