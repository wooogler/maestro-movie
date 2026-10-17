/**
 * The slice of an agent message these helpers read. Structural on purpose:
 * the store's agent message type satisfies it, and importing that type here
 * would drag `fullTuningLayout.check.ts` (a node script, typechecked without
 * `vite/client`) through the store → spec → `studyDate.ts` chain, where
 * `import.meta.env` does not typecheck. `quickDemoCards.ts` documents the same
 * trap.
 */
export interface VoiceTranscriptMessage {
  text: string;
  voice?: {
    spoken: boolean;
    spokenText?: string;
  };
}

/**
 * In voice mode the transcript follows the ear, not the planner.
 *
 * Every planner sentence is stored in full (`addAgentMessage`) and logged as
 * such, but the verbosity gate may speak a shortened copy of it or nothing at
 * all. Showing the stored text next to a voice that said something else read as
 * a mismatch: "Redford Theatre has the fewest screens. Would you like to choose
 * it?" on screen while the speaker said only the question, and silent screen-
 * change lines ("Moving on to the confirmation screen.") appearing a few
 * hundred milliseconds before the screen moved, too briefly to be read.
 *
 * These helpers are the one rule for what the transcript shows. They change
 * nothing about what is stored or logged: `message.text` stays the full
 * sentence for the study log and replay. A message without `voice` metadata —
 * every message in text mode and in the study conditions — renders exactly as
 * it always did.
 */

/** The gate decided nobody would hear this sentence, so nobody sees it either. */
export function isSilencedInVoice(message: VoiceTranscriptMessage): boolean {
  return message.voice !== undefined && !message.voice.spoken;
}

/** What was actually said: the shortened copy when there was one, else the text. */
export function transcriptText(message: VoiceTranscriptMessage): string {
  const voice = message.voice;
  if (!voice || !voice.spoken || voice.spokenText === undefined) return message.text;
  return voice.spokenText;
}

/** True when the voice said less than the planner wrote, and the rest is worth a tap. */
export function wasShortenedInVoice(message: VoiceTranscriptMessage): boolean {
  return transcriptText(message) !== message.text;
}

/**
 * What a system message linked to this agent message should quote. A silent
 * sentence yields nothing, so the stage card falls back to the tool's own
 * reason, as it does when no agent sentence preceded it at all.
 */
export function linkedTranscriptText(message: VoiceTranscriptMessage): string | undefined {
  return isSilencedInVoice(message) ? undefined : transcriptText(message);
}

/**
 * What the GUI card says above a stage snapshot.
 *
 * The card quotes the sentence spoken over the step. When there was none, text
 * mode falls back to the tool's own `reason` — the planner's justification,
 * written for the trace, long and always in English — because with voice off it
 * is the only account of why the screen changed. In voice mode that fallback is
 * exactly the "long message nobody reads": the brevity rules now leave a
 * highlight, select or stage change with no sentence at all, so the reason
 * surfaced for the few hundred milliseconds before the next step. With voice on,
 * the step is explained by the voice or not at all; the card keeps the short
 * action label and shows no body text.
 */
export function guiStepContextText(input: {
  voiceMode: boolean;
  linkedAssistantText?: string;
  annotationReason?: string;
  actionReason?: string;
  stageDescription?: string;
  title: string;
}): string {
  const spoken = input.linkedAssistantText?.trim();
  if (spoken) return spoken;
  if (input.voiceMode) return '';

  const annotationReason = input.annotationReason?.trim();
  if (annotationReason) return annotationReason;

  const actionReason = input.actionReason?.trim();
  if (actionReason) return actionReason;

  const stageDescription = input.stageDescription?.trim();
  if (stageDescription) return stageDescription;

  return input.title;
}
