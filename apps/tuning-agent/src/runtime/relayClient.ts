import WebSocket from 'ws';
import { EventBus } from './eventBus';
import { PROTOCOL_VERSION, type RelayEnvelope } from '../types';

interface PendingRequest {
  resolve: (envelope: RelayEnvelope) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RelayClientOptions {
  relayUrl: string;
  sessionId: string;
  agentName?: string;
  requestTimeoutMs?: number;
  /** Set to 0 to disable automatic reconnection. */
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
}

export type RelayLifecycleEvent =
  | { type: 'disconnected'; willRetry: boolean }
  | { type: 'reconnecting'; attempt: number; delayMs: number }
  | { type: 'reconnected'; attempt: number }
  | { type: 'reconnect-failed'; attempts: number; message: string };

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 8;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;

function parseText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf-8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf-8');
  if (Array.isArray(raw)) {
    const chunks = raw.filter((part): part is Buffer => Buffer.isBuffer(part));
    return Buffer.concat(chunks).toString('utf-8');
  }
  return String(raw);
}

export class RelayClient {
  readonly messages = new EventBus<RelayEnvelope>();
  /**
   * Connection lifecycle, separate from `messages` so consumers can resync
   * after a drop. The study build had no reconnect at all: `ws.on('close')`
   * nulled the socket and rejected pending requests, and the only path back to
   * a live connection was an inbound message — which can never arrive on a dead
   * socket. One dropped WebSocket left the agent process alive but permanently
   * deaf for the rest of the round, with nothing to restart it.
   */
  readonly lifecycle = new EventBus<RelayLifecycleEvent>();

  private ws: WebSocket | null = null;
  private closedIntentionally = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectInFlight = false;
  private readonly relayUrl: string;
  private readonly sessionId: string;
  private readonly agentName: string;
  private readonly requestTimeoutMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private requestSeq = 0;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: RelayClientOptions) {
    this.relayUrl = options.relayUrl;
    this.sessionId = options.sessionId;
    this.agentName = options.agentName?.trim() || 'tuning-agent';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        reject(new Error('relay socket is already connecting'));
        return;
      }

      const ws = new WebSocket(this.relayUrl);
      this.ws = ws;

      ws.on('open', () => {
        void this.join()
          .then(() => resolve())
          .catch(reject);
      });

      ws.on('message', (raw: unknown) => {
        const text = parseText(raw);
        let envelope: RelayEnvelope;

        try {
          envelope = JSON.parse(text) as RelayEnvelope;
        } catch {
          return;
        }

        if (envelope.replyTo && this.pending.has(envelope.replyTo)) {
          const entry = this.pending.get(envelope.replyTo);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(envelope.replyTo);
            if (envelope.type === 'error') {
              const payload = envelope.payload ?? {};
              const code = typeof payload.code === 'string' ? payload.code : 'RELAY_ERROR';
              const message = typeof payload.message === 'string' ? payload.message : 'Unknown relay error';
              entry.reject(new Error(`${code}: ${message}`));
            } else {
              entry.resolve(envelope);
            }
          }
        }

        void this.messages.emit(envelope);
      });

      ws.on('close', () => {
        if (this.ws === ws) {
          this.ws = null;
        }
        for (const [id, entry] of this.pending.entries()) {
          clearTimeout(entry.timer);
          entry.reject(new Error(`socket closed while waiting for ${id}`));
          this.pending.delete(id);
        }
        const willRetry = !this.closedIntentionally && this.maxReconnectAttempts > 0;
        void this.lifecycle.emit({ type: 'disconnected', willRetry });
        if (willRetry) this.scheduleReconnect();
      });

      ws.on('error', (error: Error) => {
        if (this.ws === ws && ws.readyState === WebSocket.CLOSED) {
          this.ws = null;
        }
        reject(error);
      });
    });
  }

  private join(): Promise<RelayEnvelope> {
    return this.request('relay.join', {
      role: 'agent',
      sessionId: this.sessionId,
      agentName: this.agentName,
    });
  }

  async request(type: string, payload: Record<string, unknown>): Promise<RelayEnvelope> {
    const id = `req-${Date.now()}-${++this.requestSeq}`;
    const envelope: RelayEnvelope = {
      v: PROTOCOL_VERSION,
      type,
      id,
      payload,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting reply for ${type}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendEnvelope(envelope);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  send(type: string, payload: Record<string, unknown>): void {
    const envelope: RelayEnvelope = {
      v: PROTOCOL_VERSION,
      type,
      id: `msg-${Date.now()}-${++this.requestSeq}`,
      payload,
    };
    this.sendEnvelope(envelope);
  }

  close(): void {
    this.closedIntentionally = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.ws) return;
    this.ws.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (this.reconnectInFlight || this.reconnectTimer) return;
    this.reconnectInFlight = true;
    void this.runReconnectLoop().finally(() => {
      this.reconnectInFlight = false;
    });
  }

  private async runReconnectLoop(): Promise<void> {
    let lastMessage = 'unknown error';
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt += 1) {
      if (this.closedIntentionally) return;

      const delayMs = Math.min(
        this.reconnectBaseDelayMs * 2 ** (attempt - 1),
        MAX_RECONNECT_DELAY_MS
      );
      void this.lifecycle.emit({ type: 'reconnecting', attempt, delayMs });
      await new Promise<void>((resolve) => {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          resolve();
        }, delayMs);
      });
      if (this.closedIntentionally) return;

      try {
        await this.connect();
        void this.lifecycle.emit({ type: 'reconnected', attempt });
        return;
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : String(error);
      }
    }
    void this.lifecycle.emit({
      type: 'reconnect-failed',
      attempts: this.maxReconnectAttempts,
      message: lastMessage,
    });
  }

  private sendEnvelope(envelope: RelayEnvelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('relay socket is not open');
    }
    this.ws.send(JSON.stringify(envelope));
  }
}
