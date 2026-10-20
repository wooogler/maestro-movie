/**
 * The visitor's language as a plain native dropdown.
 *
 * Used where the language is chosen before anything else happens — the demo
 * start page and the pairing screen — so a visitor can pick it without first
 * finding the settings modal. The modal keeps its own pill row; both write the
 * same stored choice through `useLanguage()`, so whichever was touched last
 * wins and nothing else needs wiring. A native `<select>` because eight
 * languages do not fit as pills on a phone and the OS picker is the one a
 * visitor already knows how to use.
 */

import { LANGUAGES, LANGUAGE_LABELS, languagePack, parseLanguage, useLanguage } from '../../i18n';

interface LanguageSelectProps {
  label?: string;
  hint?: string;
  className?: string;
  id?: string;
}

export function LanguageSelect({ label, hint, className, id = 'language-select' }: LanguageSelectProps) {
  const { language, setLanguage } = useLanguage();
  return (
    <div className={`rounded-xl border border-dark-border bg-dark p-3${className ? ` ${className}` : ''}`}>
      {label ? (
        <label
          htmlFor={id}
          className="mb-1 block text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          {label}
        </label>
      ) : null}
      {hint ? <p className="mb-2 text-[11px] leading-relaxed text-fg-faint">{hint}</p> : null}
      <select
        id={id}
        value={language}
        onChange={(event) => setLanguage(parseLanguage(event.target.value))}
        aria-label={label ? undefined : 'Language'}
        className="h-11 w-full rounded-xl border border-dark-border bg-dark px-3 text-sm font-medium text-fg-strong focus:border-primary focus:outline-none sm:h-10"
      >
        {LANGUAGES.map((candidate) => (
          <option key={candidate} value={candidate} lang={languagePack(candidate).htmlLang}>
            {LANGUAGE_LABELS[candidate]}
          </option>
        ))}
      </select>
    </div>
  );
}
