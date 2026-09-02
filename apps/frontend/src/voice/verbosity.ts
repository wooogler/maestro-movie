/**
 * Voice verbosity — how much of what the agent says is actually spoken.
 *
 * Motivation, from the UIST 2026 study corpus (132 voice-on sessions,
 * `.notes/voice-verbosity-analysis.md`): the agent narrates every GUI action it
 * takes, and participants had to sit through it. 2,255 of 4,749 utterances
 * (38.5% of all spoken words, ~66 s per session) describe something the
 * participant is already looking at.
 *
 *   P04  "the narrator has to read the script which I do not need"
 *   P21  "hearing the AI keep talking back to me when not needed is disturbing"
 *   P51  "I often had to wait for the chatbot to finish speaking before
 *         performing actions like moving back to change a selection"
 *
 * This module holds the taxonomy and the user's settings. It is deliberately
 * free of React and store imports so `chatStore` can type-import from it.
 */

/**
 * What an utterance is *for*. Derived from the planner tool the utterance
 * accompanies — `classifyUtterance` recovers it from text alone at 97.1%
 * accuracy over the recorded corpus, so the agent needs no changes.
 *
 * The taxonomy stops at four spoken categories on purpose: splitting `view`
 * into highlight/augment/refine drops accuracy to 95.7% with `augment`
 * precision at 68.5%, which is not a distinction the classifier can honestly
 * offer as a user-facing switch.
 */
export type VoiceCategory =
  /** `next` / `prev` — "Moving on to showtimes." (857 utterances) */
  | 'nav'
  /** `select` / `selectMultiple` — "Selecting Saturday, March 14." (496) */
  | 'select'
  /** `filter` `sort` `highlight` `augment` `clearModification` (902) */
  | 'view'
  /** `respond` — the actual conversation. The smart rules never mute it. (2,495) */
  | 'respond'
  /** Errors and host-status notices. Always spoken. */
  | 'system';

export const VOICE_CATEGORIES: VoiceCategory[] = [
  'respond',
  'nav',
  'select',
  'view',
  'system',
];

/** Categories the participant can actually change. */
export const CONFIGURABLE_VOICE_CATEGORIES: VoiceCategory[] = [
  'respond',
  'nav',
  'select',
  'view',
];

export type VoiceMode =
  /** Speak the utterance as written. */
  | 'speak'
  /** Speak a shortened form — always keeping the question, if there is one. */
  | 'brief'
  /** Do not speak it. The text still lands in the transcript. */
  | 'silent';

export type VoiceVerbosityPreset = 'full' | 'balanced' | 'minimal' | 'custom';

export interface VoiceVerbositySettings {
  preset: VoiceVerbosityPreset;
  categories: Record<VoiceCategory, VoiceMode>;
  /** The rule layer of §smartSkip — dedupe, on-screen, monologue cap. */
  smartSkip: boolean;
}

/**
 * `full` reproduces the study build exactly, so it stays available as a control
 * condition. Estimated savings are measured against the recorded corpus.
 */
export const VOICE_VERBOSITY_PRESETS: Record<
  Exclude<VoiceVerbosityPreset, 'custom'>,
  Omit<VoiceVerbositySettings, 'preset'>
> = {
  full: {
    categories: { respond: 'speak', nav: 'speak', select: 'speak', view: 'speak', system: 'speak' },
    smartSkip: false,
  },
  // Silences the two narration categories the screen fully carries, and keeps a
  // shortened cue for the third.
  //
  //   `select`  — the chosen option is already rendered as a filled primary
  //               button, and the utterance adds no reason clause. Highest
  //               confidence redundancy in the corpus (496 utterances).
  //   `nav`     — a stage change swaps the entire screen and the new stage
  //               heading names it. The largest bucket (857).
  //   `view`    — kept at `brief`: a filter makes options *disappear* and a
  //               highlight marks some of them, but neither shows the
  //               criterion. "The PG options." is the part worth hearing.
  //
  // What the participant is asked is untouched: `respond` stays `speak`, and
  // the smart layer trims only its on-screen read-back tail.
  balanced: {
    categories: { respond: 'speak', nav: 'silent', select: 'silent', view: 'brief', system: 'speak' },
    smartSkip: true,
  },
  // Only the conversation survives, shortened to its question.
  minimal: {
    categories: { respond: 'brief', nav: 'silent', select: 'silent', view: 'silent', system: 'speak' },
    smartSkip: true,
  },
};

export const DEFAULT_VOICE_VERBOSITY: VoiceVerbositySettings = {
  preset: 'balanced',
  ...VOICE_VERBOSITY_PRESETS.balanced,
};

/**
 * What a scanned quick-demo card runs with: everything spoken, no smart rules.
 *
 * Identical to `full` in effect, and deliberately NOT written as
 * `VOICE_VERBOSITY_PRESETS.full`. That preset is the frozen study build, kept
 * so C1-C4 stay reproducible; this is a booth choice that happens to want the
 * same volume for an unrelated reason. Aliasing them would mean a future edit
 * to either one silently moved the other.
 *
 * `balanced` is right for the full demo and wrong here, and the corpus says by
 * how much. Replaying the 8,355 recorded utterances through this gate
 * (scripts, §voice measurement):
 *
 *   - 23.7% are never spoken at all, because `nav` and `select` are silent —
 *     and on a card that lands mid-workflow, "Selecting E5 and E6" IS the
 *     result the visitor came to see.
 *   - `view` — filter, sort, highlight, augment, the mechanism the card exists
 *     to show — is `brief`, so 93.2% of adaptation narration is trimmed.
 *   - Worst, `smartSkip`'s monologue cap trips on the third utterance of a
 *     turn and silences 96.1% of adaptation narration from there on. A quick
 *     card's one exchange is usually several utterances long: augment, filter,
 *     then the question. The visitor hears the setup and not the payoff.
 *
 * All three exist to spare someone who is ten minutes into a booking. Nobody on
 * a quick card is. They have ninety seconds and one thing to notice, and the
 * failure mode here is not fatigue — it is walking away unsure anything
 * happened.
 *
 * Still only a default. The visitor can turn it down in Settings, and a value
 * they stored earlier wins, exactly as everywhere else.
 */
export const QUICK_CARD_VOICE_VERBOSITY: VoiceVerbositySettings = {
  preset: 'full',
  categories: { respond: 'speak', nav: 'speak', select: 'speak', view: 'speak', system: 'speak' },
  smartSkip: false,
};

/**
 * What a voice demo session starts from once the planner writes for the ear.
 *
 * `balanced` exists because the planner writes for a reader and the gate has to
 * cut what it wrote. When `spokenBrevity` is on (see `SPOKEN_BREVITY_RULES` in
 * `apps/tuning-agent/src/llm/llmPlanner.ts`) that premise is gone: narration of
 * a GUI action arrives as an empty string and never reaches this module at all,
 * and what does arrive was written short on purpose.
 *
 * Cutting it again is pure loss, and measured loss. The regression harness has
 * the planner writing "Showing PG-13-or-lower movies." — a whole sentence, 30
 * characters — which `balanced` classifies as `view`, hands to
 * `shortenForBrief`, and speaks as "PG-13-or-lower movies."
 *
 * `smartSkip` stays ON, and that is the point of not calling this `full`. What
 * is being removed is the SHORTENER, which now has a better-informed twin
 * upstream. The session-state rules have no twin anywhere: only the host knows
 * what the participant actually heard (R1/R2), how long they have gone without
 * a turn (R4), and that a question must never be silenced. The regression
 * harness caught three separate prompt revisions dropping a question, so that
 * floor is kept as a guarantee rather than a hope.
 *
 * `preset` is therefore `custom` and not `full`, honestly: `full` means
 * smartSkip off, and `parseVerbosity` re-derives the label from the stored
 * values rather than trusting it. Claiming `full` here would make the study log
 * name a configuration the session was not in.
 */
export const SPOKEN_BREVITY_VOICE_VERBOSITY: VoiceVerbositySettings = {
  preset: 'custom',
  categories: { respond: 'speak', nav: 'speak', select: 'speak', view: 'speak', system: 'speak' },
  smartSkip: true,
};

/**
 * What a screen starts from when nothing is stored yet.
 *
 * The verbosity gate is a booth feature, not a study condition. `balanced`
 * silences narration, which is the whole point of it — and exactly what a C3/C4
 * participant must not get by default, because the recorded study spoke every
 * utterance. `full` reproduces that build exactly, so it is the default
 * everywhere except the demo. Anyone can still change it; what matters is that
 * nobody is quietly run on a different interface.
 *
 * It lives here rather than on a page because two screens now offer the setting
 * — the booking UI and the setup screen before it — and they must agree.
 */
export function defaultVerbosityFor(
  isDemo: boolean,
  /**
   * The planner is writing for the ear this session, so the sentence arriving
   * here has already been shortened by the one component that knows what it
   * means. See `SPOKEN_BREVITY_VOICE_VERBOSITY`.
   */
  plannerWritesForTheEar = false
): VoiceVerbositySettings {
  if (!isDemo) return { preset: 'full' as const, ...VOICE_VERBOSITY_PRESETS.full };
  return plannerWritesForTheEar ? SPOKEN_BREVITY_VOICE_VERBOSITY : DEFAULT_VOICE_VERBOSITY;
}

/**
 * Planner tool → category. Only consulted when the agent tags the message; the
 * study build does not, so the heuristic classifier carries the load. Keeping
 * the map here means adding `payload.category` on the agent side later is a
 * one-line change with no taxonomy drift.
 */
export const TOOL_TO_CATEGORY: Record<string, VoiceCategory> = {
  next: 'nav',
  prev: 'nav',
  select: 'select',
  selectMultiple: 'select',
  filter: 'view',
  sort: 'view',
  highlight: 'view',
  augment: 'view',
  clearModification: 'view',
  respond: 'respond',
  system: 'system',
};

export function resolveCategoryFromTool(tool: string | null | undefined): VoiceCategory | null {
  if (!tool) return null;
  return TOOL_TO_CATEGORY[tool] ?? null;
}

/** Per-message record of what the gate decided, for the transcript and the log. */
export interface AgentMessageVoiceMeta {
  spoken: boolean;
  category: VoiceCategory;
  mode: VoiceMode;
  /** Which smart rule forced a downgrade, if any. */
  rule: string | null;
  /** Present when the spoken copy differs from the transcript copy. */
  spokenText?: string;
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

export const VOICE_VERBOSITY_STORAGE_KEY = 'tuning-movie-voice-verbosity';

const MODES: VoiceMode[] = ['speak', 'brief', 'silent'];

function isMode(value: unknown): value is VoiceMode {
  return typeof value === 'string' && (MODES as string[]).includes(value);
}

export function parseVerbosity(raw: string | null): VoiceVerbositySettings | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const rawCategories =
    record.categories && typeof record.categories === 'object' && !Array.isArray(record.categories)
      ? (record.categories as Record<string, unknown>)
      : {};

  const categories = { ...DEFAULT_VOICE_VERBOSITY.categories };
  for (const category of VOICE_CATEGORIES) {
    const value = rawCategories[category];
    if (isMode(value)) categories[category] = value;
  }
  // `system` is not negotiable: an error the participant cannot see has no
  // other channel.
  categories.system = 'speak';

  const smartSkip = typeof record.smartSkip === 'boolean' ? record.smartSkip : true;
  // Derive the preset from what was actually stored rather than trusting the
  // stored label: a hand-edited or half-written value must not make the study
  // log name a configuration the run was not in.
  return { preset: matchPreset({ categories, smartSkip }), categories, smartSkip };
}

export function serializeVerbosity(settings: VoiceVerbositySettings): string {
  return JSON.stringify(settings);
}

/** Which preset, if any, the current per-category state corresponds to. */
export function matchPreset(
  settings: Omit<VoiceVerbositySettings, 'preset'>
): VoiceVerbosityPreset {
  for (const name of ['full', 'balanced', 'minimal'] as const) {
    const preset = VOICE_VERBOSITY_PRESETS[name];
    if (preset.smartSkip !== settings.smartSkip) continue;
    const same = VOICE_CATEGORIES.every(
      (category) => preset.categories[category] === settings.categories[category]
    );
    if (same) return name;
  }
  return 'custom';
}
