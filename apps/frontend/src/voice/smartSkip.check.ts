/**
 * Executable check for the voice verbosity gate. No test runner is configured
 * in this repo, so this is a plain script:
 *
 *   npx tsx apps/frontend/src/voice/smartSkip.check.ts
 *
 * Every fixture below is a real utterance from the UIST 2026 study corpus.
 * Accuracy of the classifier against the whole corpus is checked separately by
 * `scripts/validate-voice-classifier.ts`, which needs the (gitignored) logs;
 * this file is the part that runs on a clean checkout.
 *
 * Exit code 0 means every case passed.
 */
import { classifyUtterance } from './classifyUtterance';
import { decideVoiceOutput, shortenForBrief, trigramSimilarity, normalizeForCompare } from './smartSkip';
import { resolveUtterance } from './resolveUtterance';
import {
  DEFAULT_VOICE_VERBOSITY,
  SPOKEN_BREVITY_VOICE_VERBOSITY,
  defaultVerbosityFor,
  VOICE_CATEGORIES,
  VOICE_VERBOSITY_PRESETS,
  matchPreset,
  parseVerbosity,
  serializeVerbosity,
  type VoiceCategory,
  type VoiceVerbositySettings,
} from './verbosity';
// The agent's own notices, read from the agent workspace so a reworded notice
// is checked against the classifier rather than against a copy of itself.
import * as agentNoticesModule from '../../../tuning-agent/src/core/agentNotices';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function settings(
  preset: 'full' | 'balanced' | 'minimal',
  overrides: Partial<VoiceVerbositySettings> = {}
): VoiceVerbositySettings {
  return { preset, ...VOICE_VERBOSITY_PRESETS[preset], ...overrides };
}

function decide(
  text: string,
  config: VoiceVerbositySettings,
  extra: {
    visibleLabels?: string[];
    screenTitle?: string | null;
    recentSpoken?: string[];
    consecutiveCount?: number;
  } = {}
) {
  return decideVoiceOutput({
    text,
    classification: classifyUtterance(text),
    settings: config,
    visibleLabels: extra.visibleLabels ?? [],
    screenTitle: extra.screenTitle ?? null,
    recentSpoken: extra.recentSpoken ?? [],
    consecutiveCount: extra.consecutiveCount ?? 0,
  });
}

// -----------------------------------------------------------------------------
section('1. classifier — real utterances, one per planner tool');
// -----------------------------------------------------------------------------
const CLASSIFIER_FIXTURES: Array<[string, VoiceCategory]> = [
  ['Moving on to showtimes.', 'nav'],
  ['Great, moving on to theaters.', 'nav'],
  ['Going back to the date options.', 'nav'],
  ['Stepping back toward theater choices.', 'nav'],
  ['Confirming your booking for Tiny Picnic at Maple Family Screens.', 'nav'],
  ['Selecting Saturday, March 14.', 'select'],
  ['Selecting the 6:40 PM showtime.', 'select'],
  ['Going with Picture Shack.', 'select'],
  ['Switching to Metro 8, the closer theater with reserved seating.', 'select'],
  ['Selecting seats E4 and E5.', 'select'],
  ["I'm highlighting the PG options.", 'view'],
  ["I'm showing each showtime's end time.", 'view'],
  ['Showing the action movies.', 'view'],
  ['Sorting theaters by distance, nearest first.', 'view'],
  ['Narrowing to showtimes that end before 10 p.m.', 'view'],
  ['Resetting the movie list for your updated rating preference.', 'view'],
  ['What kind of movie are you in the mood for today?', 'respond'],
  ['None of these showtimes finish by 10 PM. Would you like to go back?', 'respond'],
  ['Between the two family picks, Tiny Picnic is shorter at 1h 31m. Which one?', 'respond'],
];
for (const [text, expected] of CLASSIFIER_FIXTURES) {
  const actual = classifyUtterance(text).category;
  check(`${expected.padEnd(7)} "${text.slice(0, 52)}"`, actual === expected, `got ${actual}`);
}

check(
  'unrecognised phrasing falls back to respond (the never-silenced category)',
  classifyUtterance('Hmm, that one is tricky.').category === 'respond'
);
check('question detection', classifyUtterance('Which one would you like?').hasQuestion);
check('no false question', !classifyUtterance('Moving on to showtimes.').hasQuestion);

// -----------------------------------------------------------------------------
section('2. agent tag wins over the heuristic, unknown tags fall through');
// -----------------------------------------------------------------------------
check(
  'a tagged tool overrides the text reading',
  resolveUtterance('highlight', 'Moving on to showtimes.').category === 'view'
);
check('tagged source is reported', resolveUtterance('next', 'anything').source === 'agent');
check(
  'an unknown tag degrades to the classifier instead of throwing',
  resolveUtterance('someToolFromAnotherBranch', 'Moving on to showtimes.').category === 'nav'
);
check('untagged source is reported', resolveUtterance(null, 'Hello.').source === 'heuristic');

// -----------------------------------------------------------------------------
section('3. presets');
// -----------------------------------------------------------------------------
check(
  'full speaks every category verbatim',
  VOICE_CATEGORIES.every((c) => VOICE_VERBOSITY_PRESETS.full.categories[c] === 'speak')
);
check('full disables the smart layer, so it is a clean control condition', !VOICE_VERBOSITY_PRESETS.full.smartSkip);
check(
  'respond is never silent in any preset',
  (['full', 'balanced', 'minimal'] as const).every(
    (p) => VOICE_VERBOSITY_PRESETS[p].categories.respond !== 'silent'
  )
);
check(
  'system is always spoken in every preset',
  (['full', 'balanced', 'minimal'] as const).every(
    (p) => VOICE_VERBOSITY_PRESETS[p].categories.system === 'speak'
  )
);
check('the default is balanced', DEFAULT_VOICE_VERBOSITY.preset === 'balanced');

check(
  'full: narration is spoken unchanged',
  decide('Selecting Saturday, March 14.', settings('full')).mode === 'speak'
);
check(
  'balanced: a selection is silent',
  decide('Selecting Saturday, March 14.', settings('balanced')).mode === 'silent'
);
check(
  'balanced: a screen change keeps a shortened cue',
  decide("I'm highlighting the PG options.", settings('balanced')).mode === 'brief'
);
check(
  'balanced: conversation is untouched',
  decide('What kind of movie are you in the mood for today?', settings('balanced')).mode === 'speak'
);
check(
  'minimal: conversation is shortened but never silent',
  decide('What kind of movie are you in the mood for?', settings('minimal')).mode === 'brief'
);

// -----------------------------------------------------------------------------
section('3b. when the planner writes for the ear, the gate stops re-cutting');
// -----------------------------------------------------------------------------
{
  const ear = SPOKEN_BREVITY_VOICE_VERBOSITY;
  check(
    'nothing is silenced or shortened by category any more',
    VOICE_CATEGORIES.every((c) => ear.categories[c] === 'speak')
  );
  check('but the session-state rules stay on — they have no upstream twin', ear.smartSkip);
  check(
    'the label is honest: this is not the `full` preset',
    matchPreset({ categories: ear.categories, smartSkip: ear.smartSkip }) === 'custom' &&
      ear.preset === 'custom'
  );
  check(
    'a study session is never given it, whatever the flag says',
    defaultVerbosityFor(false, true).preset === 'full' &&
      defaultVerbosityFor(false, true).smartSkip === false
  );
  check(
    'a demo without it still gets balanced',
    defaultVerbosityFor(true, false).preset === 'balanced'
  );
  check('a demo with it gets this one', defaultVerbosityFor(true, true) === ear);

  // The three the prompt cannot guarantee, proven still standing.
  const repeated = 'Which theater would you like?';
  check(
    'a repeated question is still shortened rather than silenced',
    decide(repeated, ear, { recentSpoken: [repeated] }).mode !== 'silent'
  );
  check(
    'an error is still spoken in full',
    decide('Planner request failed this turn. Please try again shortly.', ear, {
      recentSpoken: ['Planner request failed this turn. Please try again shortly.'],
    }).mode === 'speak'
  );
  check(
    'a short sentence the planner wrote for the ear is spoken as written',
    decide('Showing PG-13-or-lower movies.', ear).spokenText === 'Showing PG-13-or-lower movies.'
  );
  check(
    '...which `balanced` would have cut',
    decide('Showing PG-13-or-lower movies.', settings('balanced')).spokenText !==
      'Showing PG-13-or-lower movies.'
  );
}

// -----------------------------------------------------------------------------
section('4. the question floor — the guarantee that makes aggressive presets safe');
// -----------------------------------------------------------------------------
{
  const withQuestion = decide(
    "I'm showing the end times now. Which one works for you?",
    settings('minimal')
  );
  check('a narration utterance carrying a question is not silenced', withQuestion.mode === 'brief');
  check(
    'and what survives is the question',
    withQuestion.spokenText === 'Which one works for you?',
    withQuestion.spokenText
  );
  check('the floor is recorded', (withQuestion.rule ?? '').includes('question-floor'));

  const noQuestion = decide("I'm showing the end times now.", settings('minimal'));
  check('the same utterance without a question is silenced', noQuestion.mode === 'silent');

  const repeated = decide('Which date works best for you?', settings('balanced'), {
    recentSpoken: ['Which date works best for you?'],
  });
  check('even an exact repeat of a question stays audible', repeated.mode === 'brief');
}

// -----------------------------------------------------------------------------
section('5. smart rules');
// -----------------------------------------------------------------------------
{
  const text = 'Showing the theater distances.';
  const repeat = decide(text, settings('full', { smartSkip: true }), {
    recentSpoken: [text],
  });
  check('R1 exact repeat is silenced', repeat.mode === 'silent', repeat.mode);
  check('R1 names itself', repeat.rule === 'exact-repeat', String(repeat.rule));

  const nearNarration = decide('Showing the theater distances now.', settings('full', { smartSkip: true }), {
    recentSpoken: ['Showing the theater distances.'],
  });
  check('R2 near-duplicate narration is silenced', nearNarration.mode === 'silent', `${nearNarration.mode}/${nearNarration.rule}`);

  const near = decide('I can book either 6:20 PM or 8:10 PM. Which time works for you.', settings('full', { smartSkip: true }), {
    recentSpoken: ['I can book either 6:20 PM or 8:10 PM. Which showtime do you want.'],
  });
  check('R2 catches a near-duplicate of conversation too', near.rule === 'near-duplicate', String(near.rule));
  check('...but shortens it rather than muting it', near.mode === 'brief', near.mode);

  const distinct = decide('Sorting theaters by distance, nearest first.', settings('full', { smartSkip: true }), {
    recentSpoken: ['What kind of movie are you in the mood for.'],
  });
  check('R2 does not fire on unrelated text', distinct.mode === 'speak', String(distinct.rule));

  const onScreen = decide('Selecting Saturday, March 14.', settings('full', { smartSkip: true }), {
    visibleLabels: ['Friday, March 13', 'Saturday, March 14', 'Sunday, March 15'],
  });
  check('R3 silences narration whose every word is on screen', onScreen.mode === 'silent', String(onScreen.rule));

  const offScreen = decide('Selecting Saturday, March 14.', settings('full', { smartSkip: true }), {
    visibleLabels: ['Lantern Bakery', 'Pocket Parade'],
  });
  check('R3 leaves narration alone when the screen does not carry it', offScreen.mode === 'speak');

  const readback = decide(
    'The times that end by 2 PM are 10:50 AM, 12:20 PM, and 2:00 PM. Which of those would you like?',
    settings('balanced'),
    { visibleLabels: ['10:50 AM', '12:20 PM', '2:00 PM', '3:50 PM'] }
  );
  check('R5 shortens a read-back of on-screen options', readback.mode === 'brief', String(readback.rule));
  check(
    'R5 keeps the question and drops the recital',
    readback.spokenText === 'Which of those would you like?',
    readback.spokenText
  );

  const twoLabels = decide(
    'The times that end by 2 PM are 10:50 AM and 12:20 PM. Which of those would you like?',
    settings('balanced'),
    { visibleLabels: ['10:50 AM', '12:20 PM', '3:50 PM'] }
  );
  check('R5 needs three labels, not two', twoLabels.mode === 'speak', String(twoLabels.rule));

  const monologue = decide('Showing the theater distances.', settings('full', { smartSkip: true }), {
    consecutiveCount: 2,
  });
  check('R4 silences narration on the third back-to-back utterance', monologue.mode === 'silent');
  const monologueTalk = decide('Here is what I found for you today.', settings('full', { smartSkip: true }), {
    consecutiveCount: 2,
  });
  check('R4 only shortens conversation, never silences it', monologueTalk.mode === 'brief');
  const secondUtterance = decide('Showing the theater distances.', settings('full', { smartSkip: true }), {
    consecutiveCount: 1,
  });
  check('R4 leaves the common two-utterance turn intact', secondUtterance.mode === 'speak');

  const off = decide('Showing the theater distances.', settings('full'), {
    recentSpoken: ['Showing the theater distances.'],
    consecutiveCount: 5,
  });
  check('every smart rule is off under the full preset', off.mode === 'speak', String(off.rule));
}

// -----------------------------------------------------------------------------
section('5b. conversation is never silenced, by any layer');
// -----------------------------------------------------------------------------
{
  // The agent repeats its failure notices verbatim while it keeps failing, and
  // those notices contain no question. If the repeat rules could mute `respond`
  // the participant would speak and hear nothing while the screen sat still —
  // measured at 16 of 28 error notices in the study corpus before this guard.
  const NOTICES = [
    'Planner request failed this turn. Please try again shortly.',
    'None of the options match that filter. Let me try a different approach.',
    'Something went wrong — let me try again.',
  ];
  for (const notice of NOTICES) {
    for (const preset of ['balanced', 'minimal'] as const) {
      const repeated = decide(notice, settings(preset), { recentSpoken: [notice, notice] });
      check(
        `${preset}: repeated "${notice.slice(0, 34)}…" stays audible`,
        repeated.mode !== 'silent',
        `${repeated.mode}/${repeated.rule}`
      );
      check(`  ...and keeps some words`, repeated.spokenText.trim().length > 0);
    }
  }

  const monologuingNotice = decide(NOTICES[0], settings('minimal'), {
    recentSpoken: [NOTICES[0]],
    consecutiveCount: 6,
  });
  check(
    'every rule stacked at once still cannot mute conversation',
    monologuingNotice.mode !== 'silent',
    `${monologuingNotice.mode}/${monologuingNotice.rule}`
  );

  // The one way conversation goes quiet is the participant asking for it — and
  // even then an error still speaks, because it is its own category.
  const chosenSilence = settings('minimal', {
    categories: { ...VOICE_VERBOSITY_PRESETS.minimal.categories, respond: 'silent' },
  });
  check(
    'an explicit Silent on conversation is honoured',
    decide('Here is what I found for you.', chosenSilence).mode === 'silent'
  );
  check(
    '...but a question still gets through',
    decide('Which showtime would you like?', chosenSilence).mode === 'brief'
  );
  check(
    '...and so does an error',
    decide(NOTICES[0], chosenSilence, { recentSpoken: [NOTICES[0]] }).mode === 'speak'
  );
}

// -----------------------------------------------------------------------------
section('5c. defects found by replaying the corpus');
// -----------------------------------------------------------------------------
{
  // "p.m." is not a sentence end. Splitting there leaves the tail of the
  // question as the only "question", and that fragment is what gets spoken.
  const pm = 'There is one showtime that fits your 6 p.m. cutoff. Want to go with 3:40 p.m. or the later one?';
  check(
    'an abbreviation does not truncate the question',
    shortenForBrief(pm, classifyUtterance(pm)) === 'Want to go with 3:40 p.m. or the later one?',
    shortenForBrief(pm, classifyUtterance(pm))
  );

  // The verb alternation must be word-bounded or the prefix slice lands
  // mid-word: "Moving toward the seat map." -> "Ward the seat map."
  for (const text of ['Moving toward the seat map.', 'Moving onward to seats.', 'Moving on to showtimes.']) {
    const brief = shortenForBrief(text, classifyUtterance(text));
    check(`"${text}" does not shorten into a word fragment -> "${brief}"`, !/^Ward\b|^ard\b|^rd\b/.test(brief));
  }

  // Templated narration about different days must not dedupe, and the
  // distinguishing word is often the first one.
  const sunday = decide('Saturday works best for your evening plan.', settings('full', { smartSkip: true }), {
    recentSpoken: ['Sunday works best for your evening plan.'],
  });
  check('a different day is not a repeat, even as the first word', sunday.mode === 'speak', String(sunday.rule));

  // The stage heading must not be able to satisfy the on-screen rule alone.
  const seats = decide('Selecting seats E4 and E5.', settings('full', { smartSkip: true }), {
    visibleLabels: ['A1', 'A2', 'B7'],
    screenTitle: 'Select Seats',
  });
  check('the heading alone does not prove an utterance is on screen', seats.mode === 'speak', String(seats.rule));

  // "Keeping only …" is a filter, not a choice.
  check(
    '"Keeping only the 6 p.m. shows." reads as a view change',
    classifyUtterance('Keeping only the 6 p.m. shows.').category === 'view'
  );
  check(
    '"Keeping Picture Shack." still reads as a selection',
    classifyUtterance('Keeping Picture Shack.').category === 'select'
  );

  // The agent does not tag its status text, so it has to be recognised.
  check(
    'a planner failure is recognised as a system message',
    classifyUtterance('Planner request failed this turn. Please try again shortly.').category === 'system'
  );
  check(
    'so is a host-connection notice',
    classifyUtterance('The host connection is not ready yet. I will retry once the host is available.')
      .category === 'system'
  );
}

// -----------------------------------------------------------------------------
section('5d. defects found by replaying the corpus a second time');
// -----------------------------------------------------------------------------
{
  const on = settings('full', { smartSkip: true });

  // R2 — `distinguishingTokens` sees only numbers, dates and proper nouns, so a
  // sentence that differs by an ordinary word scored as a repeat and, for a
  // narration category, was muted. Opposite actions, silently dropped.
  check(
    'a changed sort criterion is not a repeat',
    decide('Sorting theaters by distance.', on, {
      recentSpoken: ['Sorting theaters by price.'],
    }).mode === 'speak'
  );
  check(
    'a reversed time bound is not a repeat',
    decide('Narrowing to shows that start after 6.', on, {
      recentSpoken: ['Narrowing to shows that start before 6.'],
    }).mode === 'speak'
  );
  check(
    'a changed field is not a repeat',
    decide("I'm adding each movie's rating to the list.", on, {
      recentSpoken: ["I'm adding each movie's genre to the list."],
    }).mode === 'speak'
  );
  check(
    'selecting is not a repeat of highlighting the same option',
    decide('Selecting Sunday, March 15th.', on, {
      recentSpoken: ['Highlighting Sunday, March 15th.'],
    }).mode === 'speak'
  );
  check(
    'a genuine reword of the same sentence is still a repeat',
    decide("I'm highlighting the PG options.", on, {
      recentSpoken: ['Highlighting the PG options.'],
    }).rule === 'near-duplicate'
  );

  // R3 — `contentTokens` dropped every pure-digit token, which is the one that
  // says WHICH option. "Selecting March 20." reduced to "march", a word every
  // date label carries, so it counted as already on screen.
  const dates = { visibleLabels: ['Friday, March 13', 'Saturday, March 14'], screenTitle: 'Select Show Date' };
  check(
    'a date that is not on screen is spoken',
    decide('Selecting March 20.', on, dates).mode === 'speak'
  );
  check(
    'a date that is on screen is still silenced',
    decide('Selecting March 14.', on, dates).rule === 'on-screen-narration'
  );
  check(
    'seat ids are compared, not discarded',
    decide('Selecting seats E7 and E8.', on, {
      visibleLabels: ['E4', 'E5', 'E6'],
      screenTitle: 'Select Seats',
    }).mode === 'speak'
  );
  check(
    '...and seats that ARE on screen still silence the narration',
    decide('Selecting seats E4 and E5.', on, {
      visibleLabels: ['E4', 'E5', 'E6'],
      screenTitle: 'Select Seats',
    }).rule === 'on-screen-narration'
  );

  // R5 — label containment had no token boundary, so "1:45 PM" matched inside
  // "11:45 PM" and "2:00 PM" inside "12:00 PM". Ordinary collisions with
  // 12-hour labels, each one inflating the count toward the read-back cut.
  const times = { visibleLabels: ['1:45 PM', '2:00 PM', '9:30 PM'] };
  check(
    'a label found only inside a longer time is not a recital',
    decide(
      'The last two are at 11:45 PM and 12:00 PM, and 9:30 PM is nearly full. Do you want the late one?',
      on,
      times
    ).rule === null
  );
  check(
    'a real recital of three visible labels is still trimmed to the question',
    decide(
      'The showtimes that end by 2 p.m. are 1:45 PM, 2:00 PM, and 9:30 PM. Which one works?',
      on,
      times
    ).rule === 'list-readback'
  );
}

// -----------------------------------------------------------------------------
section('5e. defects found in the 2026-10-17 demo traces');
// -----------------------------------------------------------------------------
{
  const on = settings('full', { smartSkip: true });

  // R2 — `distinguishingTokens` skipped only the first word of the whole
  // utterance, so the capital that opens a SECOND sentence counted as a proper
  // noun. "Which" made this pair differ on names while scoring 0.894 on
  // trigrams, and the restatement was spoken in full straight after the
  // original.
  const restated = decide('Both are Standard. Which time would you like?', on, {
    recentSpoken: ['Both showtimes are Standard; which time would you like?'],
  });
  check(
    'a sentence-initial capital after a full stop is not a proper noun',
    restated.rule === 'near-duplicate',
    `${restated.mode}/${restated.rule}`
  );
  check('...and the restatement keeps only its question', restated.spokenText === 'Which time would you like?', restated.spokenText);
  const afterSemicolon = decide('Both are Standard; Which time would you like?', on, {
    recentSpoken: ['Both showtimes are Standard; which time would you like?'],
  });
  check('the same holds after a semicolon', afterSemicolon.rule === 'near-duplicate', String(afterSemicolon.rule));

  // The guard still has to do its job: real names and dates keep two
  // utterances about different options apart however templated the wording.
  const otherDate = decide('Choosing Mar 15 (Sun) for your show date.', on, {
    recentSpoken: ['Choosing Mar 14 (Sat) for your show date.'],
  });
  check('a different date still differs', otherDate.mode === 'speak', `${otherDate.mode}/${otherDate.rule}`);
  const otherTheater = decide('Emagine Royal Oak has the fewest screens.', on, {
    recentSpoken: ['Redford Theatre has the fewest screens.'],
  });
  check('a different theater still differs', otherTheater.mode === 'speak', `${otherTheater.mode}/${otherTheater.rule}`);
  // A full stop inside an abbreviation is not a sentence end, so the name
  // after "p.m." must still count.
  const afterAbbreviation = decide('Showing the 6 p.m. Emagine show.', on, {
    recentSpoken: ['Showing the 6 p.m. Redford show.'],
  });
  check('a name after "p.m." still distinguishes', afterAbbreviation.mode === 'speak', `${afterAbbreviation.mode}/${afterAbbreviation.rule}`);
}

// -----------------------------------------------------------------------------
section('6. system messages are outside the mechanism');
// -----------------------------------------------------------------------------
{
  const decision = decideVoiceOutput({
    text: 'Planner request failed this turn. Please try again shortly.',
    classification: { ...classifyUtterance('Planner request failed this turn.'), category: 'system' },
    settings: settings('minimal'),
    visibleLabels: [],
    screenTitle: null,
    recentSpoken: ['Planner request failed this turn. Please try again shortly.'],
    consecutiveCount: 9,
  });
  check('an error is spoken in full regardless of preset and rules', decision.mode === 'speak');
  check('and is never rewritten', decision.spokenText.startsWith('Planner request failed'));
}

// -----------------------------------------------------------------------------
section('7. the brief shortener');
// -----------------------------------------------------------------------------
const BRIEF_FIXTURES: Array<[string, string]> = [
  ['Moving on to showtimes.', 'Showtimes.'],
  ['Great, moving on to theaters.', 'Theaters.'],
  ['Going back to the date options.', 'The date options.'],
  ['Selecting Saturday, March 14.', 'Saturday, March 14.'],
  ["I'm highlighting the PG options.", 'The PG options.'],
  // The shared link-word tail (`LINK_WORDS` in classifyUtterance). Each of
  // these shortened to a dangling fragment while only `nav.transition` carried
  // it — 59 utterances in the recorded corpus, all read aloud.
  ['Saturday is set. Moving to showtimes.', 'Showtimes.'],
  ['Cedar Commons 6 is set. Moving on to dates.', 'Dates.'],
  ['The date is locked in. Next up, showtimes.', 'Showtimes.'],
  ['Narrowing to IMAX showtimes.', 'IMAX showtimes.'],
  ['Filtering to showtimes ending by 10 p.m.', 'Showtimes ending by 10 p.m.'],
  [
    'Confirming your booking for Tiny Picnic at Storybook Cinema.',
    'Tiny Picnic at Storybook Cinema.',
  ],
  [
    'Going back from showtimes so you can change the movie.',
    'Showtimes so you can change the movie.',
  ],
  [
    'Sure — here is a quick feel for each one. Lantern Bakery is a gentle fantasy-drama. Which one sounds closest to your mood?',
    'Which one sounds closest to your mood?',
  ],
];
for (const [input, expected] of BRIEF_FIXTURES) {
  const actual = shortenForBrief(input, classifyUtterance(input));
  check(`"${input.slice(0, 44)}" -> "${expected}"`, actual === expected, `got "${actual}"`);
}
check(
  'a shortening that would save nothing returns the original',
  shortenForBrief('Showtimes.', classifyUtterance('Showtimes.')) === 'Showtimes.'
);
check(
  'an over-long question is kept whole rather than cut into a fragment',
  shortenForBrief(
    'Which of these would you prefer given everything you have told me about the evening, the budget and the seating?',
    classifyUtterance('Which of these would you prefer given everything you have told me about the evening, the budget and the seating?')
  ).endsWith('?')
);
check(
  'a shortening left with no words at all returns the original',
  shortenForBrief('Confirming your booking.', classifyUtterance('Confirming your booking.')) ===
    'Confirming your booking.'
);
check(
  'the link-word tail cannot eat into the following word',
  classifyUtterance('Additional seats are shown for row F.').category === 'respond'
);
check(
  'brief never returns empty',
  (['Moving on.', 'Ok.', 'Selecting.', 'Showing.'] as const).every(
    (t) => shortenForBrief(t, classifyUtterance(t)).trim().length > 0
  )
);

// -----------------------------------------------------------------------------
section('8. similarity metric');
// -----------------------------------------------------------------------------
check('identical strings score 1', trigramSimilarity('abc def', 'abc def') === 1);
check('disjoint strings score 0', trigramSimilarity('aaaa', 'bbbb') === 0);
check('empty input is safe', trigramSimilarity('', 'abc') === 0);
check(
  'the threshold separates the corpus near-duplicates from distinct utterances',
  trigramSimilarity(
    normalizeForCompare('I can book either 6:20 PM or 8:10 PM. Which showtime do you want?'),
    normalizeForCompare('I can book either 6:20 PM or 8:10 PM. Which time works for you?')
  ) >= 0.75 &&
    trigramSimilarity(
      normalizeForCompare('Moving on to showtimes.'),
      normalizeForCompare('Moving on to theaters.')
    ) < 0.75
);

// The hazard that motivates the distinguishing-token guard: templated
// narration about two *different* options is 0.82 similar as raw text.
{
  const changedDate = decide('Choosing Mar 15 (Sun) for your show date.', settings('full', { smartSkip: true }), {
    recentSpoken: ['Choosing Mar 14 (Sat) for your show date.'],
  });
  check(
    'a different date is not treated as a repeat, however similar the wording',
    changedDate.mode === 'speak',
    `${changedDate.mode}/${changedDate.rule}`
  );
  const sameDate = decide('Choosing Mar 14 (Sat) for the show date.', settings('full', { smartSkip: true }), {
    recentSpoken: ['Choosing Mar 14 (Sat) for your show date.'],
  });
  check('the same date reworded still counts as a repeat', sameDate.mode === 'silent', String(sameDate.rule));
}

// -----------------------------------------------------------------------------
section('9. settings persistence');
// -----------------------------------------------------------------------------
{
  const round = parseVerbosity(serializeVerbosity(DEFAULT_VOICE_VERBOSITY));
  check('round-trips', JSON.stringify(round) === JSON.stringify(DEFAULT_VOICE_VERBOSITY));
  check('rejects garbage', parseVerbosity('not json') === null);
  check('rejects null', parseVerbosity(null) === null);

  const partial = parseVerbosity(JSON.stringify({ preset: 'custom', categories: { nav: 'silent' } }));
  check('fills missing categories from the default', partial?.categories.respond === 'speak');
  check('keeps the stored one', partial?.categories.nav === 'silent');

  const forced = parseVerbosity(
    JSON.stringify({ preset: 'custom', categories: { system: 'silent' }, smartSkip: false })
  );
  check('a stored value can never silence system messages', forced?.categories.system === 'speak');

  const bogus = parseVerbosity(JSON.stringify({ categories: { nav: 'shout' } }));
  check('an unknown mode is ignored', bogus?.categories.nav === DEFAULT_VOICE_VERBOSITY.categories.nav);

  check(
    'matchPreset recognises a preset',
    matchPreset(VOICE_VERBOSITY_PRESETS.balanced) === 'balanced'
  );
  check(
    'matchPreset reports custom once a category is changed',
    matchPreset({
      ...VOICE_VERBOSITY_PRESETS.balanced,
      categories: { ...VOICE_VERBOSITY_PRESETS.balanced.categories, nav: 'speak' },
    }) === 'custom'
  );
  check(
    'matchPreset notices the smart layer too',
    matchPreset({ ...VOICE_VERBOSITY_PRESETS.balanced, smartSkip: false }) === 'custom'
  );
}

// -----------------------------------------------------------------------------
section('10. invariants the turn barrier depends on');
// -----------------------------------------------------------------------------
{
  // A silent decision must be unambiguous: the caller branches on it to decide
  // whether to speak or to release the agent's barrier, and must never do both.
  const cases = [
    decide('Selecting Saturday, March 14.', settings('minimal')),
    decide('What would you like?', settings('minimal')),
    decide("I'm highlighting the PG options.", settings('balanced')),
  ];
  check(
    'a silent decision carries no text, a spoken one always carries some',
    cases.every((d) => (d.mode === 'silent' ? d.spokenText === '' : d.spokenText.trim().length > 0))
  );
  check(
    'speak is always verbatim',
    decide('What kind of movie are you in the mood for today?', settings('balanced')).spokenText ===
      'What kind of movie are you in the mood for today?'
  );
}

// -----------------------------------------------------------------------------
section('11. Korean — the gate must not silence a language it cannot read');
// -----------------------------------------------------------------------------
{
  // The defect this section exists for: `normalizeForCompare` stripped every
  // non-`[a-z0-9]` character, so all Korean collapsed to ''. R1 then matched ''
  // against '' and read the second Korean utterance of a session as an exact
  // repeat of the first — and every one after it.
  check(
    'Korean survives normalisation instead of collapsing to empty',
    normalizeForCompare('상영 시간으로 이동할게요.').length > 0
  );
  check(
    'two different Korean sentences do not normalise to the same string',
    normalizeForCompare('상영 시간으로 이동할게요.') !== normalizeForCompare('좌석을 골라 주세요.')
  );

  const priorTurn = 'Street Fighter를 선택할게요.';
  const laterTurn = '어떤 좌석으로 하시겠어요?';
  check(
    'an unrelated Korean reply is not treated as a repeat of an earlier one',
    decide(laterTurn, settings('balanced'), { recentSpoken: [priorTurn] }).rule === null
  );
  check(
    // On `full` every category speaks, so the repeat rule is the only thing
    // that can change the outcome — on `balanced` the category setting has
    // already silenced `select` and the rule would have nothing left to do.
    'a genuinely repeated Korean sentence is still caught',
    decide(priorTurn, settings('full', { smartSkip: true }), { recentSpoken: [priorTurn] }).rule ===
      'exact-repeat'
  );

  // The property the whole feature rests on, restated in Korean.
  const koQuestion = '오늘 저녁에 보실 건가요?';
  check(
    'a Korean question is never silenced, even on minimal',
    decide(koQuestion, settings('minimal')).mode !== 'silent'
  );
  check(
    'a silenced Korean question keeps the question itself',
    decide(koQuestion, settings('minimal')).spokenText.includes('?')
  );

  const koFailure = '요청이 실패했어요. 다시 시도해 주세요.';
  check(
    'a Korean failure notice is recognised as system',
    classifyUtterance(koFailure).category === 'system'
  );
  check(
    'a repeated Korean failure notice stays audible',
    decide(koFailure, settings('minimal'), { recentSpoken: [koFailure, koFailure] }).mode ===
      'speak'
  );

  // Korean has no capitals, so the English sentence splitter never fired.
  const twoSentences = '11월 5일로 정했어요. 어느 극장이 좋으세요?';
  check(
    'Korean text splits into sentences',
    shortenForBrief(twoSentences, classifyUtterance(twoSentences)).length < twoSentences.length
  );

  check(
    'Korean narration is classified, not dumped into respond',
    classifyUtterance('상영 시간으로 이동할게요.').category === 'nav' &&
      classifyUtterance('Street Fighter를 선택할게요.').category === 'select' &&
      classifyUtterance('거리순으로 정렬할게요.').category === 'view'
  );
  check(
    'Korean rules report no prefix to strip — the verb is at the end',
    classifyUtterance('상영 시간으로 이동할게요.').verbPrefixLength === 0
  );
  check(
    'an unrecognised Korean sentence falls through to respond',
    classifyUtterance('그 영화는 두 시간 조금 넘어요.').category === 'respond'
  );

  // The agent tags its messages now; the tag must win over these rules.
  // (The arguments are `(agentCategory, text)`. They were the wrong way round
  // here, so the Korean sentence was read as a tag, `resolveCategoryFromTool`
  // returned null for it, and the classifier ran on the literal string
  // 'respond' — which falls through to `respond` and made the check pass
  // without testing anything.)
  check(
    'the Korean classifier really would say nav here',
    classifyUtterance('상영 시간으로 이동할게요.').category === 'nav'
  );
  check(
    'an explicit category overrides the Korean classifier',
    resolveUtterance('respond', '상영 시간으로 이동할게요.').category === 'respond'
  );

  // Korean asks with a sentence ending, not with "?". `hasQuestion` tested for
  // the character alone, so a question the planner wrote without one was
  // classified as narration and muted by `balanced` — and the question floor,
  // the guarantee the whole feature rests on, never fired.
  const KO_QUESTIONS = [
    '어느 좌석을 선택하시겠어요',
    '토요일로 할까요',
    '다른 시간대도 보여드릴까요',
    '몇 시가 좋으세요',
    '이 극장으로 괜찮으신가요',
    '이 자리 좋은가요',
    '그게 맞는가요',
    '지금이 아닌가요',
    '남은 좌석이 있나요',
  ];
  for (const text of KO_QUESTIONS) {
    check(`"${text}" reads as a question without a "?"`, classifyUtterance(text).hasQuestion);
    check(
      `...and is therefore never silenced`,
      decide(text, settings('minimal')).mode !== 'silent'
    );
  }

  const KO_STATEMENTS = [
    '토요일로 선택할게요',
    '가격순으로 정렬할게요',
    '상영 시간으로 이동할게요.',
    '좌석을 골라 주세요.',
    // "가요" here is the verb "go", not the "-ㄴ가요" question ending.
    '이제 극장으로 가요',
    '예매를 완료했어요.',
  ];
  for (const text of KO_STATEMENTS) {
    check(`"${text}" is not mistaken for a question`, !classifyUtterance(text).hasQuestion);
  }
  check(
    'Korean narration is still silenced on balanced',
    decide('토요일로 선택할게요', settings('balanced')).mode === 'silent'
  );
  check(
    'the Korean question test never fires on English',
    !classifyUtterance('Selecting Saturday, March 14.').hasQuestion &&
      !classifyUtterance('Moving on to showtimes.').hasQuestion
  );
}

// -----------------------------------------------------------------------------
section('12. Japanese and Chinese — scripts with no spaces and no case');
// -----------------------------------------------------------------------------
{
  // The agent tags its messages, so a Japanese question arrives labelled with
  // the tool it came from. `select` is silenced by `balanced`; the question
  // floor must still catch it, and the question carries no "?".
  const jaQuestion = 'どの上映時間がよろしいですか';
  const tagged = resolveUtterance('select', jaQuestion);
  check('a Japanese question without "?" reads as a question', tagged.hasQuestion);
  for (const preset of ['balanced', 'minimal'] as const) {
    const decision = decideVoiceOutput({
      text: jaQuestion,
      classification: tagged,
      settings: settings(preset),
      visibleLabels: [],
      screenTitle: null,
      recentSpoken: [],
      consecutiveCount: 0,
    });
    check(`a Japanese question tagged select is not silenced on ${preset}`, decision.mode !== 'silent');
  }
  check(
    'a full-width question mark is a question',
    classifyUtterance('Street Fighterでよろしいですか？').hasQuestion &&
      classifyUtterance('您想看哪一场？').hasQuestion
  );
  check(
    'Chinese sentence-final 吗 / 呢 / 嗎 read as questions',
    classifyUtterance('您要选这个场次吗').hasQuestion &&
      classifyUtterance('您觉得哪家影院好呢').hasQuestion &&
      classifyUtterance('您要選這個場次嗎').hasQuestion
  );
  check(
    'a Japanese statement is not a question',
    !classifyUtterance('Street Fighterを選びました。').hasQuestion &&
      !classifyUtterance('上映時間に移ります。').hasQuestion
  );

  // Normalisation used to strip kana and Han, leaving the Latin title — so two
  // different sentences about the same film normalised to "street fighter".
  const first = 'Street Fighterを選びます。';
  const second = 'Street Fighterの上映時間に移ります。';
  check(
    'two Japanese sentences sharing a Latin title normalise differently',
    normalizeForCompare(first) !== normalizeForCompare(second)
  );
  check(
    '...so the second is not an exact repeat of the first',
    decide(second, settings('full', { smartSkip: true }), { recentSpoken: [first] }).rule !== 'exact-repeat'
  );
  check(
    'a genuinely repeated Japanese sentence is still caught',
    decide(first, settings('full', { smartSkip: true }), { recentSpoken: [first] }).rule === 'exact-repeat'
  );

  // `。` ends a sentence with no space after it.
  const twoStatements = '11月5日の土曜日に決めました。次は劇場を選びます。';
  check(
    '。 splits Japanese sentences',
    shortenForBrief(twoStatements, classifyUtterance(twoStatements)) === '11月5日の土曜日に決めました。'
  );
  const zhTwo = '已经选好了周六。接下来选择影院。';
  check(
    '。 splits Chinese sentences',
    shortenForBrief(zhTwo, classifyUtterance(zhTwo)) === '已经选好了周六。'
  );

  const longReply =
    '条件に合う劇場は三つあり、どれも駐車場が無料で、指定席制です。距離が一番近いのはEmagine Royal Oakで、約十二マイルです。どの劇場にしますか？';
  const briefed = shortenForBrief(longReply, classifyUtterance(longReply));
  check(
    'a long Japanese reply briefed keeps its closing question, and only that',
    briefed === 'どの劇場にしますか？',
    briefed
  );
  const noMark =
    '条件に合う劇場は三つあり、どれも駐車場が無料です。どの劇場にしますか';
  check(
    '...and a closing question with no question mark survives as well',
    shortenForBrief(noMark, classifyUtterance(noMark)) === 'どの劇場にしますか'
  );

  const longNarration =
    '駐車場が無料で指定席制の劇場だけを残し、距離が近い順に並べ替えて、それぞれの距離も表示しました';
  const cut = shortenForBrief(longNarration, { ...classifyUtterance(longNarration), hasQuestion: false });
  check(
    'a long Japanese statement is cut at a clause or word boundary, near 45 characters',
    cut.endsWith('…') && cut.length <= 47 && !cut.includes('、…'),
    cut
  );

  check(
    'a Japanese failure notice is recognised as system',
    classifyUtterance('問題が発生しました。もう一度試します。').category === 'system' &&
      classifyUtterance('出了点问题，我再试一次。').category === 'system'
  );
  check(
    'an untagged Japanese narration falls through to respond, never to a silenceable category',
    classifyUtterance('上映時間に移ります。').category === 'respond'
  );

  // Different weekdays are different options, with or without digits.
  check(
    'Japanese weekdays distinguish otherwise-identical sentences',
    decide('土曜日に決めました。', settings('full', { smartSkip: true }), {
      recentSpoken: ['日曜日に決めました。'],
    }).rule === null
  );
}

// -----------------------------------------------------------------------------
section('13. German, French and Spanish — Latin script with accents');
// -----------------------------------------------------------------------------
{
  check(
    'accented letters survive normalisation',
    normalizeForCompare('Été, ça marche') === 'été ça marche'
  );
  const es = 'Elegí el sábado. ¿Qué cine prefiere?';
  check(
    'a Spanish ¿ opener starts a new sentence, and brief keeps the question',
    shortenForBrief(es, classifyUtterance(es)) === '¿Qué cine prefiere?'
  );
  const esNo = 'Ese horario no. Él prefiere otro. ¿Le parece bien?';
  check(
    'Spanish "no." at a sentence end is a sentence end',
    shortenForBrief(esNo, classifyUtterance(esNo)) === '¿Le parece bien?'
  );
  check(
    '"No. 5" is still an abbreviation',
    shortenForBrief('Seat No. 5 is free. Want it?', classifyUtterance('Seat No. 5 is free. Want it?')) ===
      'Want it?'
  );
  const fr = 'J’ai choisi samedi. Étape suivante : le cinéma.';
  check(
    'an accented capital starts a new sentence',
    shortenForBrief(fr, { ...classifyUtterance(fr), hasQuestion: false }) === 'J’ai choisi samedi.'
  );
  check(
    'German weekdays distinguish otherwise-identical sentences',
    decide('Ich habe Samstag gewählt.', settings('full', { smartSkip: true }), {
      recentSpoken: ['Ich habe Sonntag gewählt.'],
    }).rule === null
  );
  check(
    'a German failure notice is recognised as system',
    classifyUtterance('Die Planeranfrage ist diesmal fehlgeschlagen. Bitte versuchen Sie es gleich noch einmal.')
      .category === 'system'
  );
}

// -----------------------------------------------------------------------------
section('14. every translated agent notice is a system failure');
// -----------------------------------------------------------------------------
{
  // The agent package is CommonJS and the frontend is ESM, so under tsx the
  // namespace may arrive wrapped in `default`.
  type Notices = typeof agentNoticesModule;
  const notices: Notices =
    (agentNoticesModule as Notices).agentNotice
      ? (agentNoticesModule as Notices)
      : ((agentNoticesModule as unknown as { default: Notices }).default);
  const KEYS = [
    'hostNotReady', 'filterEmpty', 'genericFailure', 'plannerUnavailable',
    'plannerUnparseable', 'plannerInvalid', 'apiKeyRejected', 'plannerRequestFailed',
  ] as const;
  // Korean, Japanese and both Chinese packs: every notice the agent can send
  // must reach `system`, the one category outside every silencing rule. (The
  // English set predates this and is pinned by the measured corpus instead;
  // German, French and Spanish are recognised only where their wording allows.)
  for (const language of ['ko', 'ja', 'zh-Hans', 'zh-Hant']) {
    check(`the agent has ${language} notices`, notices.translatedNoticeLanguages().includes(language));
    const missed = KEYS.filter((key) => classifyUtterance(notices.agentNotice(key, language)).category !== 'system');
    check(`every ${language} notice is recognised as system`, missed.length === 0, missed.join(', '));
    const repeated = notices.agentNotice('plannerRequestFailed', language);
    check(
      `a repeated ${language} failure notice stays fully audible on minimal`,
      decide(repeated, settings('minimal'), { recentSpoken: [repeated, repeated] }).mode === 'speak'
    );
  }
}

console.log(
  failures === 0 ? '\nall voice verbosity checks passed' : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
