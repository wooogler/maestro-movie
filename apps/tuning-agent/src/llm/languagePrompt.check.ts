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
import { buildLanguageSection } from './llmPlanner';

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

console.log('\n3. an unknown language is not guessed at');
check('an unlisted language adds no section', buildLanguageSection('fr') === null);
check('a nonsense value adds no section', buildLanguageSection('not-a-language') === null);

console.log(
  failures === 0 ? '\nall planner language checks passed' : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
