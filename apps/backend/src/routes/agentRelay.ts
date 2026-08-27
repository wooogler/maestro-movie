import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import {
  getSessionContextByToken,
  getStudyModeByRelaySessionId,
} from '../study/sessionService';

type Role = 'host' | 'agent';
type Direction = 'in' | 'out' | 'internal';

interface RelayEnvelope {
  v?: string;
  type: string;
  id?: string;
  replyTo?: string;
  payload?: Record<string, unknown>;
}

interface RelayClient {
  id: string;
  role: Role | null;
  sessionId: string | null;
  clientName: string | null;
  socket: RelaySocket;
}

interface RelaySocket {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number) => void;
  on(event: 'message', handler: (raw: unknown) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (error: unknown) => void): void;
}

interface SessionState {
  host: RelayClient | null;
  agents: Set<RelayClient>;
  eventIndex: number;
}

const RELAY_VERSION = 'mvp-0.2';
const DEFAULT_SESSION_ID = 'default';
const LOG_DIR = path.resolve(process.cwd(), 'logs/study');
const ENABLE_RELAY_LOGS = process.env.AGENT_RELAY_LOG_ENABLED === 'true';

const AGENT_TO_HOST_TYPES = new Set([
  'session.start',
  'snapshot.get',
  'tool.call',
  'agent.message',
  'agent.status',
  // Preference memory and workflow navigation state. The host renders it in the
  // demo condition; study conditions ignore it.
  'agent.memory',
  'session.end',
]);

const HOST_TO_AGENT_TYPES = new Set([
  'session.started',
  'snapshot.state',
  'tool.result',
  'state.updated',
  'session.reset',
  'error',
  'session.ended',
  'user.message',
  'voice.mode',
  'tts.playback.complete',
]);

// Keys that must never survive a hop through the relay, in any casing/shape.
const SECRET_PAYLOAD_KEY_PATTERN = /^(x[-_])?(openai[-_]?)?api[-_]?key$/i;
const MAX_SANITIZE_DEPTH = 8;

const sessions = new Map<string, SessionState>();
// Relay session ids belonging to demo-mode study sessions. Demo produces zero
// log writes, so this is consulted before any log line is built.
const demoRelaySessionIds = new Set<string>();

function isDemoRelaySession(sessionId: string): boolean {
  if (demoRelaySessionIds.has(sessionId)) return true;
  if (getStudyModeByRelaySessionId(sessionId) === 'demo') {
    demoRelaySessionIds.add(sessionId);
    return true;
  }
  return false;
}

/**
 * Defensive scrub: a client should never put an API key in a relay envelope, but
 * if one shows up it must not be forwarded, logged, or snapshotted.
 */
function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripSecrets(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (SECRET_PAYLOAD_KEY_PATTERN.test(key)) continue;
    cleaned[key] = stripSecrets(entry, depth + 1);
  }
  return cleaned;
}

function sanitizeEnvelope(envelope: RelayEnvelope): RelayEnvelope {
  if (!envelope.payload || typeof envelope.payload !== 'object') return envelope;
  return {
    ...envelope,
    payload: stripSecrets(envelope.payload) as Record<string, unknown>,
  };
}

function getOrCreateSession(sessionId: string): SessionState {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const created: SessionState = {
    host: null,
    agents: new Set<RelayClient>(),
    eventIndex: 0,
  };
  sessions.set(sessionId, created);
  return created;
}

function toText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf-8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf-8');
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.filter((item): item is Buffer => Buffer.isBuffer(item))).toString(
      'utf-8'
    );
  }
  return null;
}

function parseEnvelope(raw: unknown): RelayEnvelope | null {
  const text = toText(raw);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as RelayEnvelope;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isSocketOpen(socket: RelaySocket): boolean {
  return socket.readyState === 1;
}

function sendEnvelope(socket: RelaySocket, envelope: RelayEnvelope): boolean {
  if (!isSocketOpen(socket)) return false;
  socket.send(JSON.stringify({ v: RELAY_VERSION, ...envelope }));
  return true;
}

function sendError(
  socket: RelaySocket,
  code: string,
  message: string,
  replyTo?: string
): void {
  sendEnvelope(socket, {
    type: 'error',
    replyTo,
    payload: { code, message },
  });
}

function appendSessionLog(
  sessionId: string,
  direction: Direction,
  type: string,
  payload: unknown
): void {
  if (!ENABLE_RELAY_LOGS) return;
  // Demo mode logs nothing, ever — even with AGENT_RELAY_LOG_ENABLED=true.
  if (isDemoRelaySession(sessionId)) return;

  const session = getOrCreateSession(sessionId);
  const entry = {
    sessionId,
    eventIndex: session.eventIndex++,
    timestamp: new Date().toISOString(),
    direction,
    type,
    payload,
  };

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const filePath = path.join(LOG_DIR, `${sessionId}.jsonl`);
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (error) {
    // Prototype logging must never crash relay traffic.
    console.error('Failed to append relay log:', error);
  }
}

function removeClient(client: RelayClient): void {
  if (!client.sessionId) return;
  const session = sessions.get(client.sessionId);
  if (!session) return;

  if (session.host?.id === client.id) {
    session.host = null;
  }
  session.agents.delete(client);

  if (!session.host && session.agents.size === 0) {
    sessions.delete(client.sessionId);
    demoRelaySessionIds.delete(client.sessionId);
  }
}

function defaultAgentName(clientId: string): string {
  return `agent-${clientId.slice(-6)}`;
}

function resolveAgentName(payload: Record<string, unknown> | undefined, fallbackClientId: string): string {
  const raw = payload?.agentName ?? payload?.clientName ?? payload?.name;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return defaultAgentName(fallbackClientId);
}

function buildPresencePayload(sessionId: string): Record<string, unknown> {
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      sessionId,
      hostActive: false,
      agentCount: 0,
      agents: [],
    };
  }

  const hostActive = Boolean(session.host && isSocketOpen(session.host.socket));
  const agents = Array.from(session.agents)
    .filter((agent) => isSocketOpen(agent.socket))
    .map((agent) => ({
      id: agent.id,
      name: agent.clientName ?? defaultAgentName(agent.id),
    }));

  return {
    sessionId,
    hostActive,
    agentCount: agents.length,
    agents,
  };
}

function notifySessionPresence(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  const payload = buildPresencePayload(sessionId);
  let delivered = 0;

  if (session.host && sendEnvelope(session.host.socket, { type: 'relay.presence', payload })) {
    delivered += 1;
  }

  for (const agent of session.agents) {
    if (sendEnvelope(agent.socket, { type: 'relay.presence', payload })) {
      delivered += 1;
    }
  }

  if (delivered > 0) {
    appendSessionLog(sessionId, 'internal', 'relay.presence', payload);
  }
}

function relayToHost(client: RelayClient, message: RelayEnvelope): void {
  const sessionId = client.sessionId;
  if (!sessionId) return;

  const session = getOrCreateSession(sessionId);
  const host = session.host;
  appendSessionLog(sessionId, 'in', message.type, message.payload ?? {});

  if (!host || !isSocketOpen(host.socket)) {
    sendError(client.socket, 'SESSION_NOT_ACTIVE', 'No active host connection for this session.', message.id);
    return;
  }

  sendEnvelope(host.socket, message);
  appendSessionLog(sessionId, 'out', message.type, message.payload ?? {});
}

function relayToAgents(client: RelayClient, message: RelayEnvelope): void {
  const sessionId = client.sessionId;
  if (!sessionId) return;

  const session = getOrCreateSession(sessionId);
  appendSessionLog(sessionId, 'in', message.type, message.payload ?? {});

  let delivered = 0;
  for (const agent of session.agents) {
    if (sendEnvelope(agent.socket, message)) {
      delivered += 1;
    }
  }

  appendSessionLog(sessionId, 'out', message.type, {
    delivered,
    payload: message.payload ?? {},
  });
}

export async function agentRelayRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/agent/ws', { websocket: true }, (socket: RelaySocket) => {
    const client: RelayClient = {
      id: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: null,
      sessionId: null,
      clientName: null,
      socket,
    };

    sendEnvelope(client.socket, {
      type: 'relay.hello',
      payload: {
        message: 'Send relay.join with role=host|agent',
      },
    });

    client.socket.on('message', (raw: unknown) => {
      const parsed = parseEnvelope(raw);
      const message = parsed ? sanitizeEnvelope(parsed) : null;
      if (!message) {
        sendError(client.socket, 'INVALID_MESSAGE', 'Message must be valid JSON with a string "type".');
        return;
      }

      if (message.type === 'relay.join') {
        const payload = message.payload ?? {};
        const role = payload.role;
        const requestedSessionId = payload.sessionId;
        let sessionId =
          typeof requestedSessionId === 'string' && requestedSessionId.trim()
            ? requestedSessionId.trim()
            : DEFAULT_SESSION_ID;

        if (role !== 'host' && role !== 'agent') {
          sendError(client.socket, 'INVALID_MESSAGE', 'relay.join payload.role must be "host" or "agent".', message.id);
          return;
        }

        if (role === 'host') {
          const studyToken =
            typeof payload.studyToken === 'string' ? payload.studyToken.trim() : '';
          if (!studyToken) {
            sendError(
              client.socket,
              'SESSION_NOT_ACTIVE',
              'relay.join for host requires payload.studyToken.',
              message.id
            );
            return;
          }
          const context = getSessionContextByToken(studyToken);
          if (!context) {
            sendError(
              client.socket,
              'SESSION_NOT_ACTIVE',
              'Study session is invalid, finished, or expired.',
              message.id
            );
            return;
          }
          sessionId = context.record.relaySessionId;
        }

        // Resolve and cache demo membership at join time, so logging stays off
        // for the whole connection even after the study record is gone.
        isDemoRelaySession(sessionId);

        if (client.sessionId) {
          const previousSessionId = client.sessionId;
          removeClient(client);
          notifySessionPresence(previousSessionId);
        }

        client.role = role;
        client.sessionId = sessionId;
        client.clientName = role === 'agent' ? resolveAgentName(payload, client.id) : null;

        const session = getOrCreateSession(sessionId);

        if (role === 'host') {
          if (session.host && session.host.id !== client.id) {
            sendError(session.host.socket, 'SESSION_NOT_ACTIVE', 'Host connection replaced by a newer host.');
            session.host.socket.close(1000);
          }
          session.host = client;
        } else {
          session.agents.add(client);
        }

        appendSessionLog(sessionId, 'internal', 'relay.join', {
          clientId: client.id,
          role,
          clientName: client.clientName,
        });

        sendEnvelope(client.socket, {
          type: 'relay.joined',
          replyTo: message.id,
          payload: {
            role,
            sessionId,
            ...(role === 'agent' ? { clientName: client.clientName } : {}),
          },
        });
        notifySessionPresence(sessionId);
        return;
      }

      if (!client.role || !client.sessionId) {
        sendError(client.socket, 'SESSION_NOT_ACTIVE', 'You must send relay.join before other messages.', message.id);
        return;
      }

      if (client.role === 'agent') {
        if (!AGENT_TO_HOST_TYPES.has(message.type)) {
          sendError(client.socket, 'INVALID_MESSAGE', `Unsupported message type for agent role: ${message.type}`, message.id);
          return;
        }
        relayToHost(client, message);
        return;
      }

      if (!HOST_TO_AGENT_TYPES.has(message.type)) {
        sendError(client.socket, 'INVALID_MESSAGE', `Unsupported message type for host role: ${message.type}`, message.id);
        return;
      }
      relayToAgents(client, message);
    });

    client.socket.on('close', () => {
      const previousSessionId = client.sessionId;
      const previousRole = client.role;
      if (client.sessionId) {
        appendSessionLog(client.sessionId, 'internal', 'relay.disconnect', {
          clientId: client.id,
          role: client.role,
          clientName: client.clientName,
        });
      }
      removeClient(client);
      if (previousSessionId && (previousRole === 'host' || previousRole === 'agent')) {
        notifySessionPresence(previousSessionId);
      }
    });

    client.socket.on('error', (error: unknown) => {
      if (client.sessionId) {
        appendSessionLog(client.sessionId, 'internal', 'relay.error', {
          clientId: client.id,
          role: client.role,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
}
