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
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  detectLanguage,
  isLanguage,
  languagePack,
  readLanguageFromUrl,
  stripLanguageFromUrl,
  type Language,
} from './language';
import { stringsFor, type UiStrings } from './strings';

/** Null when nothing valid is stored, so the caller can tell "chose English" from "never chose". */
function readStoredLanguage(): Language | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : null;
  } catch {
    return null;
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

/**
 * A per-language QR code carries `?lang=ja` (or `lang=ja` in a card's
 * fragment). It overrides whatever is stored and is persisted, so the visitor
 * who scanned the Japanese code stays in Japanese after a reload — the
 * parameter itself is removed from the address bar once read.
 */
function readUrlLanguage(): Language | null {
  if (typeof window === 'undefined') return null;
  return readLanguageFromUrl(window.location.search, window.location.hash);
}

function readExplicitLanguage(): Language | null {
  const fromUrl = readUrlLanguage();
  if (fromUrl) {
    writeStoredLanguage(fromUrl);
    return fromUrl;
  }
  return readStoredLanguage();
}

function readBrowserLanguage(): Language {
  if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE;
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  return detectLanguage(preferred);
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
  detectBrowserLanguage = false,
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
  /**
   * When nothing was chosen (no URL parameter, nothing stored), start in the
   * browser's own language instead of English.
   *
   * Opt-in, and App turns it on for demo mode only: a study machine whose
   * browser happens to prefer Korean must still open in English, exactly as it
   * did before this option existed. The detected language is not persisted —
   * only an explicit choice is — so switching demo mode off falls back to
   * English again.
   */
  detectBrowserLanguage?: boolean;
  /** Fires on a real change only, so callers can log it without debouncing. */
  onChange?: (language: Language) => void;
}) {
  const [explicitLanguage, setExplicitLanguage] = useState<Language | null>(
    () => initialLanguage ?? readExplicitLanguage()
  );
  const [browserLanguage] = useState<Language>(readBrowserLanguage);
  const language: Language =
    explicitLanguage ?? (detectBrowserLanguage ? browserLanguage : DEFAULT_LANGUAGE);

  const languageRef = useRef(language);
  languageRef.current = language;

  const setLanguage = useCallback(
    (next: Language) => {
      if (languageRef.current === next) {
        // Still pin it: "English, chosen" must survive a later browser-language
        // detection, and costs nothing when it was already explicit.
        setExplicitLanguage(next);
        writeStoredLanguage(next);
        return;
      }
      languageRef.current = next;
      setExplicitLanguage(next);
      writeStoredLanguage(next);
      onChange?.(next);
    },
    [onChange]
  );

  // Once read, the parameter leaves the address bar: a reload then keeps the
  // persisted choice, and a link copied from this tab does not carry it on.
  // `history.state` is passed through untouched because the router keeps its
  // own bookkeeping there.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const { pathname, search, hash } = window.location;
    const stripped = stripLanguageFromUrl(pathname, search, hash);
    if (stripped !== null) window.history.replaceState(window.history.state, '', stripped);
  }, []);

  // The <html lang> attribute drives font fallback and the browser's own
  // hyphenation and text selection, which visibly differ between languages —
  // the same Han code point is drawn differently for Japanese and Chinese.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = languagePack(language).htmlLang;
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
