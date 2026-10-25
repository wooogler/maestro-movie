export {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_LABELS,
  LANGUAGE_PACKS,
  LANGUAGE_STORAGE_KEY,
  LANGUAGE_URL_PARAM,
  STT_LOCALE,
  detectLanguage,
  isLanguage,
  languagePack,
  matchLanguageTag,
  parseLanguage,
  readLanguageFromUrl,
  stripLanguageFromUrl,
  type Language,
  type LanguagePack,
  type ScriptClass,
} from './language';

export {
  UI_STRINGS,
  UI_STRING_OVERRIDES,
  stringsFor,
  type UiStrings,
  type WeekdayNames,
} from './strings';

export {
  buildTranscriptionPrompt,
  collectStageHintLabels,
  formatSeatRowHint,
  getIgnoredVoiceTranscriptReason,
  getNormalizedVoiceTranscriptTokens,
  isLikelyFillerToken,
  isLowContentTranscript,
  normalizeVoiceTranscriptToken,
  type IgnoredTranscriptReason,
  type StageHintLimits,
  type TranscriptGateOptions,
} from './voiceInput';

export { LanguageProvider, useLanguage } from './LanguageProvider';
