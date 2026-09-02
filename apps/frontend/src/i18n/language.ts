/**
 * Conversation language — English or Korean, chosen at the booth.
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

export type Language = 'en' | 'ko';

export const LANGUAGES: readonly Language[] = ['en', 'ko'];

/** English, because that is what the study ran in. */
export const DEFAULT_LANGUAGE: Language = 'en';

export const LANGUAGE_STORAGE_KEY = 'tuning-movie-language';

/** Shown in the switch itself, so each label is written in its own language. */
export const LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  ko: '한국어',
};

/**
 * ISO-639-1, as the Realtime transcription session wants it. Naming this
 * separately from `Language` keeps the wire format from silently becoming
 * whatever the UI type happens to be.
 */
export const STT_LOCALE: Record<Language, string> = {
  en: 'en',
  ko: 'ko',
};

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'ko';
}

/**
 * Anything unrecognised — a stale storage value, a hand-edited query string —
 * falls back to English rather than throwing. A booth demo should never fail to
 * start over a preference.
 */
export function parseLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}
