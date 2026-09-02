/**
 * Holds the chosen language for the whole app.
 *
 * A context rather than a prop, because the strings are needed at the bottom of
 * the render tree — inside the stage components and their buttons — and
 * threading a `strings` prop through `StageProps` would put presentation
 * plumbing into the type the renderer contract is built on.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, parseLanguage, type Language } from './language';
import { stringsFor, type UiStrings } from './strings';

function readStoredLanguage(): Language {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    return parseLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

function writeStoredLanguage(language: Language): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // A booth browser with storage disabled still gets the language for this
    // session; only the persistence is lost.
  }
}

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  /** The string table for the current language. */
  s: UiStrings;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  s: stringsFor(DEFAULT_LANGUAGE),
});

export function LanguageProvider({
  children,
  initialLanguage,
  onChange,
}: {
  children: ReactNode;
  /**
   * Overrides the stored preference for the initial render. The booth uses the
   * stored value; this exists so a caller that already knows the language —
   * a render check, or a link that carries one — does not have to write to
   * storage first to get it.
   */
  initialLanguage?: Language;
  /** Fires on a real change only, so callers can log it without debouncing. */
  onChange?: (language: Language) => void;
}) {
  const [language, setLanguageState] = useState<Language>(
    () => initialLanguage ?? readStoredLanguage()
  );

  const setLanguage = useCallback(
    (next: Language) => {
      setLanguageState((current) => {
        if (current === next) return current;
        writeStoredLanguage(next);
        onChange?.(next);
        return next;
      });
    },
    [onChange]
  );

  // The <html lang> attribute drives font fallback and the browser's own
  // hyphenation and text selection, which visibly differ between the two.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({ language, setLanguage, s: stringsFor(language) }),
    [language, setLanguage]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}
