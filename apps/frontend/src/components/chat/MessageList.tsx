import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { ChatMessage } from '../../store/chatStore';
import type { UISpec } from '../../spec';
import { SystemMessage } from './SystemMessage';
import { UserMessage } from './UserMessage';
import { AgentMessage } from './AgentMessage';
import { AgentActivityOverlay } from './AgentActivityOverlay';
import { isSilencedInVoice, linkedTranscriptText } from './voiceTranscript';

interface MessageListProps {
  messages: ChatMessage[];
  activeSpec: UISpec | null;
  messageSnapshots?: Record<string, UISpec>;
  isAgentTyping?: boolean;
  /** Demo only: tick a running clock beside the working indicator. */
  showAgentElapsed?: boolean;
  speakingMessageId?: string | null;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
  onRevealHidden?: (revealed: boolean, hiddenCount: number) => void;
  onNext?: () => void;
  onFinishTask?: () => void;
  onBack?: () => void;
  onConfirm?: () => void;
  chatWidthPx?: number;
  isResizingWidth?: boolean;
  onResizeStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  showTurnSnapshots?: boolean;
  interactionLocked?: boolean;
}

export function MessageList({
  messages,
  activeSpec,
  messageSnapshots = {},
  isAgentTyping = false,
  showAgentElapsed = false,
  speakingMessageId = null,
  onSelect,
  onToggle,
  onRevealHidden,
  onNext,
  onFinishTask,
  onBack,
  onConfirm,
  chatWidthPx = 768,
  isResizingWidth = false,
  onResizeStart,
  showTurnSnapshots = false,
  interactionLocked = false,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNavigationAgentMessage = (message: ChatMessage): boolean =>
    message.type === 'agent' &&
    (message.actionTag?.toolName === 'next' || message.actionTag?.toolName === 'prev');
  // A silenced sentence has no row, so it cannot carry the live GUI either —
  // otherwise the system message it superseded would hide as well.
  const isAgentSnapshotMessage = (message: ChatMessage, index: number): boolean =>
    showTurnSnapshots &&
    message.type === 'agent' &&
    !isSilencedInVoice(message) &&
    !isToolLinkedAgentMessage(index) &&
    !isNavigationAgentMessage(message) &&
    Boolean(messageSnapshots[message.id]);

  const isToolLinkedAgentMessage = (index: number): boolean => {
    const current = messages[index];
    const next = messages[index + 1];
    if (!current || !next) return false;
    if (current.type !== 'agent' || next.type !== 'system') return false;
    if (next.annotation?.kind !== 'tool-modification') return false;
    if (next.annotation.source !== 'agent') return false;
    return current.stage === next.stage;
  };

  /**
   * A non-annotated system message (stage transition GUI) is redundant when a
   * later agent message in the same stage already carries a snapshot — the
   * snapshot will render the same GUI below the agent bubble.  Hide the system
   * message in that case so the user doesn't see the GUI twice.
   */
  const isSupersededByAgentSnapshot = (sysIndex: number): boolean => {
    if (!showTurnSnapshots) return false;
    const sysMsg = messages[sysIndex];
    if (sysMsg.type !== 'system') return false;
    // Keep tool-modification system messages (they show inline actions)
    if (sysMsg.annotation?.kind === 'tool-modification') return false;

    for (let i = sysIndex + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (
        msg.type === 'agent' &&
        msg.stage === sysMsg.stage &&
        !isNavigationAgentMessage(msg) &&
        !isToolLinkedAgentMessage(i) &&
        messageSnapshots[msg.id]
      ) {
        return true;
      }
    }
    return false;
  };

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Find the last system message index (the active one)
  const lastSystemIndex = messages.reduce(
    (lastIdx, msg, idx) => (msg.type === 'system' ? idx : lastIdx),
    -1
  );
  const latestGuiMessageId = messages.reduce<string | null>((latestId, message, index) => {
    if (message.type === 'system') {
      return message.id;
    }
    if (isAgentSnapshotMessage(message, index)) {
      return message.id;
    }
    return latestId;
  }, null);

  return (
    <div className="relative min-h-0 flex-1">
      <div className="h-full overflow-y-auto px-4">
        <div
          className="relative mx-auto flex min-h-full flex-col justify-end pb-4 pt-4"
          style={{ width: `min(100%, ${chatWidthPx}px)` }}
        >
          {onResizeStart && (
            <button
              type="button"
              onPointerDown={onResizeStart}
              aria-label="Resize chat width"
              title="Drag to resize chat width"
              className="absolute right-0 top-0 hidden h-full w-4 translate-x-full cursor-ew-resize sm:flex"
            >
              <span
                className={`absolute left-1/2 top-[38%] h-12 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
                  isResizingWidth ? 'bg-primary' : 'bg-dark-border hover:bg-dark-lighter'
                }`}
              />
            </button>
          )}
          {messages.map((message, index) => {
            if (message.type === 'system') {
              if (isSupersededByAgentSnapshot(index)) {
                return null;
              }
              const isActive = latestGuiMessageId
                ? message.id === latestGuiMessageId
                : index === lastSystemIndex;
              const previous = index > 0 ? messages[index - 1] : null;
              const linkedAssistantText =
                previous && previous.type === 'agent' && isToolLinkedAgentMessage(index - 1)
                  ? linkedTranscriptText(previous)
                  : undefined;
              const linkedAssistantSpeaking =
                previous && previous.type === 'agent' && isToolLinkedAgentMessage(index - 1)
                  ? previous.id === speakingMessageId
                  : false;
              return (
                <SystemMessage
                  key={message.id}
                  message={message}
                  isActive={isActive}
                  linkedAssistantText={linkedAssistantText}
                  linkedAssistantSpeaking={linkedAssistantSpeaking}
                  activeSpec={isActive ? activeSpec : null}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  onRevealHidden={onRevealHidden}
                  onNext={onNext}
                  onFinishTask={onFinishTask}
                  onBack={onBack}
                  onConfirm={onConfirm}
                  interactionLocked={isActive && interactionLocked}
                />
              );
            }

            if (message.type === 'user') {
              return <UserMessage key={message.id} message={message} />;
            }

            if (isToolLinkedAgentMessage(index)) {
              return null;
            }

            // Voice mode: a sentence the gate silenced was never heard, so the
            // transcript leaves it out (`voiceTranscript.ts`). Only agent
            // messages with voice metadata qualify; text mode never sets it.
            if (isSilencedInVoice(message)) {
              return null;
            }

            return (
              <AgentMessage
                key={message.id}
                message={message}
                speaking={message.id === speakingMessageId}
                snapshotSpec={
                  isAgentSnapshotMessage(message, index)
                    ? (messageSnapshots[message.id] ?? null)
                    : null
                }
                snapshotIsActive={message.id === latestGuiMessageId}
                snapshotActiveSpec={message.id === latestGuiMessageId ? activeSpec : null}
                onSnapshotSelect={onSelect}
                onSnapshotToggle={onToggle}
                onSnapshotNext={onNext}
                onSnapshotFinishTask={onFinishTask}
                onSnapshotBack={onBack}
                onSnapshotConfirm={onConfirm}
                snapshotInteractionLocked={interactionLocked && message.id === latestGuiMessageId}
              />
            );
          })}

          {/* Empty state */}
          {messages.length === 0 && !isAgentTyping && (
            <div className="py-12 text-center text-fg-faint">Loading...</div>
          )}

          {/* Scroll anchor with a small bottom spacer so the activity overlay does not sit on top of the last message */}
          <div ref={bottomRef} className={isAgentTyping ? 'h-6' : 'h-2'} />
        </div>
      </div>

      {isAgentTyping ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 px-4">
          <div className="mx-auto flex justify-center" style={{ width: `min(100%, ${chatWidthPx}px)` }}>
            <AgentActivityOverlay showElapsed={showAgentElapsed} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
