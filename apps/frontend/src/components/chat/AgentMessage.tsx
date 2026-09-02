import type { AgentMessage as AgentMessageType } from '../../store/chatStore';
import type { UISpec } from '../../spec';
import { renderMessageText } from './renderMessageText';
import { MessageStageSnapshot } from './MessageStageSnapshot';
import { VOICE_CATEGORY_LABELS } from '../voice/verbosityFormat';

function voiceNoteTitle(voice: NonNullable<AgentMessageType['voice']>): string {
  const reason = voice.rule
    ? `skipped by the “${voice.rule}” rule`
    : `“${VOICE_CATEGORY_LABELS[voice.category]}” is set to ${voice.mode}`;
  return `Not read aloud — ${reason}.`;
}

interface AgentMessageProps {
  message: AgentMessageType;
  highlighted?: boolean;
  speaking?: boolean;
  syncAnchorRef?: (node: HTMLDivElement | null) => void;
  snapshotSpec?: UISpec | null;
  snapshotIsActive?: boolean;
  snapshotActiveSpec?: UISpec | null;
  onSnapshotSelect?: (id: string) => void;
  onSnapshotToggle?: (id: string) => void;
  onSnapshotNext?: () => void;
  onSnapshotFinishTask?: () => void;
  onSnapshotBack?: () => void;
  onSnapshotConfirm?: () => void;
  snapshotInteractionLocked?: boolean;
}

export function AgentMessage({
  message,
  highlighted = false,
  speaking = false,
  syncAnchorRef,
  snapshotSpec = null,
  snapshotIsActive = false,
  snapshotActiveSpec = null,
  onSnapshotSelect,
  onSnapshotToggle,
  onSnapshotNext,
  onSnapshotFinishTask,
  onSnapshotBack,
  onSnapshotConfirm,
  snapshotInteractionLocked = false,
}: AgentMessageProps) {
  const actionTag = message.actionTag;
  const voice = message.voice;
  // Voice mode hides some sentences rather than dropping them. Say so, or the
  // transcript looks like it is showing things the agent never produced.
  const voiceNote = !voice
    ? null
    : !voice.spoken
    ? { label: 'not spoken', title: voiceNoteTitle(voice) }
    : voice.spokenText !== undefined && voice.spokenText !== message.text
    ? { label: 'shortened', title: `Spoken aloud as: “${voice.spokenText}”` }
    : null;
  // Speaking is gold, not teal: the gold accent marks a live voice turn, and it has
  // to stay distinct from the teal timeline-sync highlight above it. The resting
  // bubble is teal-tinted chrome itself now, so the sync flash has to run deeper
  // teal than it does — otherwise the flash only reads via its pulse animation.
  const restingClass = speaking
    ? 'border border-accent-line/70 bg-accent/[0.10] text-info-text'
    : 'border border-info-border bg-info-bg text-info-text';
  const bubbleClass = highlighted
    ? `timeline-sync-pulse ring-2 ring-primary/60 ${restingClass}`
    : restingClass;

  return (
    <div className="flex gap-3 py-4 justify-start">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary flex items-center justify-center self-start mt-1">
        <svg
          className="w-4 h-4 text-primary-fg"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 10h.01M12 10h.01M16 10h.01M9 16h6M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </div>

      <div className="flex-1 min-w-0">
        <div ref={syncAnchorRef} className="max-w-[80%] min-w-0 rounded-2xl">
          <div className="text-sm text-info-label mb-1 flex items-center gap-2">
            <span>Agent</span>
            {actionTag ? (
              <span
                className="text-[11px] uppercase tracking-wide rounded-full px-2 py-0.5 border border-info-border text-info-text bg-info-bg"
                title={actionTag.reason}
              >
                {actionTag.toolName}
              </span>
            ) : null}
            {voiceNote ? (
              <span
                className="text-[10px] uppercase tracking-wide rounded-full px-2 py-0.5 border border-dark-border bg-dark-lighter text-fg-muted"
                title={voiceNote.title}
              >
                {voiceNote.label}
              </span>
            ) : null}
          </div>
          <div
            className={`rounded-2xl rounded-tl-sm px-4 py-2 text-base font-medium whitespace-pre-wrap break-words transition-colors duration-700 ${bubbleClass}`}
          >
            {renderMessageText(message.text)}
          </div>
        </div>
        {snapshotSpec ? (
          <div className="mt-3">
            <MessageStageSnapshot
              spec={snapshotSpec}
              isActive={snapshotIsActive}
              activeSpec={snapshotActiveSpec}
              onSelect={onSnapshotSelect}
              onToggle={onSnapshotToggle}
              onNext={onSnapshotNext}
              onFinishTask={onSnapshotFinishTask}
              onBack={onSnapshotBack}
              onConfirm={onSnapshotConfirm}
              interactionLocked={snapshotInteractionLocked}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
