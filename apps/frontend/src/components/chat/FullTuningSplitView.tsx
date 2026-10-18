import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AnimationEvent as ReactAnimationEvent } from 'react';
import { StageRenderer } from '../../renderer';
import { isBookingCompleteMeta, type UISpec, type Stage } from '../../spec';
import type {
  AgentMessage as AgentMessageType,
  AgentMessageActionTag,
  ChatMessage,
  SystemMessage as SystemMessageType,
  SystemMessageAnnotation,
  UserMessage as UserMessageType,
} from '../../store/chatStore';
import { AgentMessage } from './AgentMessage';
import { AgentActivityOverlay } from './AgentActivityOverlay';
import { ChatInput } from './ChatInput';
import { SelectionBreadcrumb } from './SelectionBreadcrumb';
import { UserMessage } from './UserMessage';
import { renderMessageText } from './renderMessageText';
import {
  guiStepContextText,
  isSilencedInVoice,
  linkedTranscriptText,
  transcriptText,
} from './voiceTranscript';
import { guiStageFitScale, splitViewLayout } from './fullTuningLayout';
import { isCompactViewport } from '../../utils/viewport';
import { useLanguage } from '../../i18n';
import type { AgentPreference } from '../../agent/protocol';
import type { AgentStepKey, UiStrings } from '../../i18n/strings';

interface FullTuningSplitViewProps {
  messages: ChatMessage[];
  activeSpec: UISpec | null;
  isAgentTyping?: boolean;
  /** Demo only: tick a running clock beside the working indicator. */
  showAgentElapsed?: boolean;
  interactionLocked?: boolean;
  speakingMessageId?: string | null;
  inputDisabled?: boolean;
  inputPlaceholder?: string;
  onSubmitInput?: (text: string) => void;
  voiceModeAvailable?: boolean;
  voiceModeEnabled?: boolean;
  voiceStatusLabel?: string | null;
  /** Raw voice machine state; the badge reads these instead of the label text. */
  voiceOutputStatus?: string | null;
  voiceInputStatus?: string | null;
  voiceError?: string | null;
  highlightVoiceToggle?: boolean;
  voiceToggleDisabled?: boolean;
  onToggleVoiceMode?: () => void;
  voiceVerbosityLabel?: string | null;
  onOpenVoiceSettings?: () => void;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
  onRevealHidden?: (revealed: boolean, hiddenCount: number) => void;
  onNext?: () => void;
  onFinishTask?: () => void;
  onBack?: () => void;
  onConfirm?: () => void;
  /**
   * Overrides the viewport-derived starting state. Only a render check passes
   * this; the app lets the breakpoint decide.
   */
  initialConversationCollapsed?: boolean;
  /**
   * Opt in to the phone layout: full-bleed stage with a floating conversation.
   * The demo sets it. The study conditions do not, so they keep the interface
   * the paper describes at every window width.
   */
  compactLayoutEnabled?: boolean;
  /**
   * Demo only: the agent's preference memory, live and forgotten, so a card
   * the agent changed because of a stored preference can name it. Absent in
   * the study conditions, where no chip is drawn and the card is unchanged.
   */
  memoryPreferences?: AgentPreference[] | null;
}

interface GuiSnapshot {
  /**
   * `stage` is a snapshot of the booking UI, taken when a system message
   * recorded a new spec. `message` is one the agent produced without touching
   * the GUI — a question, an answer, a note — carrying the spec it was said
   * over, so the booking UI stays on screen underneath it.
   *
   * The second kind exists because the transcript is collapsible, and on a
   * phone it starts collapsed. Everything the agent said that did *not* move
   * the screen used to live only in that panel: with it closed, a visitor with
   * voice off could be asked "the 7:10 or the 9:40?" and see nothing at all.
   */
  kind: 'stage' | 'message';
  id: string;
  stage: Stage;
  spec: UISpec;
  annotation?: SystemMessageAnnotation;
  linkedAssistantText?: string;
  linkedAssistantMessageId?: string;
  linkedActionTag?: AgentMessageActionTag;
  /**
   * The stored preferences behind the adaptation this card shows (demo only).
   * A stage snapshot takes them from its own annotation; a message snapshot
   * inherits its base's, because it shows the very same adapted GUI and the
   * sentence said over it is usually the one that explains the change.
   */
  memoryPreferenceIds?: string[];
  isLatest: boolean;
}

type TimelineRow =
  | {
      id: string;
      type: 'agent';
      message: AgentMessageType;
      snapshotIndex: number;
    }
  | {
      id: string;
      type: 'user';
      message: UserMessageType;
      snapshotIndex: number;
    }
  | {
      id: string;
      type: 'marker';
      snapshotIndex: number;
      label: string;
      stage: Stage;
    };

const SNAPSHOT_SYNC_BOTTOM_THRESHOLD_PX = 48;
const SNAPSHOT_SYNC_ANCHOR_BOTTOM_OFFSET_PX = 64;
const TIMELINE_SYNC_FLASH_MS = 950;
/*
  The slide's own length, in `App.css` — `gui-stage-slide-*` all run 560ms.

  These two used to disagree: the teardown fired at 420ms, which unmounted the
  outgoing panel and stripped the slide-in class off the incoming one 140ms
  before their keyframes had finished. That is a hard visual discontinuity, and
  it put a heavy commit (a whole stage tree unmounting) inside the tail of every
  transition. Teardown is now driven by the incoming panel's own `animationend`
  and this is only the fallback for when that event never arrives — a panel
  mounted under `prefers-reduced-motion`, or a browser that drops the event on a
  backgrounded tab — so it is deliberately a little longer than the animation.
*/
const GUI_STAGE_TRANSITION_MS = 560;
const GUI_STAGE_TRANSITION_FALLBACK_MS = GUI_STAGE_TRANSITION_MS + 140;


const AUTO_FOLLOW_SCROLL_SYNC_LOCK_MS = 520;
const GUI_CARD_BASE_WIDTH_PX = 440;

type GuiTransitionDirection = 'forward' | 'backward';

interface GuiTransitionState {
  outgoing: GuiSnapshot;
  direction: GuiTransitionDirection;
  incomingId: string;
}

function getSyncAnchorOffsetFromTop(containerHeight: number): number {
  return containerHeight - Math.min(
    SNAPSHOT_SYNC_ANCHOR_BOTTOM_OFFSET_PX,
    Math.max(20, containerHeight * 0.14)
  );
}

function getTimelineRowAnchorOffset(
  rowHeight: number,
  rowType: TimelineRow['type'] = 'agent'
): number {
  void rowHeight;
  void rowType;
  return 0;
}

function setRowAnchorNode(
  rowRefMap: Map<string, HTMLDivElement>,
  rowId: string,
  node: HTMLDivElement | null
) {
  if (node) {
    rowRefMap.set(rowId, node);
  } else {
    rowRefMap.delete(rowId);
  }
}

type StepLabels = UiStrings['agentStepLabels'];

const TOOL_STEP_KEYS = new Set<AgentStepKey>([
  'select',
  'selectMultiple',
  'filter',
  'sort',
  'highlight',
  'augment',
  'clearModification',
  'next',
  'prev',
]);

/** The visitor-facing phrase for a tool step, in the session's language. */
function getToolActionLabel(toolName: string, labels: StepLabels): string {
  return labels[(TOOL_STEP_KEYS.has(toolName as AgentStepKey) ? toolName : 'other') as AgentStepKey];
}

function getAgentActionLabel(actionTag: AgentMessageActionTag, labels: StepLabels): string {
  switch (actionTag.toolName) {
    case 'next':
      return labels.movedNext;
    case 'prev':
      return labels.movedBack;
    default:
      return labels.updatedGui;
  }
}

function isAgentLinkedToSystem(
  agentMessage: AgentMessageType,
  systemMessage: SystemMessageType
): boolean {
  if (systemMessage.annotation?.kind === 'tool-modification') {
    return systemMessage.annotation.source === 'agent';
  }
  return Boolean(agentMessage.actionTag);
}

function getSnapshotContextLabel(snapshot: GuiSnapshot, labels: StepLabels): string {
  if (snapshot.annotation) {
    const label = getToolActionLabel(snapshot.annotation.toolName, labels);
    // DevTools steps are an operator's, not the agent's; English is fine there.
    return snapshot.annotation.source === 'devtools' ? `DevTools: ${label}` : label;
  }
  if (snapshot.linkedActionTag) {
    return getAgentActionLabel(snapshot.linkedActionTag, labels);
  }
  return snapshot.spec.title;
}

function getSnapshotContextText(snapshot: GuiSnapshot, voiceMode: boolean): string {
  return guiStepContextText({
    voiceMode,
    linkedAssistantText: snapshot.linkedAssistantText,
    annotationReason: snapshot.annotation?.reason,
    actionReason: snapshot.linkedActionTag?.reason,
    stageDescription: snapshot.spec.description,
    title: snapshot.spec.title,
  });
}

function buildMarkerLabel(snapshot: GuiSnapshot, labels: StepLabels): string {
  if (snapshot.annotation) {
    return getSnapshotContextLabel(snapshot, labels);
  }
  if (snapshot.linkedActionTag) {
    return getSnapshotContextLabel(snapshot, labels);
  }
  return snapshot.spec.title;
}

function getCollapsedConversationStatus(params: {
  voiceModeAvailable: boolean;
  voiceModeEnabled: boolean;
  voiceStatusLabel: string | null;
  /**
   * The machine state behind the label.
   *
   * This used to substring-match `voiceStatusLabel` for English words like
   * "playing reply". That label is user-facing text, and once it was localized
   * every match failed silently: a Korean session showed the generic VOICE badge
   * forever, never Speak or Speaking. The status enum is what the label is
   * derived from, so reading it directly cannot drift with a translation.
   */
  voiceOutputStatus?: string | null;
  voiceInputStatus?: string | null;
  voiceError: string | null;
  inputDisabled: boolean;
}) {
  const {
    voiceModeAvailable,
    voiceModeEnabled,
    voiceStatusLabel,
    voiceOutputStatus,
    voiceInputStatus,
    voiceError,
    inputDisabled,
  } = params;

  if (voiceError) {
    return {
      badge: 'Error',
      text: voiceError,
      compactText: 'Voice error',
      badgeClass: 'border-danger bg-danger/12 text-fg',
    };
  }

  if (voiceModeEnabled) {
    if (voiceOutputStatus === 'playing' || voiceOutputStatus === 'synthesizing') {
      return {
        badge: 'Speaking',
        text: voiceStatusLabel ?? 'The agent reply is still playing.',
        compactText: 'Reply playing',
        badgeClass: 'border-accent-line/60 bg-accent/12 text-fg',
      };
    }

    if (voiceInputStatus === 'transcribing') {
      return {
        badge: 'Working',
        text: voiceStatusLabel ?? 'Processing what you just said.',
        compactText: 'Processing speech',
        badgeClass: 'border-dark-border bg-dark-light text-fg',
      };
    }

    if (voiceInputStatus === 'listening' || voiceInputStatus === 'capturing') {
      return {
        badge: 'Speak',
        text: 'You can speak now.',
        compactText: 'Speak now',
        badgeClass: 'border-accent-line/60 bg-accent/12 text-fg',
      };
    }

    return {
      badge: 'Voice',
      text:
        voiceStatusLabel ??
        (inputDisabled ? 'Waiting for the agent to be ready.' : 'Voice mode is on.'),
      compactText: inputDisabled ? 'Waiting...' : 'Voice mode on',
      badgeClass: 'border-dark-border bg-dark-light text-fg',
    };
  }

  if (inputDisabled) {
    return {
      badge: 'Waiting',
      text: 'Conversation is unavailable right now.',
      compactText: 'Not ready',
      badgeClass: 'border-dark-border bg-dark-light text-fg-muted',
    };
  }

  if (voiceModeAvailable) {
    return {
      badge: 'Mic',
      text: 'Expand the conversation to turn on voice mode.',
      compactText: 'Mic off',
      badgeClass: 'border-dark-border bg-dark-light text-fg',
    };
  }

  return {
    badge: 'Type',
    text: 'Expand the conversation to type a message.',
    compactText: 'Open to type',
    badgeClass: 'border-dark-border bg-dark-light text-fg',
  };
}

export function FullTuningSplitView({
  messages,
  activeSpec,
  isAgentTyping = false,
  showAgentElapsed = false,
  interactionLocked = false,
  speakingMessageId = null,
  inputDisabled = true,
  inputPlaceholder = 'Type a message...',
  onSubmitInput,
  voiceModeAvailable = false,
  voiceModeEnabled = false,
  voiceStatusLabel = null,
  voiceOutputStatus = null,
  voiceInputStatus = null,
  voiceError = null,
  highlightVoiceToggle = false,
  voiceToggleDisabled = false,
  onToggleVoiceMode,
  voiceVerbosityLabel = null,
  onOpenVoiceSettings,
  onSelect,
  onToggle,
  onRevealHidden,
  onNext,
  onFinishTask,
  onBack,
  onConfirm,
  initialConversationCollapsed,
  compactLayoutEnabled = false,
  memoryPreferences = null,
}: FullTuningSplitViewProps) {
  const timelineContainerRef = useRef<HTMLDivElement | null>(null);
  const timelineBottomRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const activeSnapshotRef = useRef<GuiSnapshot | null>(null);
  const activeSnapshotIndexRef = useRef<number>(-1);
  const transitionTimeoutRef = useRef<number | null>(null);
  /*
    The same fact as `transitionState`, but readable synchronously. The fit-to-
    height effect below has to know a slide has started during the very commit
    that starts it, and a state update scheduled from a layout effect is not
    visible to the effects that run after it in that same commit.
  */
  const guiTransitionActiveRef = useRef(false);
  /** Which incoming snapshot the running transition belongs to, if any. */
  const transitionIncomingIdRef = useRef<string | null>(null);
  const syncHighlightTimeoutRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoFollowScrollSyncLockUntilRef = useRef(0);
  const hasAutoScrolledRef = useRef(false);
  const { s } = useLanguage();
  const guiViewportRef = useRef<HTMLDivElement>(null);
  const guiContentRef = useRef<HTMLDivElement>(null);
  const [guiScale, setGuiScale] = useState(1);
  // A phone opens on the booking UI, not on the transcript. Expanded is still
  // the right default on a desktop, where the conversation is a column beside
  // the GUI rather than a sheet on top of it — but on a phone that same default
  // meant arriving at a screen entirely covered by the transcript.
  const [conversationCollapsed, setConversationCollapsed] = useState(
    () => initialConversationCollapsed ?? (compactLayoutEnabled && isCompactViewport())
  );

  /*
    One pass, because snapshots and timeline rows are now interleaved: a stage
    snapshot comes from a system message, a message snapshot from an agent
    message that moved nothing, and both take their place in the same order the
    messages arrived. Building the snapshots first and the rows second (as this
    did) cannot express that without a second index map.
  */
  const { snapshots, timelineRows, latestSnapshotIndex, firstRowIdBySnapshotIndex } = useMemo(() => {
    const nextSnapshots: GuiSnapshot[] = [];
    const nextTimelineRows: TimelineRow[] = [];
    const nextFirstRowIdBySnapshotIndex = new Map<number, string>();
    let currentSnapshotIndex = -1;

    const registerRow = (row: TimelineRow) => {
      nextTimelineRows.push(row);
      if (!nextFirstRowIdBySnapshotIndex.has(row.snapshotIndex)) {
        nextFirstRowIdBySnapshotIndex.set(row.snapshotIndex, row.id);
      }
    };

    /** Rows that arrive before the first spec still belong to it, as before. */
    const rowSnapshotIndex = () => (currentSnapshotIndex < 0 ? 0 : currentSnapshotIndex);

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];

      if (message.type === 'system') {
        const previousMessage = index > 0 ? messages[index - 1] : null;
        const linkedAgentMessage =
          previousMessage &&
          previousMessage.type === 'agent' &&
          isAgentLinkedToSystem(previousMessage, message)
            ? previousMessage
            : null;

        const snapshot: GuiSnapshot = {
          kind: 'stage',
          id: message.id,
          stage: message.stage,
          spec: message.spec,
          annotation: message.annotation,
          // The GUI card quotes what the voice said over it, not what the
          // planner wrote; a silenced sentence quotes nothing and the card falls
          // back to the tool's reason (`voiceTranscript.ts`).
          linkedAssistantText: linkedAgentMessage ? linkedTranscriptText(linkedAgentMessage) : undefined,
          linkedAssistantMessageId: linkedAgentMessage?.id,
          linkedActionTag: linkedAgentMessage?.actionTag,
          memoryPreferenceIds: message.annotation?.preferenceIds,
          isLatest: false,
        };
        nextSnapshots.push(snapshot);
        currentSnapshotIndex = nextSnapshots.length - 1;

        registerRow({
          id: `marker-${message.id}`,
          type: 'marker',
          snapshotIndex: currentSnapshotIndex,
          label: buildMarkerLabel(snapshot, s.agentStepLabels),
          stage: message.stage,
        });
        continue;
      }

      if (message.type === 'user') {
        registerRow({
          id: message.id,
          type: 'user',
          message,
          snapshotIndex: rowSnapshotIndex(),
        });
        continue;
      }

      // An agent message immediately followed by the system message it caused
      // is folded into that snapshot, and the next iteration creates it.
      const nextMessage = messages[index + 1];
      if (nextMessage && nextMessage.type === 'system' && isAgentLinkedToSystem(message, nextMessage)) {
        continue;
      }

      // Voice mode: a sentence the gate silenced was never heard. It gets no
      // row and no card of its own — the transcript follows the ear.
      if (isSilencedInVoice(message)) {
        continue;
      }

      // Otherwise it gets a card of its own, over the spec it was said about.
      // Without a spec to sit on there is nothing to show, so the row stands
      // alone in the transcript exactly as it used to.
      const base = currentSnapshotIndex >= 0 ? nextSnapshots[currentSnapshotIndex] : null;
      if (base) {
        nextSnapshots.push({
          kind: 'message',
          // Prefixed: a stage snapshot is keyed by its system message id, and a
          // message snapshot must not collide with one.
          id: `message-${message.id}`,
          stage: base.stage,
          spec: base.spec,
          linkedAssistantText: transcriptText(message),
          linkedAssistantMessageId: message.id,
          memoryPreferenceIds: base.memoryPreferenceIds,
          isLatest: false,
        });
        currentSnapshotIndex = nextSnapshots.length - 1;
      }

      registerRow({
        id: message.id,
        type: 'agent',
        message,
        snapshotIndex: rowSnapshotIndex(),
      });
    }

    if (nextSnapshots.length > 0) {
      const latestIndex = nextSnapshots.length - 1;
      nextSnapshots[latestIndex] = {
        ...nextSnapshots[latestIndex],
        spec: activeSpec ?? nextSnapshots[latestIndex].spec,
        isLatest: true,
      };
    }

    return {
      snapshots: nextSnapshots,
      timelineRows: nextTimelineRows,
      latestSnapshotIndex: nextSnapshots.length - 1,
      firstRowIdBySnapshotIndex: nextFirstRowIdBySnapshotIndex,
    };
  }, [messages, activeSpec, s.agentStepLabels]);

  const [activeSnapshotIndex, setActiveSnapshotIndex] = useState(latestSnapshotIndex);
  const [activeSyncRowId, setActiveSyncRowId] = useState<string | null>(
    timelineRows[timelineRows.length - 1]?.id ?? null
  );
  const [flashSyncRowId, setFlashSyncRowId] = useState<string | null>(
    timelineRows[timelineRows.length - 1]?.id ?? null
  );
  const [timelineTopInsetPx, setTimelineTopInsetPx] = useState(0);
  const latestTimelineRow = timelineRows[timelineRows.length - 1] ?? null;

  const pinToLatestTimelinePosition = useCallback(() => {
    if (latestSnapshotIndex < 0 || !latestTimelineRow) return;

    setActiveSnapshotIndex((current) =>
      current === latestSnapshotIndex ? current : latestSnapshotIndex
    );
    setActiveSyncRowId((current) => (current === latestTimelineRow.id ? current : latestTimelineRow.id));
  }, [latestSnapshotIndex, latestTimelineRow]);

  useEffect(() => {
    setActiveSnapshotIndex((current) => {
      if (latestSnapshotIndex < 0) return -1;
      if (current < 0 || current > latestSnapshotIndex) return latestSnapshotIndex;
      return current;
    });
  }, [latestSnapshotIndex]);

  useEffect(() => {
    setActiveSyncRowId((current) => {
      if (timelineRows.length === 0) return null;
      if (current && timelineRows.some((row) => row.id === current)) return current;
      return timelineRows[timelineRows.length - 1]?.id ?? null;
    });
  }, [timelineRows, conversationCollapsed]);

  useEffect(() => {
    if (timelineRows.length === 0) {
      hasAutoScrolledRef.current = false;
    }
  }, [timelineRows.length]);

  useEffect(() => {
    if (!activeSyncRowId) {
      setFlashSyncRowId(null);
      return;
    }

    setFlashSyncRowId(activeSyncRowId);
    if (syncHighlightTimeoutRef.current !== null) {
      window.clearTimeout(syncHighlightTimeoutRef.current);
    }

    syncHighlightTimeoutRef.current = window.setTimeout(() => {
      setFlashSyncRowId((current) => (current === activeSyncRowId ? null : current));
      syncHighlightTimeoutRef.current = null;
    }, TIMELINE_SYNC_FLASH_MS);

    return () => {
      if (syncHighlightTimeoutRef.current !== null) {
        window.clearTimeout(syncHighlightTimeoutRef.current);
        syncHighlightTimeoutRef.current = null;
      }
    };
  }, [activeSyncRowId]);

  /*
    The inset only depends on two sizes — the container's and the first row's —
    and both are watched by the ResizeObserver below. This effect used to be
    keyed on `timelineRows`, which is a new array on every streamed token, so
    each token tore the observer down, read layout synchronously, set state,
    built a new observer, and then took the observer's initial callback: a
    second read and a second set. All of that for an inset that had not moved.
    It is keyed on the first row's identity now, which is the only thing the
    observer cannot see change on its own.
  */
  const firstTimelineRowId = timelineRows[0]?.id ?? null;
  const firstTimelineRowType = timelineRows[0]?.type ?? 'agent';

  useLayoutEffect(() => {
    const container = timelineContainerRef.current;
    if (!container) return;

    const getFirstRowNode = () =>
      firstTimelineRowId ? rowRefs.current.get(firstTimelineRowId) ?? null : null;

    const updateTopInset = () => {
      const firstRowNode = getFirstRowNode();
      const syncAnchorOffset = getSyncAnchorOffsetFromTop(container.clientHeight);
      const firstRowAnchorOffset = firstRowNode
        ? getTimelineRowAnchorOffset(firstRowNode.offsetHeight, firstTimelineRowType)
        : 24;
      const nextInset = Math.max(0, syncAnchorOffset - firstRowAnchorOffset);
      // Same value, same state object: React then skips the render outright
      // instead of committing an identical paddingTop.
      setTimelineTopInsetPx((current) => (current === nextInset ? current : nextInset));
    };

    updateTopInset();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      updateTopInset();
    });
    observer.observe(container);

    const firstRowNode = getFirstRowNode();
    if (firstRowNode) {
      observer.observe(firstRowNode);
    }

    return () => {
      observer.disconnect();
    };
  }, [firstTimelineRowId, firstTimelineRowType]);

  const syncActiveSnapshotToScroll = useCallback(() => {
    const container = timelineContainerRef.current;
    if (!container || timelineRows.length === 0) return;
    const lastRow = timelineRows[timelineRows.length - 1];

    // Before any layout read: the lock means the answer is already known.
    if (Date.now() < autoFollowScrollSyncLockUntilRef.current && latestSnapshotIndex >= 0 && lastRow) {
      pinToLatestTimelinePosition();
      return;
    }

    const remainingScroll = Math.max(
      0,
      container.scrollHeight - (container.scrollTop + container.clientHeight)
    );

    if (remainingScroll <= SNAPSHOT_SYNC_BOTTOM_THRESHOLD_PX && latestSnapshotIndex >= 0 && lastRow) {
      pinToLatestTimelinePosition();
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const syncAnchorY = containerRect.top + getSyncAnchorOffsetFromTop(container.clientHeight);
    let lastPassedRowId: string | null = null;
    let lastPassedSnapshotIndex = -1;
    let firstUpcomingRowId = timelineRows[0].id;
    let firstUpcomingSnapshotIndex = timelineRows[0].snapshotIndex;
    let firstUpcomingDistance = Number.POSITIVE_INFINITY;

    for (const row of timelineRows) {
      const node = rowRefs.current.get(row.id);
      if (!node) continue;
      const rowRect = node.getBoundingClientRect();
      const rowAnchorY = rowRect.top + getTimelineRowAnchorOffset(rowRect.height, row.type);
      if (rowAnchorY <= syncAnchorY) {
        lastPassedRowId = row.id;
        lastPassedSnapshotIndex = row.snapshotIndex;
        continue;
      }

      const distance = rowAnchorY - syncAnchorY;
      if (distance < firstUpcomingDistance) {
        firstUpcomingDistance = distance;
        firstUpcomingRowId = row.id;
        firstUpcomingSnapshotIndex = row.snapshotIndex;
      }
    }

    const nextRowId = lastPassedRowId ?? firstUpcomingRowId;
    const nextSnapshotIndex =
      lastPassedRowId !== null ? lastPassedSnapshotIndex : firstUpcomingSnapshotIndex;

    setActiveSnapshotIndex((current) =>
      current === nextSnapshotIndex ? current : nextSnapshotIndex
    );
    setActiveSyncRowId((current) => (current === nextRowId ? current : nextRowId));
  }, [latestSnapshotIndex, pinToLatestTimelinePosition, timelineRows]);

  /*
    The booking UI follows the newest snapshot whether or not the transcript is
    on screen.

    This used to be one effect that began `if (conversationCollapsed) return`,
    which meant a collapsed conversation also stopped `activeSnapshotIndex` from
    advancing. The GUI kept rendering the previous stage, `activeSnapshot.isLatest`
    was false, and the card was therefore rendered `pointer-events-none
    opacity-65` — so every tap on Continue, Back or a seat was swallowed. The
    booking UI looked entirely normal and simply did not respond, and it only
    happened with the conversation closed.
  */
  useEffect(() => {
    if (!latestTimelineRow) return;
    pinToLatestTimelinePosition();
  }, [latestTimelineRow?.id, pinToLatestTimelinePosition]);

  /*
    Unread marker for the collapsed state.

    Without it a phone visitor with voice off can be asked a question — "the
    7:10 or the 9:40?" — and see nothing at all: the reply renders only inside
    the transcript, which is display:none, and no tool ran so the stage does not
    change either. The screen simply sits there.
  */
  const [hasUnread, setHasUnread] = useState(false);
  const seenTimelineRowRef = useRef<string | null>(null);

  useEffect(() => {
    const latestId = latestTimelineRow?.id ?? null;
    if (!conversationCollapsed) {
      seenTimelineRowRef.current = latestId;
      setHasUnread(false);
      return;
    }
    if (!latestId || latestId === seenTimelineRowRef.current) return;
    // Only the agent's own turns count: echoing the visitor's message back at
    // them as "unread" would cry wolf on every send.
    if (latestTimelineRow?.type === 'agent') setHasUnread(true);
    seenTimelineRowRef.current = latestId;
  }, [conversationCollapsed, latestTimelineRow?.id, latestTimelineRow?.type]);

  // Scrolling the transcript to its newest row, on the other hand, only means
  // anything while the transcript is visible.
  useEffect(() => {
    if (conversationCollapsed || !latestTimelineRow) return;

    autoFollowScrollSyncLockUntilRef.current = Date.now() + AUTO_FOLLOW_SCROLL_SYNC_LOCK_MS;

    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
    }

    const behavior: ScrollBehavior = hasAutoScrolledRef.current ? 'smooth' : 'auto';
    autoScrollFrameRef.current = window.requestAnimationFrame(() => {
      timelineBottomRef.current?.scrollIntoView({ behavior, block: 'end' });
      autoScrollFrameRef.current = null;
    });
    hasAutoScrolledRef.current = true;
  }, [conversationCollapsed, latestTimelineRow?.id]);

  const collapsedConversationStatus = getCollapsedConversationStatus({
    voiceModeAvailable,
    voiceModeEnabled,
    voiceStatusLabel,
    voiceOutputStatus,
    voiceInputStatus,
    voiceError,
    inputDisabled,
  });
  // The arrangement rule, and why a phone gets a different one, live in
  // `fullTuningLayout.ts` so they can be asserted rather than eyeballed.
  const {
    container: containerClass,
    conversationSection: conversationSectionClass,
    showFloatingToggle,
  } = splitViewLayout(conversationCollapsed, compactLayoutEnabled);
  /*
    Ids to rail words, rebuilt only when memory changes. Unknown ids are
    dropped rather than printed: an id is the agent's, not the visitor's.
  */
  const preferenceWordsById = useMemo(() => {
    const words = new Map<string, string>();
    for (const preference of memoryPreferences ?? []) {
      if (!words.has(preference.id)) words.set(preference.id, preference.description);
    }
    return words;
  }, [memoryPreferences]);
  const describePreferences = useCallback(
    (ids: string[]) =>
      Array.from(new Set(ids))
        .map((id) => preferenceWordsById.get(id))
        .filter((label): label is string => Boolean(label)),
    [preferenceWordsById]
  );
  /*
    `syncActiveSnapshotToScroll` walks every timeline row and calls
    `getBoundingClientRect` on each. Wired straight to `onScroll` that ran once
    per scroll event — several times a frame on a trackpad — and it is also the
    one thing guaranteed to be happening while the stage slides, because the
    transcript auto-scrolls to the agent's new turn at the same moment. So it is
    collapsed to at most one pass per frame, and skipped entirely while a
    transition is in flight or the auto-follow lock is held: the snapshot it
    would pick is the one already being animated to.
  */
  const scrollSyncFrameRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (scrollSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollSyncFrameRef.current);
      }
    },
    []
  );

  const handleTimelineScroll = useCallback(() => {
    if (guiTransitionActiveRef.current) return;
    /*
      While the transcript is being auto-scrolled to its newest row, every
      scroll event the smooth scroll emits — several per frame for hundreds of
      milliseconds — is one the booking UI already knows the answer to: the
      latest snapshot. Decide that here, before a frame is even scheduled, so
      the lock costs no layout read at all; `syncActiveSnapshotToScroll` checks
      it again for a frame that was queued before the lock was taken.
    */
    if (Date.now() < autoFollowScrollSyncLockUntilRef.current) {
      pinToLatestTimelinePosition();
      return;
    }
    if (scrollSyncFrameRef.current !== null) return;
    scrollSyncFrameRef.current = window.requestAnimationFrame(() => {
      scrollSyncFrameRef.current = null;
      if (guiTransitionActiveRef.current) return;
      syncActiveSnapshotToScroll();
    });
  }, [pinToLatestTimelinePosition, syncActiveSnapshotToScroll]);

  const scrollToSnapshot = useCallback(
    (snapshotIndex: number) => {
      const container = timelineContainerRef.current;
      const targetRowId = firstRowIdBySnapshotIndex.get(snapshotIndex);
      const targetNode = targetRowId ? rowRefs.current.get(targetRowId) : null;
      const targetRow = targetRowId ? timelineRows.find((row) => row.id === targetRowId) ?? null : null;
      if (!container || !targetNode) return;

      autoFollowScrollSyncLockUntilRef.current = 0;
      setActiveSnapshotIndex(snapshotIndex);
      setActiveSyncRowId(targetRowId ?? null);
      const containerRect = container.getBoundingClientRect();
      const targetRect = targetNode.getBoundingClientRect();
      const targetTop =
        targetRect.top - containerRect.top + container.scrollTop;
      const targetAnchorOffset = getTimelineRowAnchorOffset(
        targetRect.height,
        targetRow?.type ?? 'agent'
      );
      container.scrollTo({
        top: Math.max(
          0,
          targetTop +
            targetAnchorOffset -
            getSyncAnchorOffsetFromTop(container.clientHeight)
        ),
        behavior: 'smooth',
      });
    },
    [firstRowIdBySnapshotIndex, timelineRows]
  );

  const activeSnapshot =
    snapshots[activeSnapshotIndex] ?? snapshots[latestSnapshotIndex] ?? null;
  const canGoToPreviousSnapshot = activeSnapshotIndex > 0;
  const canGoToNextSnapshot =
    activeSnapshotIndex >= 0 && activeSnapshotIndex < latestSnapshotIndex;
  const [transitionState, setTransitionState] = useState<GuiTransitionState | null>(null);

  useEffect(
    () => () => {
      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current);
      }
      if (autoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
      }
    },
    []
  );

  // Ends the transition the given snapshot started, and only that one — a late
  // `animationend` or fallback timer from a superseded slide must not unfreeze
  // the one that replaced it.
  const endGuiTransition = useCallback((incomingId: string) => {
    if (transitionIncomingIdRef.current !== incomingId) return;
    transitionIncomingIdRef.current = null;
    guiTransitionActiveRef.current = false;
    if (transitionTimeoutRef.current !== null) {
      window.clearTimeout(transitionTimeoutRef.current);
      transitionTimeoutRef.current = null;
    }
    setTransitionState((current) => (current?.incomingId === incomingId ? null : current));
  }, []);

  /*
    The slide-in panel tells us when it is done.

    `animationend` bubbles, and the stage tree underneath runs animations of its
    own (`gui-item-enter`, the text swap), so this has to check that the event
    came from this panel and names one of the slide keyframes — otherwise the
    first list item to finish fading in would tear the transition down early.
  */
  const handleIncomingAnimationEnd = useCallback(
    (event: ReactAnimationEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (!event.animationName.startsWith('gui-stage-slide-in')) return;
      const incomingId = transitionState?.incomingId;
      if (incomingId) endGuiTransition(incomingId);
    },
    [endGuiTransition, transitionState?.incomingId]
  );

  /*
    A layout effect, not a passive one, so the outgoing panel and the slide
    classes are in the DOM in the same paint that the new stage first appears
    in — and, just as importantly, so `guiTransitionActiveRef` is already set by
    the time the fit-to-height effect below runs in this same commit.
  */
  useLayoutEffect(() => {
    const previousSnapshot = activeSnapshotRef.current;
    const previousSnapshotIndex = activeSnapshotIndexRef.current;

    if (!activeSnapshot) {
      activeSnapshotRef.current = null;
      activeSnapshotIndexRef.current = activeSnapshotIndex;
      guiTransitionActiveRef.current = false;
      transitionIncomingIdRef.current = null;
      setTransitionState(null);
      return;
    }

    if (!previousSnapshot) {
      activeSnapshotRef.current = activeSnapshot;
      activeSnapshotIndexRef.current = activeSnapshotIndex;
      guiTransitionActiveRef.current = false;
      transitionIncomingIdRef.current = null;
      setTransitionState(null);
      return;
    }

    if (previousSnapshot.id !== activeSnapshot.id && previousSnapshot.stage !== activeSnapshot.stage) {
      const direction: GuiTransitionDirection =
        activeSnapshotIndex >= previousSnapshotIndex ? 'forward' : 'backward';
      guiTransitionActiveRef.current = true;
      transitionIncomingIdRef.current = activeSnapshot.id;
      setTransitionState({
        outgoing: previousSnapshot,
        direction,
        incomingId: activeSnapshot.id,
      });

      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current);
      }

      transitionTimeoutRef.current = window.setTimeout(() => {
        transitionTimeoutRef.current = null;
        endGuiTransition(activeSnapshot.id);
      }, GUI_STAGE_TRANSITION_FALLBACK_MS);
    } else if (transitionIncomingIdRef.current !== activeSnapshot.id) {
      /*
        Nothing to slide — but only tear a transition down if it is not this
        snapshot's own. `activeSnapshot` is a fresh object on every change to
        `messages` or `activeSpec`, so this effect re-runs on every streamed
        token, and once the slide has started `previousSnapshot.id` already
        equals `activeSnapshot.id`. Unguarded, the next token to arrive landed
        in this branch and cancelled the slide it was in the middle of.
      */
      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current);
        transitionTimeoutRef.current = null;
      }
      guiTransitionActiveRef.current = false;
      transitionIncomingIdRef.current = null;
      setTransitionState(null);
    }

    activeSnapshotRef.current = activeSnapshot;
    activeSnapshotIndexRef.current = activeSnapshotIndex;
  }, [activeSnapshot, activeSnapshotIndex, endGuiTransition]);

  /*
    Fit the booking stage into the height it has been given.

    Two things this must not do, both of which it used to.

    It must not recompute *during* a slide. The scale is an inline transform on
    `guiContentRef`, which is the parent of both stage panels — so recomputing it
    on the commit that starts the transition snapped the outgoing panel to the
    incoming stage's scale on frame 0 of its exit, and did so via a forced
    synchronous layout (`getComputedStyle` + `clientHeight` + `scrollHeight`)
    followed by a state update, i.e. a full re-render before paint. The scale is
    therefore frozen while a transition is running and recomputed once when it
    clears, by which point the incoming stage is the only one left to fit.

    And it must not observe `content`. `content.scrollHeight` changes on every
    frame that `.gui-item-shell` is transitioning `max-height` (380ms), so
    observing it turned any filter, sort or "Show all" into a 60Hz stream of
    re-renders of the entire split view. Only the viewport is observed; the
    stage's own height is re-read on each snapshot instead.
  */
  const guiTransitionActive = transitionState !== null;

  useLayoutEffect(() => {
    if (guiTransitionActive || guiTransitionActiveRef.current) return;
    const viewport = guiViewportRef.current;
    const content = guiContentRef.current;
    if (!viewport || !content) return;

    // `clientHeight` includes the element's own padding, and the collapsed
    // compact layout pads this viewport to keep the stage clear of the floating
    // conversation button. Padding is not room the stage gets to use.
    const availableHeight = (): number => {
      const style = window.getComputedStyle(viewport);
      const top = Number.parseFloat(style.paddingTop);
      const bottom = Number.parseFloat(style.paddingBottom);
      const padding = (Number.isFinite(top) ? top : 0) + (Number.isFinite(bottom) ? bottom : 0);
      return viewport.clientHeight - padding;
    };

    const recalc = () => {
      setGuiScale(guiStageFitScale(availableHeight(), content.scrollHeight));
    };

    recalc();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(recalc);
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [activeSnapshot?.id, guiTransitionActive]);

  return (
    <div className="min-h-0 flex-1 overflow-hidden px-2 py-2 sm:px-4 sm:py-4">
      <div className={containerClass}>
        <section className="relative min-h-0 overflow-hidden rounded-2xl border border-dark-border bg-dark px-4 py-1">
          <div className="flex h-full flex-col gap-0">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center">
              <div />
              <SnapshotNavButton
                direction="prev"
                disabled={!canGoToPreviousSnapshot}
                onClick={() => scrollToSnapshot(activeSnapshotIndex - 1)}
              />
              <div className="justify-self-end rounded-full border border-dark-border bg-dark-light/95 px-2 py-0.5 text-[11px] font-medium leading-5 text-fg-muted">
                {latestSnapshotIndex >= 0 ? `${activeSnapshotIndex + 1} / ${latestSnapshotIndex + 1}` : '0 / 0'}
              </div>
            </div>

            <div
              ref={guiViewportRef}
              className={`flex-1 overflow-hidden flex items-center justify-center px-2 sm:px-4 ${
                showFloatingToggle ? 'pb-16 lg:pb-0' : ''
              }`}
            >
              {activeSnapshot ? (
                <div
                  ref={guiContentRef}
                  className="relative mx-auto flex w-full max-w-2xl items-start justify-center"
                  style={{ transform: `scale(${guiScale})`, transformOrigin: 'center center' }}
                >
                  {/*
                    Both panels are keyed by the snapshot they show. Without a
                    key React reconciles them positionally, so moving to a new
                    stage was a mount *and* an unmount *and* another mount of a
                    full stage tree rather than one of each — three trees' worth
                    of commit work landing on the frame the slide starts on.
                  */}
                  {transitionState?.outgoing ? (
                    <div
                      key={`outgoing-${transitionState.outgoing.id}`}
                      className={`absolute inset-0 flex items-center justify-center py-1 gui-stage-panel ${
                        transitionState.direction === 'forward'
                          ? 'gui-stage-slide-out-up'
                          : 'gui-stage-slide-out-down'
                      }`}
                    >
                    <GuiSnapshotCard
                      snapshot={transitionState.outgoing}
                      voiceModeEnabled={voiceModeEnabled}
                      describePreferences={describePreferences}
                      interactive={false}
                      agentActive={false}
                      speaking={false}
                    />
                  </div>
                  ) : null}

                  <div
                    key={`incoming-${activeSnapshot.id}`}
                    onAnimationEnd={transitionState ? handleIncomingAnimationEnd : undefined}
                    className={`relative flex w-full items-center justify-center py-1 gui-stage-panel ${
                      transitionState
                        ? transitionState.direction === 'forward'
                          ? 'gui-stage-slide-in-down'
                          : 'gui-stage-slide-in-up'
                        : ''
                    }`}
                  >
                    <GuiSnapshotCard
                      snapshot={activeSnapshot}
                      voiceModeEnabled={voiceModeEnabled}
                      describePreferences={describePreferences}
                      interactive={activeSnapshot.isLatest && !interactionLocked}
                      agentActive={Boolean(isAgentTyping && activeSnapshot.isLatest)}
                      speaking={activeSnapshot.linkedAssistantMessageId === speakingMessageId}
                      onSelect={onSelect}
                      onToggle={onToggle}
                      onRevealHidden={onRevealHidden}
                      onNext={onNext}
                      onFinishTask={onFinishTask}
                      onBack={onBack}
                      onConfirm={onConfirm}
                    />
                  </div>
                </div>
              ) : (
                <div className="text-center text-sm text-fg-muted">Loading GUI history...</div>
              )}
            </div>

            <SnapshotNavButton
              direction="next"
              disabled={!canGoToNextSnapshot}
              onClick={() => scrollToSnapshot(activeSnapshotIndex + 1)}
            />
          </div>

        </section>

        {/*
          The phone's way back into the conversation. It carries the same status
          badge the collapsed bar used to show, so a visitor who is not looking
          at the transcript can still tell the agent is doing something.
        */}
        {showFloatingToggle ? (
          <div className="absolute bottom-3 right-3 z-30 flex items-center gap-2 lg:hidden">
            {/*
              The mic rides along. Folding the whole conversation behind one
              button would otherwise put voice — the thing this demo is about —
              two taps and a scroll away, and the composer that holds the mic is
              inside the sheet.
            */}
            {voiceModeAvailable ? (
              <button
                type="button"
                disabled={voiceToggleDisabled}
                onClick={() => onToggleVoiceMode?.()}
                aria-label={voiceModeEnabled ? s.turnOffVoice : s.turnOnVoice}
                aria-pressed={voiceModeEnabled}
                title={voiceModeEnabled ? s.turnOffVoice : s.turnOnVoice}
                className={`flex h-12 w-12 items-center justify-center rounded-full border shadow-lg backdrop-blur transition-colors ${
                  voiceModeEnabled
                    ? 'border-accent-line bg-accent text-accent-fg'
                    : 'border-dark-border bg-dark-light/95 text-info-label hover:border-primary'
                } ${voiceToggleDisabled ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15a3 3 0 003-3V7a3 3 0 10-6 0v5a3 3 0 003 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0M12 18v3M8 21h8" />
                </svg>
              </button>
            ) : null}
          <button
            type="button"
            onClick={() => setConversationCollapsed(false)}
            aria-label={s.openConversation}
            aria-expanded={false}
            aria-controls="full-tuning-conversation-panel"
            className={`relative flex items-center gap-2 rounded-full border bg-dark-light/95 py-2.5 pl-3 pr-3 text-sm font-semibold text-fg-strong shadow-lg backdrop-blur transition-colors hover:border-primary ${
              hasUnread ? 'border-primary shadow-[0_0_0_4px_var(--app-primary-glow)]' : 'border-dark-border'
            }`}
          >
            {hasUnread ? (
              <span
                className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-dark bg-primary"
                aria-hidden="true"
              />
            ) : null}
            <svg className="h-5 w-5 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path
                d="M3.5 9.5a6 6 0 016-6h1a6 6 0 010 12h-4l-3 2.5v-3.2a6 6 0 01-.5-2.4z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] ${collapsedConversationStatus.badgeClass}`}
            >
              {collapsedConversationStatus.badge}
            </span>
          </button>
          </div>
        ) : null}

        <section className={conversationSectionClass}>
              <button
                type="button"
                onClick={() => setConversationCollapsed((current) => !current)}
                className={`flex items-center justify-between gap-4 px-4 py-3 text-left ${
                  conversationCollapsed ? '' : 'border-b border-dark-border'
                }`}
                aria-expanded={!conversationCollapsed}
                aria-controls="full-tuning-conversation-panel"
              >
                <div className={conversationCollapsed ? 'min-w-0 flex items-center gap-3' : 'min-w-0'}>
                  <div className={`font-semibold text-fg-strong ${conversationCollapsed ? 'shrink-0 text-base' : 'text-sm'}`}>
                    Conversation
                  </div>
                  {conversationCollapsed ? (
                    <div className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] ${collapsedConversationStatus.badgeClass}`}
                      >
                        {collapsedConversationStatus.badge}
                      </span>
                      <span className="truncate">{collapsedConversationStatus.compactText}</span>
                    </div>
                  ) : null}
                </div>
                <span className="shrink-0 text-xs font-medium text-fg-muted">
                  {conversationCollapsed ? 'Show' : 'Hide'}
                </span>
              </button>

              <div className={conversationCollapsed ? 'hidden' : 'relative min-h-0 flex-1'}>
                <div
                  id="full-tuning-conversation-panel"
                  ref={timelineContainerRef}
                  onScroll={handleTimelineScroll}
                  className="min-h-0 h-full overflow-y-auto overscroll-contain px-4 pb-4 pt-4"
                  style={{ overflowAnchor: 'none' }}
                >
                  <div
                    className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-end pb-8"
                    style={{ paddingTop: `${timelineTopInsetPx}px` }}
                  >
                    {timelineRows.map((row) => (
                      <div key={row.id}>
                        {row.type === 'agent' ? (
                          <AgentMessage
                            message={row.message}
                            highlighted={row.id === flashSyncRowId}
                            speaking={row.message.id === speakingMessageId}
                            syncAnchorRef={(node) => setRowAnchorNode(rowRefs.current, row.id, node)}
                          />
                        ) : null}
                        {row.type === 'user' ? (
                          <UserMessage
                            message={row.message}
                            highlighted={row.id === flashSyncRowId}
                            syncAnchorRef={(node) => setRowAnchorNode(rowRefs.current, row.id, node)}
                          />
                        ) : null}
                        {row.type === 'marker' ? (
                          <TimelineMarkerRow
                            row={row}
                            highlighted={row.id === flashSyncRowId}
                            syncAnchorRef={(node) => setRowAnchorNode(rowRefs.current, row.id, node)}
                          />
                        ) : null}
                      </div>
                    ))}

                    {timelineRows.length === 0 && !isAgentTyping ? (
                      <div className="py-12 text-center text-fg-faint">Loading conversation...</div>
                    ) : null}

                    <div
                      ref={timelineBottomRef}
                      className={isAgentTyping ? 'h-8' : 'h-4'}
                    />
                  </div>
                </div>

                {isAgentTyping ? (
                  <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 px-4">
                    <div className="mx-auto flex w-full max-w-5xl justify-center">
                      <AgentActivityOverlay showElapsed={showAgentElapsed} />
                    </div>
                  </div>
                ) : null}
              </div>

              {/*
                Always rendered, collapsed or not. It used to be conditioned on
                `!conversationCollapsed`, which meant collapsing the conversation
                — the one thing a phone visitor has to do to see the booking UI —
                also removed the only way to say anything to the agent. The
                session could not be advanced from there at all.
              */}
              {onSubmitInput ? (
                <div className="shrink-0 border-t border-dark-border">
                  <ChatInput
                    chatWidthPx={null}
                    disabled={inputDisabled}
                    placeholder={inputPlaceholder}
                    onSubmit={onSubmitInput}
                    voiceModeAvailable={voiceModeAvailable}
                    voiceModeEnabled={voiceModeEnabled}
                    voiceStatusLabel={voiceStatusLabel}
                    highlightVoiceToggle={highlightVoiceToggle}
                    voiceToggleDisabled={voiceToggleDisabled}
                    onToggleVoiceMode={onToggleVoiceMode}
                    voiceVerbosityLabel={voiceVerbosityLabel}
                    onOpenVoiceSettings={onOpenVoiceSettings}
                  />
                </div>
              ) : null}
        </section>
      </div>
    </div>
  );
}

interface GuiSnapshotCardProps {
  snapshot: GuiSnapshot;
  interactive: boolean;
  /** With voice on, a step nobody narrated shows no reason text (`guiStepContextText`). */
  voiceModeEnabled?: boolean;
  /**
   * Turns the preference ids on a snapshot's annotation into the words on the
   * memory rail. Stable per memory snapshot, so the memoised outgoing card is
   * not re-rendered by anything else. Absent outside the demo.
   */
  describePreferences?: (ids: string[]) => string[];
  agentActive?: boolean;
  speaking?: boolean;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
  onRevealHidden?: (revealed: boolean, hiddenCount: number) => void;
  onNext?: () => void;
  onFinishTask?: () => void;
  onBack?: () => void;
  onConfirm?: () => void;
}

/*
  Memoised, because this is where the expensive tree lives — a whole
  `StageRenderer` with its own hooks, timers, ResizeObserver and FLIP layout
  effect — and none of it depends on most of what re-renders the split view.
  Streamed agent tokens, a voice status flip, the transcript's scroll-sync
  state: each of those re-rendered both stage cards, and the outgoing one is
  frozen by definition. `transitionState.outgoing` holds the snapshot object
  captured when the slide began, and the other props it is handed are constants,
  so with this memo the exiting panel renders exactly once and then only slides.
  ChatPage already hands every callback down through `useCallback`.
*/
const GuiSnapshotCard = memo(function GuiSnapshotCard({
  snapshot,
  interactive,
  voiceModeEnabled = false,
  describePreferences,
  agentActive = false,
  speaking = false,
  onSelect,
  onToggle,
  onRevealHidden,
  onNext,
  onFinishTask,
  onBack,
  onConfirm,
}: GuiSnapshotCardProps) {
  const memoryLabels =
    describePreferences && snapshot.memoryPreferenceIds?.length
      ? describePreferences(snapshot.memoryPreferenceIds)
      : [];
  // Speaking and agentActive are both the baton, so they stay gold and differ
  // by weight -- the agent working the GUI is the louder of the two.
  const frameClass = speaking
    ? 'border-accent-line/70 shadow-[0_0_0_3px_var(--app-accent-glow)]'
    : agentActive
    ? 'border-accent-line shadow-[0_0_0_6px_var(--app-accent-glow-strong)]'
    : 'border-dark-border';
  const { s } = useLanguage();
  const contextClass = 'mt-2 text-base font-medium leading-7 text-info-text';
  const contextText = getSnapshotContextText(snapshot, voiceModeEnabled);
  const handleNextAction =
    interactive && isBookingCompleteMeta(snapshot.spec.meta) && onFinishTask
      ? onFinishTask
      : interactive && onNext
      ? onNext
      : () => {};

  return (
    <div className="w-full max-w-full" style={{ width: `${GUI_CARD_BASE_WIDTH_PX}px` }}>
      <SelectionBreadcrumb spec={snapshot.spec} stage={snapshot.stage} subdued={!interactive} />
      <div
        className={`rounded-2xl border bg-dark p-4 transition-colors ${frameClass}`}
      >
        {/*
          With a body under the label the avatar sits on the first line; with
          no body (voice mode hides the planner's reason) the label alone would
          hug the top edge of a 44px avatar, so centre the two instead.
        */}
        <div className={`mb-4 flex gap-3 ${contextText ? 'items-start' : 'items-center'}`}>
          <div
            className={`${contextText ? 'mt-1 ' : ''}flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-info-border bg-primary text-primary-fg ${
              agentActive
                ? 'ring-2 ring-accent-line shadow-[0_0_0_4px_var(--app-accent-glow)]'
                : ''
            }`}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <span className="min-w-0 text-sm font-semibold text-info-label">
              {getSnapshotContextLabel(snapshot, s.agentStepLabels)}
            </span>
            {contextText ? (
              <div className={contextClass}>{renderMessageText(contextText)}</div>
            ) : null}
            {/*
              The memory behind the change, on the card it changed. The rail
              already draws the arrow the other way — preference to stage —
              but the visitor is looking here, at a list that just got
              shorter, and this is where the question "why?" is asked.
            */}
            {memoryLabels.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="adaptation-memory">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                  {s.adaptationFromMemory}
                </span>
                {memoryLabels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full border border-accent-line/60 bg-accent/10 px-2 py-0.5 text-xs leading-5 text-accent-text"
                  >
                    {label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-2xl border border-dark-border bg-dark-light p-4">
          <div className="relative">
            <div
              className={`transition-opacity duration-200 ${
                interactive ? '' : 'pointer-events-none opacity-65'
              }`}
            >
              <StageRenderer
                spec={snapshot.spec}
                onSelect={interactive && onSelect ? onSelect : () => {}}
                onToggle={interactive && onToggle ? onToggle : () => {}}
                onRevealHidden={interactive ? onRevealHidden : undefined}
                onNext={handleNextAction}
                onBack={interactive ? onBack : undefined}
                onConfirm={interactive && onConfirm ? onConfirm : () => {}}
                motionProfile="full-tuning"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

function SnapshotNavButton({
  direction,
  disabled,
  onClick,
}: {
  direction: 'prev' | 'next';
  disabled: boolean;
  onClick: () => void;
}) {
  const isPrevious = direction === 'prev';

  return (
    <button
      type="button"
      aria-label={isPrevious ? 'Show previous GUI snapshot' : 'Show next GUI snapshot'}
      title={isPrevious ? 'Show previous GUI snapshot' : 'Show next GUI snapshot'}
      disabled={disabled}
      onClick={onClick}
      className="flex h-5 w-14 shrink-0 items-center justify-center self-center rounded-xl border border-dark-border bg-dark-light text-fg-muted transition-colors hover:border-primary hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-35 sm:h-6 sm:w-16"
    >
      <svg
        className="h-3.5 w-3.5 sm:h-4 sm:w-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d={isPrevious ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'}
        />
      </svg>
    </button>
  );
}

function TimelineMarkerRow({
  row,
  highlighted = false,
  syncAnchorRef,
}: {
  row: Extract<TimelineRow, { type: 'marker' }>;
  highlighted?: boolean;
  syncAnchorRef?: (node: HTMLDivElement | null) => void;
}) {
  return (
    <div className="rounded-2xl px-3 py-3" aria-label={`${row.label} (${row.stage})`}>
      <div
        ref={syncAnchorRef}
        className="rounded-2xl flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-fg-faint"
      >
        <span className="h-px flex-1 bg-dark-border" />
        <span
          className={`rounded-full px-3 py-1 font-semibold ${
            highlighted
              ? 'timeline-sync-pulse border border-primary/45 bg-primary/10 text-primary-text'
              : 'border border-dark-border bg-dark text-fg-muted'
          }`}
        >
          {row.label}
        </span>
        <span className="h-px flex-1 bg-dark-border" />
      </div>
    </div>
  );
}
