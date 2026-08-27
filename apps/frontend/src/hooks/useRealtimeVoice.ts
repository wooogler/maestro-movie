import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice mode over an OpenAI Realtime WebRTC session.
 *
 * The realtime model is only the ears and the mouth here: the session is minted
 * with turn_detection.create_response=false, so it never answers on its own. The
 * tuning agent still composes every utterance and drives every GUI action, and
 * this hook speaks that text via response.create with an empty input array.
 *
 * What the session buys us over the previous transcribe/synthesize round trips
 * is barge-in: the server hears the user start talking while the agent is
 * speaking, cuts the speech off, and truncates the unplayed audio itself.
 */

export type VoiceInputStatus =
  | 'off'
  | 'unsupported'
  | 'requesting-permission'
  | 'suspended'
  | 'listening'
  | 'capturing'
  | 'transcribing'
  | 'error';

export type VoiceOutputStatus = 'off' | 'idle' | 'synthesizing' | 'playing' | 'error';

export interface VoiceSpeakItem {
  id: string | null;
  text: string;
}

export interface RealtimeVoiceCredentials {
  clientSecret: string;
  expiresAt: number | null;
  model: string;
  transcriptionModel: string;
}

interface UseRealtimeVoiceOptions {
  enabled: boolean;
  /**
   * Display + delivery gate only; it never stops the audio session. Suspending
   * on "the agent is busy" would silently swallow barge-in transcripts, so this
   * should track session liveness, not agent activity.
   */
  suspended?: boolean;
  /** On-screen options fed to the transcriber to bias recognition. */
  transcriptionPrompt?: string | null;
  createSession: () => Promise<RealtimeVoiceCredentials>;
  onTranscript: (payload: { text: string; durationMs: number }) => void;
  onSpeakingItemChange?: (item: VoiceSpeakItem | null) => void;
  onPlaybackComplete?: (item: VoiceSpeakItem, info: { interrupted: boolean }) => void;
  onLogEvent?: (type: string, payload: unknown) => void;
}

interface UseRealtimeVoiceResult {
  supported: boolean;
  inputStatus: VoiceInputStatus;
  outputStatus: VoiceOutputStatus;
  error: string | null;
  isSpeaking: boolean;
  speak: (item: VoiceSpeakItem) => void;
  stop: () => void;
}

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
// Realtime sessions are capped at 60 minutes; renew before the cliff.
const SESSION_RENEW_AFTER_MS = 50 * 60_000;
const TRANSCRIPTION_PROMPT_DEBOUNCE_MS = 300;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 8_000;
const RECONNECT_MAX_ATTEMPTS = 5;
// Backstop so a dropped audio-buffer event cannot wedge the speak queue. Set
// well past the agent's own 15s barrier timeout: by the time this fires the
// agent has long since released itself and ignores the late completion.
const SPEAK_WATCHDOG_MS = 30_000;
const MAX_TRACKED_UTTERANCES = 32;

interface ActiveSpeech {
  item: VoiceSpeakItem;
  seq: number;
  responseId: string | null;
  audioStarted: boolean;
  completed: boolean;
  watchdog: ReturnType<typeof setTimeout> | null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return 'Voice mode failed.';
}

function isRealtimeVoiceSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    typeof RTCPeerConnection !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function useRealtimeVoice({
  enabled,
  suspended = false,
  transcriptionPrompt = null,
  createSession,
  onTranscript,
  onSpeakingItemChange,
  onPlaybackComplete,
  onLogEvent,
}: UseRealtimeVoiceOptions): UseRealtimeVoiceResult {
  const supported = isRealtimeVoiceSupported();

  const [inputStatus, setInputStatus] = useState<VoiceInputStatus>(
    supported ? 'off' : 'unsupported'
  );
  const [outputStatus, setOutputStatus] = useState<VoiceOutputStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [connectNonce, setConnectNonce] = useState(0);

  const inputStatusRef = useRef<VoiceInputStatus>(supported ? 'off' : 'unsupported');
  const outputStatusRef = useRef<VoiceOutputStatus>('off');
  const errorRef = useRef<string | null>(null);

  const enabledRef = useRef(enabled);
  const suspendedRef = useRef(suspended);
  const transcriptionPromptRef = useRef(transcriptionPrompt);
  const createSessionRef = useRef(createSession);
  const onTranscriptRef = useRef(onTranscript);
  const onSpeakingItemChangeRef = useRef(onSpeakingItemChange);
  const onPlaybackCompleteRef = useRef(onPlaybackComplete);
  const onLogEventRef = useRef(onLogEvent);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const transcriptionModelRef = useRef<string | null>(null);

  const queueRef = useRef<VoiceSpeakItem[]>([]);
  const activeRef = useRef<ActiveSpeech | null>(null);
  const speakSeqRef = useRef(0);
  const bargeInEventIdsRef = useRef<Set<string>>(new Set());

  // VAD timings keyed by realtime item id, joined to the transcript when it
  // lands (transcription events can arrive out of order relative to the turn).
  const utteranceDurationsRef = useRef<Map<string, number>>(new Map());
  const lastUtteranceDurationRef = useRef<number | null>(null);
  const speechStartRef = useRef<{ itemId: string | null; wallClockMs: number } | null>(null);

  const generationRef = useRef(0);
  // Set once reconnection has been given up on: the session will not come back
  // without the user toggling voice mode off and on.
  const sessionFailedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentPromptRef = useRef<string | null>(null);

  const setInputStatusSafe = useCallback((next: VoiceInputStatus) => {
    if (inputStatusRef.current === next) return;
    inputStatusRef.current = next;
    setInputStatus(next);
  }, []);

  const setOutputStatusSafe = useCallback((next: VoiceOutputStatus) => {
    if (outputStatusRef.current === next) return;
    outputStatusRef.current = next;
    setOutputStatus(next);
  }, []);

  const setErrorSafe = useCallback((next: string | null) => {
    if (errorRef.current === next) return;
    errorRef.current = next;
    setError(next);
  }, []);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    suspendedRef.current = suspended;
  }, [suspended]);
  useEffect(() => {
    createSessionRef.current = createSession;
  }, [createSession]);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    onSpeakingItemChangeRef.current = onSpeakingItemChange;
  }, [onSpeakingItemChange]);
  useEffect(() => {
    onPlaybackCompleteRef.current = onPlaybackComplete;
  }, [onPlaybackComplete]);
  useEffect(() => {
    onLogEventRef.current = onLogEvent;
  }, [onLogEvent]);

  const sendEvent = useCallback((event: Record<string, unknown>): boolean => {
    const channel = dcRef.current;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }, []);

  const setSpeakingItem = useCallback((item: VoiceSpeakItem | null) => {
    onSpeakingItemChangeRef.current?.(item);
  }, []);

  /**
   * Ends the active utterance exactly once, whichever signal gets there first
   * (buffer drained, buffer cleared by a barge-in, response cancelled, or the
   * watchdog). Always reports completion so the agent's turn barrier releases --
   * including on interruption, which the previous pipeline never did.
   */
  const completeActive = useCallback(
    (interrupted: boolean, reason: string) => {
      const active = activeRef.current;
      if (!active || active.completed) return;
      active.completed = true;
      if (active.watchdog) clearTimeout(active.watchdog);
      activeRef.current = null;

      setSpeakingItem(null);
      onLogEventRef.current?.('chat.voice_output.completed', {
        textLength: active.item.text.length,
        interrupted,
        reason,
      });
      onPlaybackCompleteRef.current?.(active.item, { interrupted });
    },
    [setSpeakingItem]
  );

  // pumpQueue re-enters itself through completion handlers; a ref breaks the
  // dependency cycle that a direct self-reference would create.
  const pumpQueueRef = useRef<(() => void) | null>(null);

  const pumpQueue = useCallback(() => {
    if (activeRef.current) return;
    if (!enabledRef.current) return;

    const channel = dcRef.current;
    if (!channel || channel.readyState !== 'open') return;

    const next = queueRef.current.shift();
    setQueuedCount(queueRef.current.length);
    if (!next) {
      setOutputStatusSafe(enabledRef.current ? 'idle' : 'off');
      return;
    }

    const seq = ++speakSeqRef.current;
    const active: ActiveSpeech = {
      item: next,
      seq,
      responseId: null,
      audioStarted: false,
      completed: false,
      watchdog: null,
    };
    activeRef.current = active;
    active.watchdog = setTimeout(() => {
      completeActive(false, 'watchdog');
      pumpQueueRef.current?.();
    }, SPEAK_WATCHDOG_MS);

    setOutputStatusSafe('synthesizing');
    onLogEventRef.current?.('chat.voice_output.started', {
      textLength: next.text.length,
    });

    const sent = sendEvent({
      type: 'response.create',
      // Tagged so a server rejection can be matched back to this utterance and
      // completed, instead of sitting active until the watchdog.
      event_id: `speak-${seq}`,
      response: {
        // Empty input keeps the model from reacting to conversation context:
        // it has one job, which is to read this line out loud.
        input: [],
        metadata: { messageId: next.id ?? '', seq: String(seq) },
        instructions: `Repeat the following message to the user verbatim, exactly as written: ${next.text}`,
      },
    });

    if (!sent) {
      completeActive(true, 'channel-unavailable');
      setOutputStatusSafe(enabledRef.current ? 'idle' : 'off');
    }
  }, [completeActive, sendEvent, setOutputStatusSafe]);

  useEffect(() => {
    pumpQueueRef.current = pumpQueue;
  }, [pumpQueue]);

  /**
   * Drops everything still waiting to be spoken. Each dropped item still reports
   * an interrupted completion: once speak() accepts an utterance the agent may
   * be waiting on it, and silently discarding it would leave that turn barrier
   * to time out.
   */
  const clearQueue = useCallback(
    (reason: string) => {
      const dropped = queueRef.current;
      queueRef.current = [];
      setQueuedCount(0);
      for (const item of dropped) {
        onLogEventRef.current?.('chat.voice_output.completed', {
          textLength: item.text.length,
          interrupted: true,
          reason: `${reason}:queued`,
        });
        onPlaybackCompleteRef.current?.(item, { interrupted: true });
      }
    },
    []
  );

  const stop = useCallback(() => {
    clearQueue('stopped');
    const active = activeRef.current;
    if (active && !active.completed) {
      sendEvent({ type: 'response.cancel' });
      sendEvent({ type: 'output_audio_buffer.clear' });
      completeActive(true, 'stopped');
    }
    setOutputStatusSafe(enabledRef.current ? 'idle' : 'off');
  }, [clearQueue, completeActive, sendEvent, setOutputStatusSafe]);

  const speak = useCallback(
    (item: VoiceSpeakItem) => {
      const text = item.text.trim();
      if (!enabledRef.current || !text) return;

      // Once the session has given up reconnecting nothing will ever drain the
      // queue, so report the utterance as interrupted straight away rather than
      // leaving the agent's turn barrier to time out on every turn.
      if (sessionFailedRef.current) {
        onLogEventRef.current?.('chat.voice_output.completed', {
          textLength: text.length,
          interrupted: true,
          reason: 'session-failed',
        });
        onPlaybackCompleteRef.current?.({ id: item.id, text }, { interrupted: true });
        return;
      }

      queueRef.current.push({ id: item.id, text });
      setQueuedCount(queueRef.current.length);
      pumpQueueRef.current?.();
    },
    []
  );

  const sendTranscriptionPrompt = useCallback(
    (prompt: string | null) => {
      const transcriptionModel = transcriptionModelRef.current;
      if (!transcriptionModel) return;
      const normalized = prompt?.trim() ? prompt.trim() : null;
      sendEvent({
        type: 'session.update',
        session: {
          type: 'realtime',
          audio: {
            input: {
              transcription: {
                model: transcriptionModel,
                language: 'en',
                ...(normalized ? { prompt: normalized } : {}),
              },
            },
          },
        },
      });
      sentPromptRef.current = normalized;
    },
    [sendEvent]
  );

  const teardown = useCallback(
    (reason: string) => {
      generationRef.current += 1;

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (renewTimerRef.current) {
        clearTimeout(renewTimerRef.current);
        renewTimerRef.current = null;
      }
      if (promptTimerRef.current) {
        clearTimeout(promptTimerRef.current);
        promptTimerRef.current = null;
      }

      clearQueue(reason);
      // The agent may be blocked on this utterance; release it before the
      // transport goes away.
      completeActive(true, reason);

      const channel = dcRef.current;
      dcRef.current = null;
      if (channel) {
        channel.onmessage = null;
        channel.onopen = null;
        channel.onclose = null;
        try {
          channel.close();
        } catch {
          /* already closing */
        }
      }

      const pc = pcRef.current;
      pcRef.current = null;
      if (pc) {
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        try {
          pc.close();
        } catch {
          /* already closed */
        }
      }

      const stream = micStreamRef.current;
      micStreamRef.current = null;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }

      const audioElement = audioElementRef.current;
      audioElementRef.current = null;
      if (audioElement) {
        audioElement.pause();
        audioElement.srcObject = null;
        audioElement.remove();
      }

      transcriptionModelRef.current = null;
      sentPromptRef.current = null;
      utteranceDurationsRef.current.clear();
      lastUtteranceDurationRef.current = null;
      speechStartRef.current = null;
      bargeInEventIdsRef.current.clear();
    },
    [clearQueue, completeActive]
  );

  const scheduleReconnect = useCallback(
    (reason: string) => {
      if (!enabledRef.current) return;
      if (reconnectTimerRef.current) return;

      const attempt = reconnectAttemptsRef.current;
      if (attempt >= RECONNECT_MAX_ATTEMPTS) {
        sessionFailedRef.current = true;
        // Nothing will drain the queue now; release whatever the agent may be
        // waiting on rather than letting each turn hit its 15s timeout.
        clearQueue('session-failed');
        setInputStatusSafe('error');
        setOutputStatusSafe('error');
        setErrorSafe('Voice connection lost.');
        onLogEventRef.current?.('chat.voice_session.error', {
          stage: 'reconnect',
          reason,
          attempts: attempt,
        });
        return;
      }

      reconnectAttemptsRef.current = attempt + 1;
      const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
      onLogEventRef.current?.('chat.voice_session.disconnected', {
        reason,
        retryInMs: delay,
        attempt: attempt + 1,
      });

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        setConnectNonce((nonce) => nonce + 1);
      }, delay);
    },
    [clearQueue, setErrorSafe, setInputStatusSafe, setOutputStatusSafe]
  );

  const handleServerEvent = useCallback(
    (event: Record<string, unknown>) => {
      const type = readString(event.type);
      if (!type) return;

      switch (type) {
        case 'session.created':
        case 'session.updated':
          return;

        case 'input_audio_buffer.speech_started': {
          const itemId = readString(event.item_id);
          speechStartRef.current = {
            itemId,
            wallClockMs: performance.now(),
          };
          const audioStartMs = readNumber(event.audio_start_ms);
          if (itemId && audioStartMs !== null) {
            utteranceDurationsRef.current.set(`start:${itemId}`, audioStartMs);
          }
          setInputStatusSafe(suspendedRef.current ? 'suspended' : 'capturing');

          // Barge-in. The session is minted with interrupt_response=true so the
          // server cancels on its own, but driving it from here too makes the
          // cut immediate and keeps the feature working even if the server-side
          // interrupt ever stops firing alongside create_response=false.
          const active = activeRef.current;
          if (active && !active.completed) {
            clearQueue('barge-in');
            const cancelId = `bargein-cancel-${speakSeqRef.current}`;
            const clearId = `bargein-clear-${speakSeqRef.current}`;
            // Only the newest pair can still draw an error; drop the rest so
            // this set cannot grow for the life of the session.
            bargeInEventIdsRef.current.clear();
            bargeInEventIdsRef.current.add(cancelId);
            bargeInEventIdsRef.current.add(clearId);
            sendEvent({ type: 'response.cancel', event_id: cancelId });
            sendEvent({ type: 'output_audio_buffer.clear', event_id: clearId });
          }
          return;
        }

        case 'input_audio_buffer.speech_stopped': {
          const itemId = readString(event.item_id);
          const started = speechStartRef.current;
          speechStartRef.current = null;

          const audioEndMs = readNumber(event.audio_end_ms);
          const audioStartMs = itemId
            ? utteranceDurationsRef.current.get(`start:${itemId}`)
            : undefined;

          let durationMs: number;
          if (audioEndMs !== null && audioStartMs !== undefined) {
            durationMs = Math.max(0, audioEndMs - audioStartMs);
          } else if (started) {
            durationMs = Math.max(0, performance.now() - started.wallClockMs);
          } else {
            durationMs = 0;
          }

          if (itemId) {
            utteranceDurationsRef.current.delete(`start:${itemId}`);
            // A transcript that never arrives would otherwise pin its entry
            // here for the life of the session.
            if (utteranceDurationsRef.current.size > MAX_TRACKED_UTTERANCES) {
              const oldest = utteranceDurationsRef.current.keys().next();
              if (!oldest.done) utteranceDurationsRef.current.delete(oldest.value);
            }
            utteranceDurationsRef.current.set(itemId, durationMs);
          }
          lastUtteranceDurationRef.current = durationMs;

          setInputStatusSafe(suspendedRef.current ? 'suspended' : 'transcribing');
          onLogEventRef.current?.('chat.voice_input.captured', { durationMs });
          return;
        }

        case 'conversation.item.input_audio_transcription.completed': {
          const itemId = readString(event.item_id);
          const transcript = readString(event.transcript) ?? '';
          const durationMs =
            (itemId ? utteranceDurationsRef.current.get(itemId) : undefined) ??
            lastUtteranceDurationRef.current ??
            0;
          if (itemId) utteranceDurationsRef.current.delete(itemId);

          setInputStatusSafe(suspendedRef.current ? 'suspended' : 'listening');
          onLogEventRef.current?.('chat.voice_input.transcribed', {
            durationMs,
            textLength: transcript.length,
          });

          if (!transcript) return;
          if (suspendedRef.current) {
            onLogEventRef.current?.('chat.voice_input.ignored', {
              durationMs,
              reason: 'suspended',
              text: transcript,
            });
            return;
          }
          onTranscriptRef.current({ text: transcript, durationMs });
          return;
        }

        case 'conversation.item.input_audio_transcription.failed': {
          const failedItemId = readString(event.item_id);
          if (failedItemId) utteranceDurationsRef.current.delete(failedItemId);
          setInputStatusSafe(suspendedRef.current ? 'suspended' : 'listening');
          onLogEventRef.current?.('chat.voice_input.error', {
            stage: 'transcription',
            message: readString((event.error as Record<string, unknown> | undefined)?.message) ?? 'Transcription failed.',
          });
          return;
        }

        case 'response.created': {
          const response = event.response as Record<string, unknown> | undefined;
          const active = activeRef.current;
          if (!active || active.responseId) return;
          // Correlate by the seq we stamped into metadata rather than "the first
          // response.created wins": a late event from an earlier response would
          // otherwise bind this item to the wrong id for good.
          const metadata = response?.metadata as Record<string, unknown> | undefined;
          const seq = readString(metadata?.seq);
          if (seq && seq !== String(active.seq)) return;
          active.responseId = readString(response?.id);
          return;
        }

        case 'output_audio_buffer.started': {
          const active = activeRef.current;
          // Until response.created has bound an id, any audio-buffer event
          // necessarily belongs to an earlier response -- a response always
          // exists before it produces audio.
          if (!active || active.completed || !active.responseId) return;
          if (readString(event.response_id) !== active.responseId) return;
          active.audioStarted = true;
          setOutputStatusSafe('playing');
          setSpeakingItem(active.item);
          return;
        }

        case 'output_audio_buffer.stopped': {
          const active = activeRef.current;
          if (!active || !active.responseId) return;
          if (readString(event.response_id) !== active.responseId) return;
          completeActive(false, 'audio-drained');
          setOutputStatusSafe(enabledRef.current ? 'idle' : 'off');
          pumpQueueRef.current?.();
          return;
        }

        case 'output_audio_buffer.cleared': {
          const active = activeRef.current;
          if (!active || !active.responseId) return;
          if (readString(event.response_id) !== active.responseId) return;
          clearQueue('interrupted');
          completeActive(true, 'interrupted');
          setOutputStatusSafe(enabledRef.current ? 'idle' : 'off');
          return;
        }

        case 'response.done': {
          const response = event.response as Record<string, unknown> | undefined;
          const status = readString(response?.status);
          const active = activeRef.current;
          if (!active || !active.responseId) return;
          if (readString(response?.id) !== active.responseId) return;

          if (status === 'cancelled') {
            clearQueue('cancelled');
            completeActive(true, 'cancelled');
            setOutputStatusSafe(enabledRef.current ? 'idle' : 'off');
            return;
          }

          if (status === 'failed' || status === 'incomplete') {
            const message =
              readString(
                (
                  (response?.status_details as Record<string, unknown> | undefined)?.error as
                    | Record<string, unknown>
                    | undefined
                )?.message
              ) ?? 'Voice output failed.';
            completeActive(false, `response-${status}`);
            setErrorSafe(message);
            setOutputStatusSafe('error');
            onLogEventRef.current?.('chat.voice_output.error', {
              stage: 'response',
              message,
            });
            pumpQueueRef.current?.();
            return;
          }

          // Completed with no audio ever started: nothing will drain, so close
          // the turn now instead of waiting for the watchdog.
          if (!active.audioStarted) {
            completeActive(false, 'no-audio');
            setOutputStatusSafe(enabledRef.current ? 'idle' : 'off');
            pumpQueueRef.current?.();
          }
          return;
        }

        case 'error': {
          const eventId = readString(event.event_id);
          // Cancelling an already-cancelled response is expected during
          // barge-in; the server got there first.
          if (eventId && bargeInEventIdsRef.current.has(eventId)) {
            bargeInEventIdsRef.current.delete(eventId);
            return;
          }
          const message =
            readString((event.error as Record<string, unknown> | undefined)?.message) ??
            readString(event.message) ??
            'Voice session error.';
          onLogEventRef.current?.('chat.voice_session.error', {
            stage: 'session',
            message,
          });

          // A rejected response.create never produces response.done, so nothing
          // else would ever close out this utterance.
          const active = activeRef.current;
          if (active && eventId === `speak-${active.seq}`) {
            completeActive(false, 'speak-rejected');
            setOutputStatusSafe(enabledRef.current ? 'idle' : 'off');
            pumpQueueRef.current?.();
          }
          return;
        }

        default:
          return;
      }
    },
    [clearQueue, completeActive, sendEvent, setErrorSafe, setInputStatusSafe, setOutputStatusSafe, setSpeakingItem]
  );

  // Connection lifecycle. Reconnects and the 50-minute renewal both re-run this
  // by bumping connectNonce.
  useEffect(() => {
    if (!supported) {
      setInputStatusSafe('unsupported');
      setOutputStatusSafe('off');
      return;
    }

    if (!enabled) {
      teardown('disabled');
      reconnectAttemptsRef.current = 0;
      sessionFailedRef.current = false;
      setInputStatusSafe('off');
      setOutputStatusSafe('off');
      setErrorSafe(null);
      return;
    }

    let disposed = false;
    const generation = generationRef.current;

    const open = async () => {
      setInputStatusSafe('requesting-permission');
      setOutputStatusSafe('idle');

      // Run both in parallel, but keep a handle on the microphone promise: if
      // the token request rejects first, the mic still resolves afterwards and
      // its tracks would stay live -- recording indicator on, nothing holding
      // them -- unless we stop them explicitly.
      const micStreamPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const stopOrphanedMic = () => {
        void micStreamPromise
          .then((stream) => {
            if (micStreamRef.current === stream) return;
            for (const track of stream.getTracks()) track.stop();
          })
          .catch(() => undefined);
      };

      try {
        const [credentials, micStream] = await Promise.all([
          createSessionRef.current(),
          micStreamPromise,
        ]);

        if (disposed || generationRef.current !== generation) {
          for (const track of micStream.getTracks()) track.stop();
          return;
        }

        micStreamRef.current = micStream;
        transcriptionModelRef.current = credentials.transcriptionModel;

        const audioElement = document.createElement('audio');
        audioElement.autoplay = true;
        audioElement.style.display = 'none';
        document.body.appendChild(audioElement);
        audioElementRef.current = audioElement;

        const pc = new RTCPeerConnection();
        pcRef.current = pc;

        pc.ontrack = (trackEvent) => {
          const element = audioElementRef.current;
          if (!element) return;
          element.srcObject = trackEvent.streams[0] ?? null;
          void element.play().catch(() => {
            setErrorSafe('Allow audio playback to hear the assistant.');
          });
        };

        pc.onconnectionstatechange = () => {
          if (generationRef.current !== generation) return;
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            teardown('connection-lost');
            scheduleReconnect(pc.connectionState);
          }
        };

        const [micTrack] = micStream.getAudioTracks();
        if (micTrack) {
          micTrack.enabled = !suspendedRef.current;
          pc.addTrack(micTrack, micStream);
        }

        const channel = pc.createDataChannel('oai-events');
        dcRef.current = channel;

        channel.onopen = () => {
          if (generationRef.current !== generation) return;
          reconnectAttemptsRef.current = 0;
          sessionFailedRef.current = false;
          setErrorSafe(null);
          setInputStatusSafe(suspendedRef.current ? 'suspended' : 'listening');
          setOutputStatusSafe('idle');
          sendTranscriptionPrompt(transcriptionPromptRef.current);
          onLogEventRef.current?.('chat.voice_session.connected', {
            model: credentials.model,
          });
          pumpQueueRef.current?.();
        };

        channel.onmessage = (messageEvent) => {
          if (generationRef.current !== generation) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(messageEvent.data as string);
          } catch {
            return;
          }
          if (parsed && typeof parsed === 'object') {
            handleServerEvent(parsed as Record<string, unknown>);
          }
        };

        channel.onclose = () => {
          if (generationRef.current !== generation) return;
          teardown('channel-closed');
          scheduleReconnect('channel-closed');
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const sdpResponse = await fetch(REALTIME_CALLS_URL, {
          method: 'POST',
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${credentials.clientSecret}`,
            'Content-Type': 'application/sdp',
          },
        });

        if (!sdpResponse.ok) {
          throw new Error(`Realtime handshake failed (HTTP ${sdpResponse.status}).`);
        }

        const answerSdp = await sdpResponse.text();
        if (disposed || generationRef.current !== generation) return;
        await pc.setRemoteDescription({ type: 'answer' as const, sdp: answerSdp });

        renewTimerRef.current = setTimeout(() => {
          if (generationRef.current !== generation) return;
          onLogEventRef.current?.('chat.voice_session.renewed', {});
          teardown('renew');
          setConnectNonce((nonce) => nonce + 1);
        }, SESSION_RENEW_AFTER_MS);
      } catch (connectError) {
        stopOrphanedMic();
        if (disposed || generationRef.current !== generation) return;
        const message = toErrorMessage(connectError);
        teardown('connect-failed');
        onLogEventRef.current?.('chat.voice_input.error', {
          stage: 'connection',
          message,
        });
        setErrorSafe(message);
        setInputStatusSafe('error');
        setOutputStatusSafe('error');
        scheduleReconnect('connect-failed');
      }
    };

    void open();

    return () => {
      disposed = true;
      teardown('cleanup');
    };
  }, [
    enabled,
    supported,
    connectNonce,
    handleServerEvent,
    scheduleReconnect,
    sendTranscriptionPrompt,
    setErrorSafe,
    setInputStatusSafe,
    setOutputStatusSafe,
    teardown,
  ]);

  // Keep the mic gated and the idle label honest while the session is up.
  useEffect(() => {
    const stream = micStreamRef.current;
    if (stream) {
      for (const track of stream.getAudioTracks()) track.enabled = !suspended;
    }
    if (!enabled || inputStatusRef.current === 'error' || inputStatusRef.current === 'unsupported') {
      return;
    }
    if (inputStatusRef.current === 'suspended' && !suspended) {
      setInputStatusSafe('listening');
    } else if (inputStatusRef.current === 'listening' && suspended) {
      setInputStatusSafe('suspended');
    }
  }, [enabled, suspended, setInputStatusSafe]);

  // The on-screen options change as the user moves through stages; push them to
  // the transcriber so it biases toward what is actually on screen.
  useEffect(() => {
    transcriptionPromptRef.current = transcriptionPrompt;
    if (!enabled) return;

    if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    promptTimerRef.current = setTimeout(() => {
      promptTimerRef.current = null;
      const normalized = transcriptionPrompt?.trim() ? transcriptionPrompt.trim() : null;
      if (normalized === sentPromptRef.current) return;
      sendTranscriptionPrompt(normalized);
    }, TRANSCRIPTION_PROMPT_DEBOUNCE_MS);

    return () => {
      if (promptTimerRef.current) {
        clearTimeout(promptTimerRef.current);
        promptTimerRef.current = null;
      }
    };
  }, [enabled, transcriptionPrompt, sendTranscriptionPrompt]);

  return {
    supported,
    inputStatus,
    outputStatus,
    error,
    isSpeaking: outputStatus === 'synthesizing' || outputStatus === 'playing' || queuedCount > 0,
    speak,
    stop,
  };
}
