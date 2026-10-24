/**
 * Pins the preference extractor's system prompt. No API.
 *
 *   npx tsx apps/tuning-agent/src/llm/extractorPrompt.check.ts
 *
 * Two halves:
 *
 *  1. A study session's prompt is byte-identical to what it was before the
 *     booth's Korean language line (2026-10-24), in every language. The hashes
 *     below were taken from `realtime-voice` @ 7989a44, before the change.
 *     Without the booth flag, Korean still adds nothing, as in the study.
 *  2. In a booth session, Korean (and only Korean, of the languages that had
 *     no line) now asks for the description in Korean, with titles and names
 *     kept as on screen; every other booth prompt is unchanged.
 *
 * A deliberate prompt change will fail section 1 or the booth hashes: update
 * the hash only if the change is meant to reach that session type, and say so
 * in the commit.
 */
import { createHash } from 'node:crypto';

import {
  STUDY_THEATER_FORMAT_NOTE,
  STUDY_TIME_FORMAT_NOTE,
  buildBoothPreferenceLanguageLine,
  buildPreferenceLanguageLine,
  buildPreferenceSystemPrompt,
} from './llmExtractor';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

const META = [
  { stage: 'movie', goal: 'g', fieldGuide: 'Film selection.' },
  { stage: 'theater', goal: 'g', fieldGuide: `Cinema location selection. ${STUDY_THEATER_FORMAT_NOTE}` },
  { stage: 'time', goal: 'g', fieldGuide: `Showtime selection. ${STUDY_TIME_FORMAT_NOTE}` },
];

/** [study with META, study without meta, booth with META], taken before the change. */
const BEFORE: Record<string, [string, string, string]> = {
  none: ['72f92d842d30dc02', 'b79e6593a18efcd9', '9255741598698b82'],
  en: ['72f92d842d30dc02', 'b79e6593a18efcd9', '9255741598698b82'],
  ko: ['72f92d842d30dc02', 'b79e6593a18efcd9', '9255741598698b82'],
  ja: ['f9f5b0a61a3e51e8', '7c75934819659aa5', '9272524cd6a269e2'],
  'zh-Hans': ['90c12d3d3c83b886', '81d4b82693312c2d', '6cd5f8da827384b9'],
  'zh-Hant': ['21624e1608c5287c', '6286aa14f9c03680', '4e42197aa6f93c0b'],
  de: ['b693b2a89afe18fe', 'aaac430d932cf47f', '509c96ca7a9b44a1'],
  fr: ['090f4aeaa9857923', '4e23c78e92ffd677', 'c3b425eb4cf094fb'],
  es: ['b84f9c77ff311b03', '2d51aa383aa1d40f', '725116b89f76553c'],
};
/** The one booth prompt the change is meant to move. */
const BOOTH_KO_AFTER = 'd5f9398aa01fd93d';

console.log('\n1. study sessions: byte-identical to before, every language');
for (const [key, [study, studyNoMeta]] of Object.entries(BEFORE)) {
  const language = key === 'none' ? undefined : key;
  check(`${key}: study prompt with stage meta`, hash(buildPreferenceSystemPrompt(META, language)) === study);
  check(`${key}: study prompt, flag false`, hash(buildPreferenceSystemPrompt(META, language, false)) === study);
  check(`${key}: study prompt without stage meta`, hash(buildPreferenceSystemPrompt(undefined, language, false)) === studyNoMeta);
}
check('Korean still adds no study line', buildPreferenceLanguageLine('ko') === null);
check('a study Korean prompt has no Language section', !buildPreferenceSystemPrompt(META, 'ko').includes('Language:'));

console.log('\n2. booth sessions: Korean asks for Korean; nothing else moved');
for (const [key, [, , booth]] of Object.entries(BEFORE)) {
  if (key === 'ko') continue;
  const language = key === 'none' ? undefined : key;
  check(`${key}: booth prompt unchanged`, hash(buildPreferenceSystemPrompt(META, language, true)) === booth);
}
const boothKo = buildPreferenceSystemPrompt(META, 'ko', true);
const boothNone = buildPreferenceSystemPrompt(META, undefined, true);
const koLine = buildBoothPreferenceLanguageLine('ko');
check('ko: the booth prompt is pinned', hash(boothKo) === BOOTH_KO_AFTER, hash(boothKo));
check('ko: a booth Korean line exists', koLine !== null);
check('ko: it requires descriptions in Korean', Boolean(koLine?.includes('Write every new or rewritten description in Korean.')));
check('ko: it overrides the English examples', Boolean(koLine?.includes('The examples above are in English; write yours in Korean anyway.')));
check('ko: titles and cinema names stay as displayed', Boolean(koLine?.includes('Keep film titles, cinema names, formats, seat ids, dates, times and prices exactly as they appear on screen.')));
check('ko: ids, strength and stages are untouched by language', Boolean(koLine?.includes('id, strength and relevantStages are unaffected by language.')));
check(
  'ko: the booth prompt is the previous booth prompt with exactly that line inserted before the booth section',
  Boolean(koLine) && boothKo === boothNone.replace('\n\nBooth demo:\n', `\n\n${koLine}\n\nBooth demo:\n`)
);
check('no booth line for English', buildBoothPreferenceLanguageLine('en') === null && buildBoothPreferenceLanguageLine(undefined) === null);
check(
  'the post-study languages keep their own line in the booth (no second line)',
  ['ja', 'zh-Hans', 'zh-Hant', 'de', 'fr', 'es'].every(
    (language) => buildPreferenceSystemPrompt(META, language, true).split('Language:\n').length === 2
  )
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall extractor prompt checks passed');
