import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

interface FullTuningSplitViewProps {
  messages: ChatMessage[];
  activeSpec: UISpec | null;
  isAgentTyping?: boolean;
  interactionLocked?: boolean;
  speakingMessageId?: string | null;
  inputDisabled?: boolean;
  inputPlaceholder?: string;
  onSubmitInput?: (text: string) => void;
  voiceModeAvailable?: boolean;
  voiceModeEnabled?: boolean;
  voiceStatusLabel?: string | null;
  voiceError?: string | null;
  highlightVoiceToggle?: boolean;
  voiceToggleDisabled?: boolean;
  onToggleVoiceMode?: () => void;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
  onNext?: () => void;
  onFinishTask?: () => void;
  onBack?: () => void;
  onConfirm?: () => void;
}

interface GuiSnapshot {
  id: string;
  stage: Stage;
  spec: UISpec;
  annotation?: SystemMessageAnnotation;
  linkedAssistantText?: string;
  linkedAssistantMessageId?: string;
  linkedActionTag?: AgentMessageActionTag;
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
const GUI_STAGE_TRANSITION_MS = 420;
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

function getToolActionLabel(toolName: string): string {
  switch (toolName) {
    case 'select':
      return 'is selecting';
    case 'selectMultiple':
      return 'is selecting multiple seats';
    case 'filter':
      return 'is filtering';
    case 'sort':
      return 'is sorting';
    case 'highlight':
      return 'is highlighting';
    case 'augment':
      return 'is updating labels';
    case 'clearModification':
      return 'is clearing modifications';
    case 'next':
      return 'is moving to the next stage';
    case 'prev':
      return 'is going back';
    default:
      return `is applying ${toolName}`;
  }
}

function getAgentActionLabel(actionTag: AgentMessageActionTag): string {
  switch (actionTag.toolName) {
    case 'next':
      return 'moved to the next stage';
    case 'prev':
      return 'went back';
    default:
      return 'updated the GUI';
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

function getSnapshotContextLabel(snapshot: GuiSnapshot): string {
  if (snapshot.annotation) {
    return `${snapshot.annotation.source === 'devtools' ? 'DevTools' : 'Agent'} ${getToolActionLabel(
      snapshot.annotation.toolName
    )}`;
  }
  if (snapshot.linkedActionTag) {
    return `Agent ${getAgentActionLabel(snapshot.linkedActionTag)}`;
  }
  return snapshot.spec.title;
}

function getSnapshotContextText(snapshot: GuiSnapshot): string {
  const linkedAssistantText = snapshot.linkedAssistantText?.trim();
  if (linkedAssistantText) return linkedAssistantText;

  const annotationReason = snapshot.annotation?.reason?.trim();
  if (annotationReason) return annotationReason;

  const actionReason = snapshot.linkedActionTag?.reason?.trim();
  if (actionReason) return actionReason;

  const stageDescription = snapshot.spec.description?.trim();
  if (stageDescription) return stageDescription;

  return snapshot.spec.title;
}

function buildMarkerLabel(snapshot: GuiSnapshot): string {
  if (snapshot.annotation) {
    return getSnapshotContextLabel(snapshot);
  }
  if (snapshot.linkedActionTag) {
    return getSnapshotContextLabel(snapshot);
  }
  return snapshot.spec.title;
}

function getCollapsedConversationStatus(params: {
  voiceModeAvailable: boolean;
  voiceModeEnabled: boolean;
  voiceStatusLabel: string | null;
  voiceError: string | null;
  inputDisabled: boolean;
}) {
  const { voiceModeAvailable, voiceModeEnabled, voiceStatusLabel, voiceError, inputDisabled } =
    params;

  if (voiceError) {
    return {
      badge: 'Error',
      text: voiceError,
      compactText: 'Voice error',
      badgeClass: 'border-rose-500/60 bg-rose-500/12 text-fg',
    };
  }

  const normalizedVoiceStatus = voiceStatusLabel?.toLowerCase() ?? '';

  if (voiceModeEnabled) {
    // Must stay in sync with getVoiceStatusLabel in ChatPage.
    if (
      normalizedVoiceStatus.includes('playing reply') ||
      normalizedVoiceStatus.includes('generating voice')
    ) {
      return {
        badge: 'Speaking',
        text: voiceStatusLabel ?? 'The agent reply is still playing.',
        compactText: 'Reply playing',
        badgeClass: 'border-info-border bg-info-bg/70 text-fg',
      };
    }

    if (normalizedVoiceStatus.includes('transcribing')) {
      return {
        badge: 'Working',
        text: voiceStatusLabel ?? 'Processing what you just said.',
        compactText: 'Processing speech',
        badgeClass: 'border-dark-border bg-dark-light text-fg',
      };
    }

    if (
      normalizedVoiceStatus.includes('listening') ||
      normalizedVoiceStatus.includes('voice ready')
    ) {
      return {
        badge: 'Speak',
        text: 'You can speak now.',
        compactText: 'Speak now',
        badgeClass: 'border-rose-500/60 bg-rose-500/12 text-fg',
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
  interactionLocked = false,
  speakingMessageId = null,
  inputDisabled = true,
  inputPlaceholder = 'Type a message...',
  onSubmitInput,
  voiceModeAvailable = false,
  voiceModeEnabled = false,
  voiceStatusLabel = null,
  voiceError = null,
  highlightVoiceToggle = false,
  voiceToggleDisabled = false,
  onToggleVoiceMode,
  onSelect,
  onToggle,
  onNext,
  onFinishTask,
  onBack,
  onConfirm,
}: FullTuningSplitViewProps) {
  const timelineContainerRef = useRef<HTMLDivElement | null>(null);
  const timelineBottomRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const activeSnapshotRef = useRef<GuiSnapshot | null>(null);
  const activeSnapshotIndexRef = useRef<number>(-1);
  const transitionTimeoutRef = useRef<number | null>(null);
  const syncHighlightTimeoutRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoFollowScrollSyncLockUntilRef = useRef(0);
  const hasAutoScrolledRef = useRef(false);
  const guiViewportRef = useRef<HTMLDivElement>(null);
  const guiContentRef = useRef<HTMLDivElement>(null);
  const [guiScale, setGuiScale] = useState(1);
  const [conversationCollapsed, setConversationCollapsed] = useState(false);

  const { snapshots, timelineRows, latestSnapshotIndex, firstRowIdBySnapshotIndex } = useMemo(() => {
    const nextSnapshots: GuiSnapshot[] = [];
    const systemMessageIndexToSnapshotIndex = new Map<number, number>();

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.type !== 'system') continue;

      const previousMessage = index > 0 ? messages[index - 1] : null;
      const linkedAgentMessage =
        previousMessage &&
        previousMessage.type === 'agent' &&
        isAgentLinkedToSystem(previousMessage, message)
          ? previousMessage
          : null;

      const snapshotIndex = nextSnapshots.length;
      systemMessageIndexToSnapshotIndex.set(index, snapshotIndex);
      nextSnapshots.push({
        id: message.id,
        stage: message.stage,
        spec: message.spec,
        annotation: message.annotation,
        linkedAssistantText: linkedAgentMessage?.text,
        linkedAssistantMessageId: linkedAgentMessage?.id,
        linkedActionTag: linkedAgentMessage?.actionTag,
        isLatest: false,
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

    const nextTimelineRows: TimelineRow[] = [];
    const nextFirstRowIdBySnapshotIndex = new Map<number, string>();
    let currentSnapshotIndex = nextSnapshots.length > 0 ? 0 : -1;

    const registerRow = (row: TimelineRow) => {
      nextTimelineRows.push(row);
      if (!nextFirstRowIdBySnapshotIndex.has(row.snapshotIndex)) {
        nextFirstRowIdBySnapshotIndex.set(row.snapshotIndex, row.id);
      }
    };

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];

      if (message.type === 'system') {
        const snapshotIndex = systemMessageIndexToSnapshotIndex.get(index);
        if (snapshotIndex === undefined) continue;
        currentSnapshotIndex = snapshotIndex;

        registerRow({
          id: `marker-${message.id}`,
          type: 'marker',
          snapshotIndex,
          label: buildMarkerLabel(nextSnapshots[snapshotIndex]),
          stage: message.stage,
        });
        continue;
      }

      if (message.type === 'user') {
        registerRow({
          id: message.id,
          type: 'user',
          message,
          snapshotIndex: currentSnapshotIndex,
        });
        continue;
      }

      const nextMessage = messages[index + 1];
      const linkedSnapshotIndex =
        nextMessage && nextMessage.type === 'system' && isAgentLinkedToSystem(message, nextMessage)
          ? systemMessageIndexToSnapshotIndex.get(index + 1)
          : undefined;

      if (linkedSnapshotIndex !== undefined) {
        continue;
      }

      registerRow({
        id: message.id,
        type: 'agent',
        message,
        snapshotIndex: linkedSnapshotIndex ?? currentSnapshotIndex,
      });
    }

    return {
      snapshots: nextSnapshots,
      timelineRows: nextTimelineRows,
      latestSnapshotIndex: nextSnapshots.length - 1,
      firstRowIdBySnapshotIndex: nextFirstRowIdBySnapshotIndex,
    };
  }, [messages, activeSpec]);

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

  useLayoutEffect(() => {
    const container = timelineContainerRef.current;
    if (!container) return;

    const getFirstRowNode = () => {
      const firstRowId = timelineRows[0]?.id;
      return firstRowId ? rowRefs.current.get(firstRowId) ?? null : null;
    };

    const updateTopInset = () => {
      const firstRow = timelineRows[0];
      const firstRowNode = getFirstRowNode();
      const syncAnchorOffset = getSyncAnchorOffsetFromTop(container.clientHeight);
      const firstRowAnchorOffset = firstRowNode
        ? getTimelineRowAnchorOffset(firstRowNode.offsetHeight, firstRow?.type ?? 'agent')
        : 24;
      setTimelineTopInsetPx(Math.max(0, syncAnchorOffset - firstRowAnchorOffset));
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
  }, [timelineRows]);

  const syncActiveSnapshotToScroll = useCallback(() => {
    const container = timelineContainerRef.current;
    if (!container || timelineRows.length === 0) return;
    const lastRow = timelineRows[timelineRows.length - 1];

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

  useEffect(() => {
    if (conversationCollapsed || !latestTimelineRow) return;

    autoFollowScrollSyncLockUntilRef.current = Date.now() + AUTO_FOLLOW_SCROLL_SYNC_LOCK_MS;
    pinToLatestTimelinePosition();

    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
    }

    const behavior: ScrollBehavior = hasAutoScrolledRef.current ? 'smooth' : 'auto';
    autoScrollFrameRef.current = window.requestAnimationFrame(() => {
      timelineBottomRef.current?.scrollIntoView({ behavior, block: 'end' });
      autoScrollFrameRef.current = null;
    });
    hasAutoScrolledRef.current = true;
  }, [conversationCollapsed, latestTimelineRow?.id, pinToLatestTimelinePosition]);

  const collapsedConversationStatus = getCollapsedConversationStatus({
    voiceModeAvailable,
    voiceModeEnabled,
    voiceStatusLabel,
    voiceError,
    inputDisabled,
  });
  // Collapsing the conversation has to hand its space back. Leaving an empty
  // column beside the booking UI is worse than leaving the conversation open,
  // and on a phone the booking UI needs the whole screen.
  const containerClass = conversationCollapsed
    ? 'mx-auto grid h-full w-full max-w-6xl min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] gap-4'
    : 'mx-auto grid h-full w-full max-w-6xl min-h-0 grid-cols-1 grid-rows-[minmax(0,3fr)_minmax(0,2fr)] gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-1';
  const handleTimelineScroll = useCallback(() => {
    syncActiveSnapshotToScroll();
  }, [syncActiveSnapshotToScroll]);

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

  useEffect(() => {
    const previousSnapshot = activeSnapshotRef.current;
    const previousSnapshotIndex = activeSnapshotIndexRef.current;

    if (!activeSnapshot) {
      activeSnapshotRef.current = null;
      activeSnapshotIndexRef.current = activeSnapshotIndex;
      setTransitionState(null);
      return;
    }

    if (!previousSnapshot) {
      activeSnapshotRef.current = activeSnapshot;
      activeSnapshotIndexRef.current = activeSnapshotIndex;
      setTransitionState(null);
      return;
    }

    if (previousSnapshot.id !== activeSnapshot.id && previousSnapshot.stage !== activeSnapshot.stage) {
      const direction: GuiTransitionDirection =
        activeSnapshotIndex >= previousSnapshotIndex ? 'forward' : 'backward';
      setTransitionState({
        outgoing: previousSnapshot,
        direction,
        incomingId: activeSnapshot.id,
      });

      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current);
      }

      transitionTimeoutRef.current = window.setTimeout(() => {
        setTransitionState((current) =>
          current?.incomingId === activeSnapshot.id ? null : current
        );
        transitionTimeoutRef.current = null;
      }, GUI_STAGE_TRANSITION_MS);
    } else {
      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current);
        transitionTimeoutRef.current = null;
      }
      setTransitionState(null);
    }

    activeSnapshotRef.current = activeSnapshot;
    activeSnapshotIndexRef.current = activeSnapshotIndex;
  }, [activeSnapshot, activeSnapshotIndex]);

  useLayoutEffect(() => {
    const viewport = guiViewportRef.current;
    const content = guiContentRef.current;
    if (!viewport || !content) return;

    const recalc = () => {
      const availH = viewport.clientHeight;
      const naturalH = content.scrollHeight;
      setGuiScale(naturalH > 0 ? Math.min(1, availH / naturalH) : 1);
    };

    recalc();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(recalc);
    ro.observe(viewport);
    ro.observe(content);
    return () => ro.disconnect();
  }, [activeSnapshot?.id]);

  return (
    <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
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

            <div ref={guiViewportRef} className="flex-1 overflow-hidden flex items-center justify-center px-2 sm:px-4">
              {activeSnapshot ? (
                <div
                  ref={guiContentRef}
                  className="relative mx-auto flex w-full max-w-2xl items-start justify-center"
                  style={{ transform: `scale(${guiScale})`, transformOrigin: 'center center' }}
                >
                  {transitionState?.outgoing ? (
                    <div
                      className={`absolute inset-0 flex items-center justify-center py-1 gui-stage-panel ${
                        transitionState.direction === 'forward'
                          ? 'gui-stage-slide-out-up'
                          : 'gui-stage-slide-out-down'
                      }`}
                    >
                    <GuiSnapshotCard
                      snapshot={transitionState.outgoing}
                      interactive={false}
                      agentActive={false}
                      speaking={false}
                    />
                  </div>
                  ) : null}

                  <div
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
                      interactive={activeSnapshot.isLatest && !interactionLocked}
                      agentActive={Boolean(isAgentTyping && activeSnapshot.isLatest)}
                      speaking={activeSnapshot.linkedAssistantMessageId === speakingMessageId}
                      onSelect={onSelect}
                      onToggle={onToggle}
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

        <section className="min-h-0 flex flex-1 flex-col overflow-hidden rounded-2xl border border-dark-border bg-dark">
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
                      <AgentActivityOverlay />
                    </div>
                  </div>
                ) : null}
              </div>

              {onSubmitInput && !conversationCollapsed ? (
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
                  />
                </div>
              ) : null}
        </section>
      </div>
    </div>
  );
}

function GuiSnapshotCard({
  snapshot,
  interactive,
  agentActive = false,
  speaking = false,
  onSelect,
  onToggle,
  onNext,
  onFinishTask,
  onBack,
  onConfirm,
}: {
  snapshot: GuiSnapshot;
  interactive: boolean;
  agentActive?: boolean;
  speaking?: boolean;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
  onNext?: () => void;
  onFinishTask?: () => void;
  onBack?: () => void;
  onConfirm?: () => void;
}) {
  const frameClass = speaking
    ? 'border-rose-500/70 shadow-[0_0_0_3px_rgba(244,63,94,0.18)]'
    : agentActive
    ? 'border-info-border shadow-[0_0_0_2px_rgba(96,165,250,0.22)]'
    : 'border-dark-border';
  const contextClass = 'mt-2 text-base font-medium leading-7 text-info-text';
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
        <div className="mb-4 flex items-start gap-3">
          <div
            className={`mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-info-border bg-primary text-primary-fg ${
              agentActive
                ? 'ring-2 ring-blue-400 shadow-[0_0_0_4px_rgba(59,130,246,0.18)]'
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
              {getSnapshotContextLabel(snapshot)}
            </span>
            <div className={contextClass}>
              {renderMessageText(getSnapshotContextText(snapshot))}
            </div>
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
}

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
              ? 'timeline-sync-pulse border border-primary/45 bg-primary/10 text-primary'
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
