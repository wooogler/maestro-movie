/**
 * The paired phone's relay connection.
 *
 * Modelled on `useMemoryViewer`, with one deliberate difference that is the
 * whole point of this file: a viewer is read-only, so the only `error` it can
 * ever receive is a join refusal and treating every error as terminal is
 * correct. A companion **sends**, so it also receives errors about the frames it
 * sent — `HOST_UNAVAILABLE` arrives whenever the kiosk's socket is mid-reconnect,
 * which it is for 1200ms at a time, routinely. Copying the viewer's policy would
 * mean one sentence spoken at the wrong moment kills the pairing for the rest of
 * the session.
 *
 * So failures are split into two classes:
 *   - refusals **on the join reply** (`COMPANION_PAIRING_INVALID`) are permanent;
 *     the pairing is dead and re-scanning is the only way back.
 *   - anything else is transient. Capture pauses, the socket stays, and the next
 *     `companion.config` resumes it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PROTOCOL_VERSION,
  parseAgentMemorySnapshot,
  type AgentMemorySnapshot,
  type MemoryCommand,
} from '../../agent/protocol';

export type CompanionStatus = 'idle' | 'connecting' | 'paired' | 'unpaired' | 'ended';

export interface CompanionConfig {
  language: string;
  transcriptionPrompt: string | null;
  listening: boolean;
}

export interface CompanionSpeakRequest {
  id: string | null;
  text: string;
  stop?: boolean;
  /** Monotonic per delivery, so an identical repeat still re-triggers effects. */
  seq: number;
}

export interface CompanionLinkState {
  status: CompanionStatus;
  /** Null until the host has pushed one; the phone must not capture before then. */
  config: CompanionConfig | null;
  speakRequest: CompanionSpeakRequest | null;
  memory: AgentMemorySnapshot | null;
  message: string | null;
  sendTranscript: (payload: { text: string; durationMs: number }) => void;
  sendPlaybackComplete: (payload: { id: string | null; interrupted: boolean }) => void;
  /** Ask the kiosk to move voice to this phone, or hand it back. */
  sendClaim: (claimed: boolean) => void;
  /**
   * Ask the kiosk to change preference memory. The phone holds no memory of its
   * own and keeps nothing past the session — the agent is the only store, and
   * what comes back on `agent.memory` is the only truth the phone renders.
   */
  sendMemoryCommand: (command: MemoryCommand) => void;
}

/** Matches `buildWsUrl` in useAgentBridge; kept in step deliberately. */
function buildWsUrl(): string {
  const configured = import.meta.env.VITE_AGENT_WS_URL as string | undefined;
  const endpoint =
    configured && configured.trim()
      ? configured.trim()
      : import.meta.env.DEV
        ? 'ws://localhost:3000/agent/ws'
        : '/agent/ws';

  if (/^wss?:\/\//.test(endpoint)) return endpoint;

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const basePath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${protocol}://${window.location.host}${basePath}`;
}

const RECONNECT_DELAY_MS = 2_000;
const JOIN_ID = 'companion-join';
const HELLO_RETRY_MS = 2_000;
const PING_INTERVAL_MS = 2_500;

export function useCompanionLink(companionToken: string | null): CompanionLinkState {
  const [status, setStatus] = useState<CompanionStatus>('idle');
  const [config, setConfig] = useState<CompanionConfig | null>(null);
  const [speakRequest, setSpeakRequest] = useState<CompanionSpeakRequest | null>(null);
  const [memory, setMemory] = useState<AgentMemorySnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);

  const send = useCallback((type: string, payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type, payload }));
    } catch {
      // A send failure is transient by definition here; the socket's own close
      // handler drives reconnection.
    }
  }, []);

  useEffect(() => {
    if (!companionToken) {
      setStatus('idle');
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;
    // Only a join refusal sets this. See the note at the top of the file.
    let pairingDead = false;

    const connect = () => {
      if (disposed) return;
      setStatus('connecting');

      const ws = new WebSocket(buildWsUrl());
      socketRef.current = ws;

      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'relay.join',
            id: JOIN_ID,
            payload: { role: 'companion', companionToken },
          })
        );
      });

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let envelope: { type?: string; replyTo?: string; payload?: Record<string, unknown> } | null = null;
        try {
          envelope = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!envelope || typeof envelope.type !== 'string') return;

        if (envelope.type === 'relay.joined') {
          setStatus('paired');
          setMessage(null);
          // Pull-based config: announce on every join so a re-pair cannot leave
          // this phone waiting for an edge that will never come.
          try {
            ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'companion.hello', payload: {} }));
          } catch {
            /* the close handler will retry the whole join */
          }
          return;
        }

        if (envelope.type === 'error') {
          const code = typeof envelope.payload?.code === 'string' ? envelope.payload.code : '';
          const text =
            typeof envelope.payload?.message === 'string' ? envelope.payload.message : null;
          // Permanent only when the JOIN itself was refused. `replyTo` is what
          // distinguishes that from an error about a frame we sent afterwards.
          if (envelope.replyTo === JOIN_ID || code === 'COMPANION_PAIRING_INVALID') {
            pairingDead = true;
            setStatus('unpaired');
            setMessage(text);
            return;
          }
          // Transient. Stop capturing until the host says otherwise, but keep
          // the socket and the pairing.
          setConfig((current) => (current ? { ...current, listening: false } : current));
          return;
        }

        if (envelope.type === 'companion.config') {
          const payload = envelope.payload ?? {};
          setConfig({
            language: typeof payload.language === 'string' ? payload.language : 'en',
            transcriptionPrompt:
              typeof payload.transcriptionPrompt === 'string' ? payload.transcriptionPrompt : null,
            listening: payload.listening === true,
          });
          return;
        }

        if (envelope.type === 'companion.speak') {
          const payload = envelope.payload ?? {};
          seqRef.current += 1;
          setSpeakRequest({
            id: typeof payload.id === 'string' ? payload.id : null,
            text: typeof payload.text === 'string' ? payload.text : '',
            stop: payload.stop === true,
            seq: seqRef.current,
          });
          return;
        }

        if (envelope.type === 'agent.memory') {
          const snapshot = parseAgentMemorySnapshot(envelope.payload);
          if (snapshot) setMemory(snapshot);
        }
      });

      ws.addEventListener('close', () => {
        if (disposed) return;
        socketRef.current = null;
        if (pairingDead) {
          setStatus('unpaired');
          return;
        }
        setStatus('connecting');
        // Config does not survive a reconnect: the host re-pushes it on our
        // `hello`, and capturing against a stale prompt is worse than a pause.
        setConfig(null);
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [companionToken]);

  const sendTranscript = useCallback(
    (payload: { text: string; durationMs: number }) => send('companion.transcript', payload),
    [send]
  );
  const sendPlaybackComplete = useCallback(
    (payload: { id: string | null; interrupted: boolean }) =>
      send('companion.playback.complete', { ...payload }),
    [send]
  );
  const sendClaim = useCallback((claimed: boolean) => send('companion.claim', { claimed }), [send]);
  const sendMemoryCommand = useCallback(
    (command: MemoryCommand) => send('companion.memory.command', { command }),
    [send]
  );

  /*
    Keep asking until the kiosk answers.

    `hello` is sent once, on join, and config delivery is pull-based. That was
    fine while the QR only existed inside the booking page — the kiosk was
    always already there. It is not fine now that the code is offered on the
    pairing screen: a visitor can scan and tap before anyone presses "start
    booking", the relay answers HOST_UNAVAILABLE, and nothing ever re-asks. The
    phone then sits with no config forever, so every tap on its audio button
    does precisely nothing and the button looks broken.

    Retries stop the instant config lands, and a closed socket is handled by the
    reconnect path instead.
  */
  useEffect(() => {
    if (status !== 'paired' || config !== null) return;
    const timer = window.setInterval(() => send('companion.hello', {}), HELLO_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [status, config, send]);

  /*
    Proof that this page is still running, for the kiosk's device roster.

    Its own interval rather than a widened `hello` retry above: a repeating
    `hello` re-fires the host's hello handler, which re-applies the visitor's
    recorded audio-target choice — so it would fight the presenter's kiosk
    override every couple of seconds.

    A page-level frame, not a protocol ping: the browser's network stack answers
    those on its own, so a locked phone would keep ponging while its timers and
    its microphone are frozen. That is the failure this exists to catch.
  */
  useEffect(() => {
    if (status !== 'paired') return;
    const timer = window.setInterval(() => send('companion.ping', {}), PING_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [status, send]);

  return {
    status,
    config,
    speakRequest,
    memory,
    message,
    sendTranscript,
    sendPlaybackComplete,
    sendClaim,
    sendMemoryCommand,
  };
}
