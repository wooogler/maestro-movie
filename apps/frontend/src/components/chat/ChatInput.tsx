import { useLayoutEffect, useRef, useState } from 'react';
import { useLanguage } from '../../i18n';

const MAX_TEXTAREA_HEIGHT_PX = 160;

function resizeTextareaToContent(element: HTMLTextAreaElement) {
  element.style.height = '0px';
  const nextHeight = Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT_PX);
  element.style.height = `${nextHeight}px`;
  element.style.overflowY =
    element.scrollHeight > MAX_TEXTAREA_HEIGHT_PX ? 'auto' : 'hidden';
}

interface ChatInputProps {
  disabled?: boolean;
  placeholder?: string;
  chatWidthPx?: number | null;
  onSubmit?: (text: string) => void;
  voiceModeAvailable?: boolean;
  voiceModeEnabled?: boolean;
  voiceStatusLabel?: string | null;
  highlightVoiceToggle?: boolean;
  voiceToggleDisabled?: boolean;
  onToggleVoiceMode?: () => void;
  /** Current verbosity preset, shown on the pill so the setting is visible at rest. */
  voiceVerbosityLabel?: string | null;
  onOpenVoiceSettings?: () => void;
}

export function ChatInput({
  disabled = true,
  placeholder,
  chatWidthPx = 768,
  onSubmit,
  voiceModeAvailable = false,
  voiceModeEnabled = false,
  voiceStatusLabel = null,
  highlightVoiceToggle = false,
  voiceToggleDisabled = false,
  onToggleVoiceMode,
  voiceVerbosityLabel = null,
  onOpenVoiceSettings,
}: ChatInputProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldRestoreFocusRef = useRef(false);
  const previousDisabledRef = useRef(disabled);
  const isVoiceComposer = voiceModeAvailable;
  const normalizedVoiceStatus = voiceStatusLabel?.toLowerCase() ?? '';
  const isVoiceInputHighlighted =
    voiceModeEnabled &&
    !disabled &&
    (normalizedVoiceStatus.includes('listening') || normalizedVoiceStatus.includes('ready'));
  const micButtonDisabled = voiceToggleDisabled || !onToggleVoiceMode;
  const shouldHighlightVoiceToggle =
    highlightVoiceToggle && !voiceModeEnabled && !micButtonDisabled;
  const { s } = useLanguage();
  const micButtonTitle = voiceModeEnabled ? s.turnOffVoice : s.turnOnVoice;

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || isVoiceComposer) return;
    shouldRestoreFocusRef.current = true;
    onSubmit?.(trimmed);
    setText('');
  };

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    resizeTextareaToContent(element);
  }, [chatWidthPx, text]);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    let previousWidth = element.clientWidth;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const nextWidth = entry.contentRect.width;
      if (nextWidth === previousWidth) return;
      previousWidth = nextWidth;
      resizeTextareaToContent(element);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const wasDisabled = previousDisabledRef.current;
    previousDisabledRef.current = disabled;

    if (disabled || !wasDisabled || !shouldRestoreFocusRef.current) return;

    const element = textareaRef.current;
    if (!element) return;

    element.focus();
    const cursorPosition = element.value.length;
    element.setSelectionRange(cursorPosition, cursorPosition);
    shouldRestoreFocusRef.current = false;
  }, [disabled]);

  return (
    <div className="border-t border-dark-border bg-dark px-4 pb-3 pt-2">
      <div
        className="mx-auto w-full"
        style={chatWidthPx ? { width: `min(100%, ${chatWidthPx}px)` } : undefined}
      >
        <div
          className={`rounded-[30px] p-1 transition-[background-color,border-color,box-shadow] duration-200 ${
            isVoiceInputHighlighted
              ? 'border border-accent-line/70 bg-accent/[0.10] shadow-[0_0_0_3px_var(--app-accent-glow)]'
              : 'border border-transparent'
          }`}
        >
          <div className="flex items-end gap-3">
            <textarea
              ref={textareaRef}
              rows={1}
              disabled={disabled && !isVoiceComposer}
              readOnly={isVoiceComposer}
              tabIndex={isVoiceComposer ? -1 : 0}
              placeholder={placeholder ?? s.inputPlaceholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={(e) => {
                if (isVoiceComposer) e.currentTarget.blur();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              className={`flex-1 resize-none rounded-3xl border bg-dark-light px-4 py-3 leading-6 text-fg-strong placeholder:text-fg placeholder:font-medium placeholder:opacity-100 transition-colors focus:outline-none ${
                isVoiceInputHighlighted
                  ? 'border-accent-line/70 focus:border-accent-hover'
                  : 'border-dark-border focus:border-primary'
              } ${disabled && !isVoiceComposer ? 'cursor-not-allowed opacity-50' : ''} ${
                isVoiceComposer ? 'cursor-default select-none' : ''
              }`}
            />
            {isVoiceComposer && onOpenVoiceSettings ? (
              <button
                type="button"
                onClick={onOpenVoiceSettings}
                title={s.voiceSettingsHint}
                aria-label={s.voiceSettingsTitle}
                className="self-center shrink-0 rounded-full border border-dark-border bg-dark-light/70 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted transition-colors hover:border-primary hover:text-fg-strong"
              >
                {voiceVerbosityLabel ?? s.voice}
              </button>
            ) : null}
            {isVoiceComposer ? (
              <button
                type="button"
                disabled={micButtonDisabled}
                onClick={() => onToggleVoiceMode?.()}
                title={micButtonTitle}
                aria-label={micButtonTitle}
                className={`self-center flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  voiceModeEnabled
                    ? 'border-accent-line bg-accent text-accent-fg hover:bg-accent-hover'
                    : shouldHighlightVoiceToggle
                    ? 'animate-pulse border-primary bg-primary/12 text-primary-text shadow-[0_0_0_4px_var(--app-primary-glow)] hover:bg-primary/18'
                    : 'border-info-border/60 bg-dark-light text-info-label hover:border-info-border hover:text-info-text'
                } ${micButtonDisabled ? 'cursor-not-allowed opacity-50' : ''}`}
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
                    d="M12 15a3 3 0 003-3V7a3 3 0 10-6 0v5a3 3 0 003 3z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 11a7 7 0 01-14 0M12 18v3M8 21h8"
                  />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                disabled={disabled}
                onClick={handleSubmit}
                className={`self-center flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors ${
                  isVoiceInputHighlighted
                    ? 'bg-accent text-accent-fg hover:bg-accent-hover'
                    : 'bg-primary text-primary-fg'
                } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
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
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
