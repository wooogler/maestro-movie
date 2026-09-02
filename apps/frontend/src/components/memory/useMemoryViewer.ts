/**
 * Watches another device's session over the relay, read-only.
 *
 * This is the cross-device half of the memory mirror. The same-machine half
 * (`memoryChannel.ts`, BroadcastChannel) is kept: it needs no backend at all, so
 * on the booth's laptop-plus-HDMI setup it keeps working even if the network
 * does not. This path is for a phone, which BroadcastChannel cannot reach.
 *
 * The connection carries a **view token**, never the study token. The study
 * token authorises the host role, the trace download and finishing the session;
 * a second device must be able to watch without being able to do any of that.
 * The relay resolves the token to a session and adds the socket to that
 * session's viewers, which receive `agent.memory` and nothing else.
 */

import { useEffect, useState } from 'react';
import {
  PROTOCOL_VERSION,
  parseAgentMemorySnapshot,
  parseDeviceRoster,
  type AgentMemorySnapshot,
  type DeviceRosterPayload,
} from '../../agent/protocol';

export type MemoryViewerStatus = 'idle' | 'connecting' | 'watching' | 'ended' | 'error';

export interface MemoryViewerState {
  snapshot: AgentMemorySnapshot | null;
  /** Always null on this path; see the note where `agent.memory` is handled. */
  stage: string | null;
  status: MemoryViewerStatus;
  /** Set when the relay refused or ended the connection, for the empty state. */
  message: string | null;
  /**
   * Who is attached to the session being watched.
   *
   * Cleared whenever this socket drops, so a roster observed on a previous
   * connection can never be reported as a fact about the current one.
   */
  devices: { roster: DeviceRosterPayload; atMs: number } | null;
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

export function useMemoryViewer(viewToken: string | null): MemoryViewerState {
  const [state, setState] = useState<MemoryViewerState>({
    snapshot: null,
    stage: null,
    status: 'idle',
    message: null,
    devices: null,
  });

  useEffect(() => {
    if (!viewToken) {
      setState({ snapshot: null, stage: null, status: 'idle', message: null, devices: null });
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    // A refusal is permanent — an expired or finished session will not start
    // working if we ask again — so reconnecting is only for dropped sockets.
    let refused = false;

    const connect = () => {
      if (disposed) return;
      setState((current) => ({ ...current, status: 'connecting' }));

      const ws = new WebSocket(buildWsUrl());
      socket = ws;

      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'relay.join',
            id: 'viewer-join',
            payload: { role: 'viewer', viewToken },
          })
        );
      });

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let envelope: { type?: string; payload?: Record<string, unknown> } | null = null;
        try {
          envelope = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!envelope || typeof envelope.type !== 'string') return;

        if (envelope.type === 'relay.joined') {
          setState((current) => ({ ...current, status: 'watching', message: null }));
          return;
        }
        if (envelope.type === 'error') {
          refused = true;
          const message =
            typeof envelope.payload?.message === 'string'
              ? envelope.payload.message
              : 'This screen could not join the session.';
          setState((current) => ({ ...current, status: 'error', message }));
          return;
        }
        if (envelope.type === 'relay.devices') {
          const roster = parseDeviceRoster(envelope.payload);
          // Stamped on arrival; see the note on the same line in useAgentBridge.
          if (roster) setState((current) => ({ ...current, devices: { roster, atMs: Date.now() } }));
          return;
        }
        if (envelope.type === 'agent.memory') {
          const snapshot = parseAgentMemorySnapshot(envelope.payload);
          if (!snapshot) return;
          // No stage: the envelope does not carry one. On the same machine the
          // publisher adds the host's own `currentStage`, but a relay viewer has
          // no host state to read, and the panel renders without it.
          setState((current) => ({ ...current, snapshot, stage: null, status: 'watching', message: null }));
        }
      });

      ws.addEventListener('close', () => {
        if (disposed) return;
        if (refused) {
          setState((current) => ({ ...current, status: 'ended' }));
          return;
        }
        setState((current) => ({ ...current, status: 'connecting', devices: null }));
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [viewToken]);

  return state;
}
