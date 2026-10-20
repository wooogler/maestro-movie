/**
 * Conversation language, chosen at the booth: English (the language the
 * recorded study ran in), Korean (the first booth addition), Japanese,
 * Simplified and Traditional Chinese, and German, French and Spanish as
 * voice-first packs whose screen chrome is still English.
 *
 * Added for the UIST 2026 demo as a visitor-facing option, not as a study
 * condition. The recorded study ran entirely in English and stays reproducible:
 * `en` is the default, and every language-dependent branch in this codebase is
 * written so that `en` produces exactly what it produced before this module
 * existed — same prompts, same regexes, same strings.
 *
 * What the switch actually reaches, and what it deliberately does not:
 *
 *   Switches   speech recognition language, the transcription prompt, the
 *              rejection filter that used to drop Hangul outright, the
 *              agent's spoken language, the voice-verbosity classifier, and
 *              the screen's own chrome.
 *
 *   Stays      the catalogue itself. Film titles, cinema names, seat ids,
 *              formats and prices are the Detroit world's data, they are what
 *              the planner names in tool calls, and several are proper nouns
 *              with no Korean form. Translating them would change the agent's
 *              input surface, which is the research artifact.
 *
 * Kept free of React and store imports so anything may type-import from it.
 */

export type Language = 'en' | 'ko' | 'ja' | 'zh-Hans' | 'zh-Hant' | 'de' | 'fr' | 'es';

/**
 * The switch's order, too. English leads because the recorded study ran in it,
 * Korean because it was the first booth language; the rest were added for the
 * UIST 2026 booth in Detroit, by expected visitor numbers.
 */
export const LANGUAGES: readonly Language[] = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'de', 'fr', 'es'];

/** English, because that is what the study ran in. */
export const DEFAULT_LANGUAGE: Language = 'en';

export const LANGUAGE_STORAGE_KEY = 'tuning-movie-language';

/**
 * How a script behaves for the parts of the voice pipeline that tokenize or
 * cut text. `kana-han` is Japanese (kana plus kanji), `han` is Chinese; both
 * are written without spaces between words, which is what the tokenizers have
 * to know.
 */
export type ScriptClass = 'latin' | 'hangul' | 'kana-han' | 'han';

/**
 * Everything about a language that is not prose. The prose lives with the code
 * that uses it (strings.ts, voiceInput.ts, the agent's prompt sections), each
 * table keyed by `Language` and falling back to English.
 */
export interface LanguagePack {
  code: Language;
  /** Written in the language itself; shown in the switch. */
  label: string;
  /** The language's name in English, for prompts that instruct a model. */
  englishName: string;
  /** BCP-47, for `<html lang>` and `lang=` attributes. */
  htmlLang: string;
  /** For `Intl` formatting. */
  locale: string;
  /** ISO-639-1, as the Realtime transcription session wants it. */
  sttLocale: string;
  script: ScriptClass;
  /** False for Japanese and Chinese: words are not separated by spaces. */
  usesSpaces: boolean;
}

export const LANGUAGE_PACKS: Record<Language, LanguagePack> = {
  en: { code: 'en', label: 'English', englishName: 'English', htmlLang: 'en', locale: 'en-US', sttLocale: 'en', script: 'latin', usesSpaces: true },
  ko: { code: 'ko', label: '한국어', englishName: 'Korean', htmlLang: 'ko', locale: 'ko-KR', sttLocale: 'ko', script: 'hangul', usesSpaces: true },
  ja: { code: 'ja', label: '日本語', englishName: 'Japanese', htmlLang: 'ja', locale: 'ja-JP', sttLocale: 'ja', script: 'kana-han', usesSpaces: false },
  'zh-Hans': { code: 'zh-Hans', label: '简体中文', englishName: 'Chinese (Simplified)', htmlLang: 'zh-Hans', locale: 'zh-CN', sttLocale: 'zh', script: 'han', usesSpaces: false },
  'zh-Hant': { code: 'zh-Hant', label: '繁體中文', englishName: 'Chinese (Traditional)', htmlLang: 'zh-Hant', locale: 'zh-TW', sttLocale: 'zh', script: 'han', usesSpaces: false },
  de: { code: 'de', label: 'Deutsch', englishName: 'German', htmlLang: 'de', locale: 'de-DE', sttLocale: 'de', script: 'latin', usesSpaces: true },
  fr: { code: 'fr', label: 'Français', englishName: 'French', htmlLang: 'fr', locale: 'fr-FR', sttLocale: 'fr', script: 'latin', usesSpaces: true },
  es: { code: 'es', label: 'Español', englishName: 'Spanish', htmlLang: 'es', locale: 'es-ES', sttLocale: 'es', script: 'latin', usesSpaces: true },
};

/** Never throws: an unknown code reads as English. */
export function languagePack(language: Language | string): LanguagePack {
  return (LANGUAGE_PACKS as Record<string, LanguagePack | undefined>)[language] ?? LANGUAGE_PACKS.en;
}

/** Shown in the switch itself, so each label is written in its own language. */
export const LANGUAGE_LABELS: Record<Language, string> = Object.fromEntries(
  LANGUAGES.map((language) => [language, LANGUAGE_PACKS[language].label])
) as Record<Language, string>;

/**
 * ISO-639-1, as the Realtime transcription session wants it. Naming this
 * separately from `Language` keeps the wire format from silently becoming
 * whatever the UI type happens to be — both Chinese packs transcribe as `zh`,
 * and it is the transcription prompt that asks for one script or the other.
 */
export const STT_LOCALE: Record<Language, string> = Object.fromEntries(
  LANGUAGES.map((language) => [language, LANGUAGE_PACKS[language].sttLocale])
) as Record<Language, string>;

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Anything unrecognised — a stale storage value, a hand-edited query string —
 * falls back to English rather than throwing. A booth demo should never fail to
 * start over a preference.
 */
export function parseLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

/**
 * A browser or URL language tag mapped onto a pack, or null when none fits.
 *
 * Exact codes win; otherwise the primary subtag decides, with Chinese split by
 * script — an explicit `Hant`, or a region that writes Traditional characters
 * (Taiwan, Hong Kong, Macau), reads as `zh-Hant`, and every other `zh` as
 * `zh-Hans`.
 */
export function matchLanguageTag(tag: unknown): Language | null {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  if (isLanguage(trimmed)) return trimmed;
  const parts = trimmed.replace(/_/g, '-').toLowerCase().split('-');
  const primary = parts[0];
  if (primary === 'zh') {
    const rest = parts.slice(1);
    if (rest.includes('hant') || rest.some((part) => part === 'tw' || part === 'hk' || part === 'mo')) {
      return 'zh-Hant';
    }
    return 'zh-Hans';
  }
  const byPrimary = LANGUAGES.find((language) => language === primary);
  return byPrimary ?? null;
}

/** The first of the browser's preferred languages that has a pack, else English. */
export function detectLanguage(preferred: readonly string[] | null | undefined): Language {
  for (const tag of preferred ?? []) {
    const match = matchLanguageTag(tag);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
}

export const LANGUAGE_URL_PARAM = 'lang';

/**
 * A `lang` value carried by the URL — `?lang=ja` on any route, or `lang=ja` in
 * a `#key=value` fragment such as a quick-demo card's. The query wins when both
 * are present. Unknown values are ignored, so the stored choice stands.
 */
export function readLanguageFromUrl(search: string, hash: string): Language | null {
  const fromQuery = new URLSearchParams(search.replace(/^\?/, '')).get(LANGUAGE_URL_PARAM);
  const queryMatch = matchLanguageTag(fromQuery);
  if (queryMatch) return queryMatch;
  const fragment = hash.replace(/^#/, '');
  if (!fragment.includes(`${LANGUAGE_URL_PARAM}=`)) return null;
  return matchLanguageTag(new URLSearchParams(fragment).get(LANGUAGE_URL_PARAM));
}

/**
 * The same URL with `lang` removed from both the query and a key=value
 * fragment, or null when there was nothing to remove. Every other parameter is
 * kept — a card's fragment carries its access code next to the language.
 */
export function stripLanguageFromUrl(pathname: string, search: string, hash: string): string | null {
  const query = new URLSearchParams(search.replace(/^\?/, ''));
  const fragment = hash.replace(/^#/, '');
  const fragmentParams = fragment.includes(`${LANGUAGE_URL_PARAM}=`) ? new URLSearchParams(fragment) : null;
  const inQuery = query.has(LANGUAGE_URL_PARAM);
  const inFragment = Boolean(fragmentParams?.has(LANGUAGE_URL_PARAM));
  if (!inQuery && !inFragment) return null;
  query.delete(LANGUAGE_URL_PARAM);
  let nextHash = hash;
  if (fragmentParams && inFragment) {
    fragmentParams.delete(LANGUAGE_URL_PARAM);
    const rest = fragmentParams.toString();
    nextHash = rest ? `#${rest}` : '';
  }
  const nextSearch = query.toString();
  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash}`;
}
