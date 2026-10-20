/**
 * Executable check for the planner's language directive:
 *
 *   npx tsx apps/tuning-agent/src/llm/languagePrompt.check.ts
 *
 * One claim to defend. The study ran in English, and adding a language option
 * must not have changed the prompt it ran against — so every English path has
 * to produce no section at all, not a section that happens to say "English".
 *
 * Exit code 0 means every case passed.
 */
import {
  SUPPORTED_CONVERSATION_LANGUAGES,
  buildLanguageSection,
  isSupportedConversationLanguage,
} from './llmPlanner';
import { buildPreferenceLanguageLine } from './llmExtractor';
import { agentNotice, translatedNoticeLanguages, type AgentNoticeKey } from '../core/agentNotices';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n1. English is untouched');
check('an unset language adds no section', buildLanguageSection(undefined) === null);
check('an empty language adds no section', buildLanguageSection('') === null);
check('English adds no section', buildLanguageSection('en') === null);

console.log('\n2. Korean adds one, and it stays out of the tool surface');
const ko = buildLanguageSection('ko');
check('Korean adds a section', ko !== null);
check(
  'the section constrains assistantMessage, not the decision framework',
  Boolean(ko && ko.includes('assistantMessage'))
);
check(
  'it says tool parameters are not to be translated',
  Boolean(ko && /tool parameter/i.test(ko))
);
check(
  'it keeps the trace field in English',
  Boolean(ko && /"reason" stays in English/.test(ko))
);

console.log('\n2b. every other supported language adds one of the same shape');
const NON_ENGLISH = SUPPORTED_CONVERSATION_LANGUAGES.filter((language) => language !== 'en');
check(
  'the supported set is the frontend registry',
  SUPPORTED_CONVERSATION_LANGUAGES.join(',') === 'en,ko,ja,zh-Hans,zh-Hant,de,fr,es'
);
for (const language of NON_ENGLISH) {
  const section = buildLanguageSection(language);
  check(`${language}: adds a section starting with "Language:"`, Boolean(section && section.startsWith('Language:\n')));
  check(`${language}: constrains assistantMessage`, Boolean(section && section.includes('assistantMessage')));
  check(`${language}: leaves tool parameters untranslated`, Boolean(section && /tool parameter/i.test(section)));
  check(`${language}: keeps the trace field in English`, Boolean(section && /"reason" stays in English/.test(section)));
  check(`${language}: is accepted from the host`, isSupportedConversationLanguage(language));
}
const zhHans = buildLanguageSection('zh-Hans') ?? '';
const zhHant = buildLanguageSection('zh-Hant') ?? '';
check('Simplified asks for Simplified characters and 您', /Simplified Chinese characters/.test(zhHans) && zhHans.includes('您'));
check('Traditional asks for Traditional characters and 您', /Traditional Chinese characters/.test(zhHant) && zhHant.includes('您'));
check('Japanese asks for です・ます', (buildLanguageSection('ja') ?? '').includes('です・ます'));
check(
  'German, French and Spanish use the formal address',
  (buildLanguageSection('de') ?? '').includes('Sie') &&
    (buildLanguageSection('fr') ?? '').includes('vous') &&
    (buildLanguageSection('es') ?? '').includes('usted')
);
check(
  'the new sections tell the model to read catalogue dates and prices as written',
  ['ja', 'zh-Hans', 'zh-Hant', 'de', 'fr', 'es'].every((language) =>
    (buildLanguageSection(language) ?? '').includes('"Mar 14 (Sat)"')
  )
);

console.log('\n2c. the extractor and the agent notices follow the same rule');
check('English adds no extractor line', buildPreferenceLanguageLine(undefined) === null && buildPreferenceLanguageLine('en') === null);
check('Korean adds no extractor line, as in the study', buildPreferenceLanguageLine('ko') === null);
check(
  'every post-study language adds one',
  ['ja', 'zh-Hans', 'zh-Hant', 'de', 'fr', 'es'].every((language) => buildPreferenceLanguageLine(language) !== null)
);
const NOTICE_KEYS: AgentNoticeKey[] = [
  'hostNotReady', 'filterEmpty', 'genericFailure', 'plannerUnavailable',
  'plannerUnparseable', 'plannerInvalid', 'apiKeyRejected', 'plannerRequestFailed',
];
check(
  'English notices are the study text',
  agentNotice('plannerRequestFailed') === 'Planner request failed this turn. Please try again shortly.' &&
    agentNotice('genericFailure', 'en') === 'Something went wrong — let me try again.'
);
check(
  'Korean has its own notices, in Hangul',
  translatedNoticeLanguages().includes('ko') && NOTICE_KEYS.every((key) => /[가-힣]/.test(agentNotice(key, 'ko')))
);
check(
  'every translated language translates every notice',
  translatedNoticeLanguages().every((language) => NOTICE_KEYS.every((key) => agentNotice(key, language) !== agentNotice(key)))
);
check('an unknown language gets English notices', agentNotice('genericFailure', 'xx') === agentNotice('genericFailure'));

console.log('\n3. an unknown language is not guessed at');
check('an unlisted language adds no section', buildLanguageSection('xx') === null);
check('an unlisted language is not accepted from the host', !isSupportedConversationLanguage('xx'));
check('a nonsense value adds no section', buildLanguageSection('not-a-language') === null);

console.log(
  failures === 0 ? '\nall planner language checks passed' : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
