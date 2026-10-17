import type { VoiceCategory, VoiceMode, VoiceVerbosityPreset } from '../../voice';

/**
 * All user-facing strings for the verbosity control, kept out of the component
 * the same way `memoryFormat.ts` is kept out of `AgentMemoryPanel`.
 */

export const VOICE_PRESET_LABELS: Record<VoiceVerbosityPreset, string> = {
  full: 'Everything',
  balanced: 'Balanced',
  minimal: 'Minimal',
  custom: 'Custom',
};

export const VOICE_PRESET_HINTS: Record<VoiceVerbosityPreset, string> = {
  full: 'Speak every sentence in full — the original behaviour.',
  balanced: 'Skip what the screen already shows. Keep the conversation.',
  minimal: 'Only what you are being asked, and only the question.',
  custom: 'Your own mix.',
};

export const VOICE_CATEGORY_LABELS: Record<VoiceCategory, string> = {
  respond: 'Questions and answers',
  nav: 'Moving between steps',
  select: 'Picking an option',
  view: 'Changing what is on screen',
  system: 'Errors',
};

export const VOICE_CATEGORY_HINTS: Record<VoiceCategory, string> = {
  respond: 'What the agent asks you, and what it tells you about the options.',
  nav: '“Moving on to showtimes.” “Going back to the date options.”',
  select: '“Selecting Saturday, March 14.”',
  view: '“I’m highlighting the PG options.” “Showing each end time.”',
  system: 'Always spoken — there is no other way to notice one.',
};

export const VOICE_MODE_LABELS: Record<VoiceMode, string> = {
  speak: 'Speak',
  brief: 'Brief',
  silent: 'Silent',
};

export const VOICE_MODE_HINTS: Record<VoiceMode, string> = {
  speak: 'Read the whole sentence aloud.',
  brief: 'Read a shortened version, and show that version in the chat. A question is always kept.',
  silent: 'Do not read it aloud, and leave it out of the chat.',
};

export const SMART_SKIP_LABEL = 'Skip smartly';
export const SMART_SKIP_HINT =
  'Also drop sentences that repeat something just said, recite options already on screen, or run on without you.';

/** The pill on the composer, so the current setting is visible without opening anything. */
export function verbosityPillLabel(preset: VoiceVerbosityPreset): string {
  return VOICE_PRESET_LABELS[preset];
}
