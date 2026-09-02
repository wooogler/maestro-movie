import { useLayoutEffect, useRef, useState } from 'react';
import type { SystemMessage as SystemMessageType } from '../../store/chatStore';
import type { UISpec } from '../../spec';
import { StageRenderer } from '../../renderer';
import { renderMessageText } from './renderMessageText';
import { SelectionBreadcrumb } from './SelectionBreadcrumb';

const SINGLE_STREAM_STAGE_CARD_FIT_PADDING_PX = 4;
const SINGLE_STREAM_STAGE_CARD_CHROME_RESERVE_PX = 400;
const SINGLE_STREAM_STAGE_CARD_BASE_WIDTH_PX = 440;
const SINGLE_STREAM_STAGE_CARD_ROW_WIDTH_PX = SINGLE_STREAM_STAGE_CARD_BASE_WIDTH_PX + 40;

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

interface SystemMessageProps {
  message: SystemMessageType;
  isActive: boolean;
  showAvatar?: boolean;
  linkedAssistantText?: string;
  linkedAssistantSpeaking?: boolean;
  onSelect?: (id: string) => void;
  onToggle?: (id: string) => void;
  onRevealHidden?: (revealed: boolean, hiddenCount: number) => void;
  onNext?: () => void;
  onFinishTask?: () => void;
  onBack?: () => void;
  onConfirm?: () => void;
  /** Override spec for active message (to reflect live selections) */
  activeSpec?: UISpec | null;
  interactionLocked?: boolean;
}

function AdaptiveStageCardBody({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(1);
  const [fitState, setFitState] = useState<{
    measured: boolean;
    naturalWidth: number;
    naturalHeight: number;
    scale: number;
  }>({
    measured: false,
    naturalWidth: 0,
    naturalHeight: 0,
    scale: 1,
  });

  useLayoutEffect(() => {
    if (!enabled) {
      scaleRef.current = 1;
      setFitState({
        measured: false,
        naturalWidth: 0,
        naturalHeight: 0,
        scale: 1,
      });
      return;
    }

    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === 'undefined') {
      return;
    }

    let frameId = 0;

    const measure = () => {
      const viewportRect = viewport.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const previousScale = scaleRef.current || 1;
      const naturalWidth = contentRect.width / previousScale;
      const naturalHeight = contentRect.height / previousScale;

      if (
        !Number.isFinite(naturalWidth) ||
        !Number.isFinite(naturalHeight) ||
        naturalWidth <= 0 ||
        naturalHeight <= 0
      ) {
        return;
      }

      const viewportHeight =
        typeof window !== 'undefined' && typeof window.innerHeight === 'number'
          ? window.innerHeight
          : naturalHeight;
      const availableWidth = Math.max(
        0,
        viewportRect.width - SINGLE_STREAM_STAGE_CARD_FIT_PADDING_PX
      );
      const availableHeight = Math.max(
        240,
        viewportHeight - SINGLE_STREAM_STAGE_CARD_CHROME_RESERVE_PX
      );

      const widthScale = availableWidth > 0 ? availableWidth / naturalWidth : 1;
      const heightScale = availableHeight > 0 ? availableHeight / naturalHeight : 1;
      const nextScale = Math.min(1, widthScale, heightScale);
      const normalizedScale =
        Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1;

      scaleRef.current = normalizedScale;
      setFitState((current) => {
        const unchanged =
          current.measured &&
          Math.abs(current.naturalWidth - naturalWidth) < 0.5 &&
          Math.abs(current.naturalHeight - naturalHeight) < 0.5 &&
          Math.abs(current.scale - normalizedScale) < 0.01;
        if (unchanged) {
          return current;
        }
        return {
          measured: true,
          naturalWidth,
          naturalHeight,
          scale: normalizedScale,
        };
      });
    };

    const scheduleMeasure = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        measure();
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleMeasure();
    });

    observer.observe(viewport);
    observer.observe(content);
    scheduleMeasure();
    window.addEventListener('resize', scheduleMeasure);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [enabled, children]);

  const scaledWidth = fitState.measured ? fitState.naturalWidth * fitState.scale : undefined;
  const scaledHeight = fitState.measured ? fitState.naturalHeight * fitState.scale : undefined;

  return (
    <div ref={viewportRef} className="w-full overflow-hidden">
      <div
        className={enabled && fitState.measured ? 'relative mx-auto' : 'w-full'}
        style={
          enabled && fitState.measured && scaledWidth && scaledHeight
            ? {
                width: `${scaledWidth}px`,
                height: `${scaledHeight}px`,
              }
            : undefined
        }
      >
        <div
          ref={contentRef}
          className={enabled && fitState.measured ? 'absolute left-0 top-0' : 'relative'}
          style={
            enabled && fitState.measured
              ? {
                  width: `${fitState.naturalWidth}px`,
                  transform: `scale(${fitState.scale})`,
                  transformOrigin: 'top left',
                }
              : undefined
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function SystemMessage({
  message,
  isActive,
  showAvatar = true,
  linkedAssistantText,
  linkedAssistantSpeaking = false,
  onSelect,
  onToggle,
  onRevealHidden,
  onNext,
  onFinishTask,
  onBack,
  onConfirm,
  activeSpec,
  interactionLocked = false,
}: SystemMessageProps) {
  // Use activeSpec for the active message, otherwise use message's spec
  const spec = isActive && activeSpec ? activeSpec : message.spec;
  const annotation = message.annotation;
  const isToolModification = annotation?.kind === 'tool-modification';
  const isAgentControlled = isToolModification && annotation?.source === 'agent';
  const toolDescriptionText =
    typeof linkedAssistantText === 'string' && linkedAssistantText.trim()
      ? linkedAssistantText.trim()
      : annotation?.reason ?? '';
  const toolDescriptionClass = 'mb-2 whitespace-pre-wrap break-words text-base font-medium text-info-text';
  const titleClass = isActive ? 'text-fg-strong font-medium mb-1' : 'text-fg-faint font-medium mb-1';
  const descriptionClass = isActive ? 'text-fg-muted text-sm mb-2' : 'text-fg-faint text-sm mb-3';
  const breadcrumb = (
    <SelectionBreadcrumb spec={spec} stage={spec.stage} subdued={!isActive} compact={isActive} />
  );
  const stageCardWidthClass = 'max-w-full min-w-0';
  const stageCardWidthStyle = { width: `${SINGLE_STREAM_STAGE_CARD_BASE_WIDTH_PX}px` };
  const stageCardBorderClass = linkedAssistantSpeaking
    ? 'rounded-2xl rounded-tl-sm border border-accent-line/70 bg-dark px-3 py-2.5 shadow-[0_0_0_3px_var(--app-accent-glow)]'
    : 'rounded-2xl rounded-tl-sm border border-dark-border bg-dark px-3 py-2.5';
  const stageCardShellClass = showAvatar ? 'flex items-start gap-2' : '';
  const avatarElement = showAvatar ? (
    // The avatar is teal (the system); the ring goes gold only while the agent is
    // actually driving this stage.
    <div
      className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary ${
        isAgentControlled ? 'ring-2 ring-accent-line shadow-[0_0_0_3px_var(--app-accent-glow)]' : ''
      }`}
    >
      <svg
        className="w-5 h-5 text-primary-fg"
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
  ) : null;
  const avatarSpacer = showAvatar ? <div className="h-8 w-8 shrink-0" aria-hidden="true" /> : null;
  const breadcrumbShell = (
    <div className={stageCardShellClass}>
      {avatarSpacer}
      <div className={stageCardWidthClass} style={stageCardWidthStyle}>{breadcrumb}</div>
    </div>
  );
  const stageCardInner = (
    <div className={stageCardBorderClass}>
      <div className={titleClass}>{spec.title}</div>
      {spec.description && (
        <div className={descriptionClass}>{spec.description}</div>
      )}
      <AdaptiveStageCardBody enabled={isActive}>
        <div className="relative">
          <div
            className={`transition-opacity ${
              !isActive ? 'opacity-50 pointer-events-none' : interactionLocked ? 'opacity-60 pointer-events-none' : ''
            }`}
          >
            <StageRenderer
              spec={spec}
              onSelect={isActive && onSelect ? onSelect : () => {}}
              onToggle={isActive && onToggle ? onToggle : () => {}}
              onRevealHidden={isActive ? onRevealHidden : undefined}
              onNext={isActive && onNext ? onNext : () => {}}
              onFinishTask={isActive && onFinishTask ? onFinishTask : undefined}
              onBack={isActive && onBack ? onBack : undefined}
              onConfirm={isActive && onConfirm ? onConfirm : () => {}}
            />
          </div>
        </div>
      </AdaptiveStageCardBody>
    </div>
  );
  const stageCardContent = (
    <div className="min-w-0">
      <div className={stageCardShellClass}>
        {avatarElement}
        <div className={stageCardWidthClass} style={stageCardWidthStyle}>
          {stageCardInner}
        </div>
      </div>
    </div>
  );
  const stageCardWithBreadcrumb = (
    <div className="min-w-0">
      {breadcrumbShell}
      <div className={stageCardShellClass}>
        {avatarElement}
        <div className={stageCardWidthClass} style={stageCardWidthStyle}>
          {stageCardInner}
        </div>
      </div>
    </div>
  );
  const stageCard = (
    <div className="min-w-0">
      <div className={stageCardShellClass}>
        {avatarElement}
        <div className={stageCardWidthClass} style={stageCardWidthStyle}>
          {breadcrumb}
          {stageCardInner}
        </div>
      </div>
    </div>
  );

  return (
    <div className="py-3">
      <div className="max-w-full min-w-0">
        {isToolModification ? (
          <div
            className="w-full min-w-0"
            style={{ maxWidth: `${SINGLE_STREAM_STAGE_CARD_ROW_WIDTH_PX + 4}px` }}
          >
            {breadcrumbShell}
            <div className="-mr-3 rounded-2xl rounded-tl-sm border border-info-border bg-info-bg p-3 transition-colors">
              {annotation ? (
                <div className="w-0 min-w-full">
                  <div className="mb-1 text-info-label text-xs font-semibold">
                    <span>
                      {annotation.source === 'devtools' ? 'DevTools' : 'Agent'}{' '}
                      {getToolActionLabel(annotation.toolName)}
                    </span>
                  </div>
                  {toolDescriptionText ? (
                    <div className={toolDescriptionClass}>
                      {renderMessageText(toolDescriptionText)}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {stageCardContent}
            </div>
          </div>
        ) : (
          isActive ? stageCardWithBreadcrumb : stageCard
        )}
      </div>
    </div>
  );
}
