import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import {
  getRelaySessionIdByAgentToken,
  getRelaySessionIdByCompanionToken,
  getRelaySessionIdByViewToken,
  setCompanionAttached,
  getSessionContextByToken,
  getStudyModeByRelaySessionId,
} from '../study/sessionService';

/**
 * `viewer` is a read-only spectator: a second device that watches this session's
 * agent memory and can send nothing. It exists because `host` is a single slot —
 * a second host join evicts the first — so "open the same session on my phone"
 * was previously impossible without killing the laptop's booking window.
 */
/**
 * `companion` is the session's paired microphone and speaker: a phone that
 * captures the visitor's voice and speaks the agent's replies while the kiosk
 * keeps the booking GUI.
 *
 * Two properties separate it from `viewer`. It is **write-capable**, but only on
 * a lane that terminates at the host — it can never address the agent, so the
 * host stays the sole owner of the agent-facing speech barrier and of every
 * filtering and logging rule. And it is a **single slot** like the host: two
 * phones would each answer one `companion.speak` with a completion, the host
 * would forward both as `tts.playback.complete`, and the agent's barrier counts
 * completions as credits rather than matching ids — so the duplicate would spend
 * some other utterance's credit and let the agent act over live audio.
 */
type Role = 'host' | 'agent' | 'viewer' | 'companion';
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
  viewers: Set<RelayClient>;
  /** The paired phone acting as this session's mic and speaker, if any. */
  companion: RelayClient | null;
  /**
   * When the phone last proved its PAGE is alive, not just its socket.
   *
   * An open socket says almost nothing about a phone: `readyState` stays 1 for
   * minutes after one goes into a pocket, and a browser answers protocol pings
   * from its network stack rather than from page JavaScript — so a locked
   * handset keeps ponging while its timers and its microphone are frozen. Only
   * a frame the page itself sent proves the page is running.
   */
  companionLastSeenAtMs: number | null;
  /** How many phones have attached, so a swap is visible under a flat "attached". */
  companionAttachCount: number;
  /**
   * When the phone slot last emptied.
   *
   * Kept server-side so a watching screen needs no history of its own: it can
   * be a page that just loaded, or one whose socket reconnected a moment ago,
   * and it still gets a truthful "gone for 40s" rather than starting its own
   * clock from zero.
   */
  companionDetachedAtMs: number | null;
  /**
   * The last `agent.memory` seen on this session.
   *
   * The agent emits it only when the content changes (deduped at the source), so
   * a viewer that pairs mid-session would otherwise sit on an empty panel until
   * the visitor's next preference. Replayed on join.
   */
  lastMemory: RelayEnvelope | null;
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
  // The language the visitor is conversing in. Host-owned: the agent is told,
  // it does not choose.
  'conversation.language',
  'tts.playback.complete',
  /*
    The visitor reaching into preference memory by hand.

    Host-only, and deliberately absent from every other set. A viewer socket is
    refused on any outbound frame at all, and the companion lane terminates at
    the host, so the second screen and the paired phone stay read-only by
    structure rather than by a check somewhere — which matters, because the
    companion token comes from a QR code photographed off a table at a
    reception. The `memory.` prefix keeps these disjoint from the `agent.`,
    `companion.`, `session.`, `tool.`, `snapshot.` and `state.` families, so no
    existing envelope changes meaning.
  */
  'memory.preference.delete',
  'memory.preference.clear',
  'memory.preference.restore',
  'memory.profile.load',
]);

/**
 * The companion lane. Disjoint from the two sets above by the `companion.`
 * prefix, so no existing envelope changes meaning and no companion frame can be
 * tested against an agent-facing allow-list.
 *
 * `companion.playback.complete` is deliberately NOT named `tts.playback.complete`:
 * that string is a HOST_TO_AGENT type, and reusing it would let a phone's frame
 * be routed straight to the agent by `relayToAgents`.
 */
const HOST_TO_COMPANION_TYPES = new Set(['companion.speak', 'companion.config']);

const COMPANION_TO_HOST_TYPES = new Set([
  // Sent by the phone on every successful join. Config delivery is pull-based
  // because of what edge-triggered delivery does under newest-wins eviction:
  // phone B joins and takes the slot, then phone A's close fires and finds the
  // slot already reassigned, so `companionActive` never leaves true — no edge,
  // no re-push, and B sits forever with no language and no prompt while the
  // host happily forwards utterances into it.
  'companion.hello',
  // The visitor taking voice onto the phone, or handing it back. It travels
  // phone -> host because the host owns `voiceOutputTarget`; the phone asks, the
  // kiosk decides and then tells the phone what it decided via companion.config.
  'companion.claim',
  'companion.transcript',
  'companion.playback.complete',
  /*
    The visitor editing preference memory from the phone they are already
    holding.

    Named `companion.*` and terminating at the host, like everything else in
    this lane — the phone still never addresses the agent, and the write leaves
    from the kiosk. That keeps `relayToAgents` unreachable from a companion
    socket, which is the property the whole lane is built on.

    Not an escalation of what a paired phone can do: it already holds the
    microphone, so it can already create and retract preferences by speaking.
    This is a more direct route to something it could always do, not a new
    power — unlike a VIEWER, which has no voice and stays refused on every
    outbound frame.
  */
  'companion.memory.command',
  /*
    Proof that the phone's PAGE is alive, sent by the page itself every couple
    of seconds. Handled before `relayCompanionToHost` and never forwarded: that
    function answers HOST_UNAVAILABLE whenever the kiosk has not reached the
    booking screen, and the phone reads any non-join error as "stop capturing",
    so routing pings through it would knock a working phone out of capture on a
    timer.
  */
  'companion.ping',
]);

/**
 * What a companion sees of the agent's own traffic. Memory only.
 *
 * `agent.message` must never be added here. The host decides what is spoken —
 * the voice-verbosity gate can silence or shorten an utterance — so a companion
 * that received agent messages directly would speak text the host deliberately
 * chose not to.
 */
const AGENT_TO_COMPANION_TYPES = new Set(['agent.memory']);

/**
 * Keys that must never survive a hop through the relay, in any casing/shape.
 *
 * Widened for the companion lane with the OpenAI Realtime ephemeral credential
 * shapes. No envelope carries one today and none should: the phone mints its own
 * over HTTP and the secret never touches this relay. This is the backstop for
 * that rule, not a working part of it.
 *
 * Anchored on purpose. This scrub runs on every inbound frame — including
 * `relay.join`, whose payload carries `studyToken`, `agentToken`,
 * `viewToken` and `companionToken`. An unanchored or `*secret*`-shaped pattern
 * would strip those and break every join in every condition.
 */
const SECRET_PAYLOAD_KEY_PATTERN =
  /^(x[-_])?(openai[-_]?)?api[-_]?key$|^client[-_]?secret$|^ephemeral[-_]?key$/i;
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
    viewers: new Set<RelayClient>(),
    companion: null,
    companionLastSeenAtMs: null,
    companionAttachCount: 0,
    companionDetachedAtMs: null,
    lastMemory: null,
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
  if (session.companion?.id === client.id) {
    session.companion = null;
    session.companionDetachedAtMs = Date.now();
    // Closes the mint gate the moment the phone goes away, so a spent-but-idle
    // pairing cannot keep buying Realtime credentials from a pocket.
    setCompanionAttached(client.sessionId, false);
  }
  session.agents.delete(client);
  session.viewers.delete(client);

  // Viewers deliberately do not keep a session alive: a phone left on a shelf
  // must not hold a demo slot open. When the session goes, so do they — with a
  // notice, so the mirror can say what happened instead of just going quiet.
  // The trigger stays `!host && no agents` on purpose: a companion, like a
  // viewer, must not be able to hold a demo slot or an agent child process open
  // from someone's pocket.
  if (!session.host && session.agents.size === 0) {
    for (const viewer of session.viewers) {
      sendError(viewer.socket, 'SESSION_NOT_ACTIVE', 'The session this screen was mirroring has ended.');
      viewer.socket.close(1000);
    }
    if (session.companion) {
      sendError(session.companion.socket, 'SESSION_NOT_ACTIVE', 'The session this phone was paired with has ended.');
      session.companion.socket.close(1000);
      session.companion = null;
      session.companionDetachedAtMs = Date.now();
      // Same reason as the branch above, and it was missing here: the phone's
      // own close handler cannot do it, because `sessions.delete` below makes
      // that handler early-return on a session it can no longer find. Without
      // this the pairing stays `attached` for a phone the relay just hung up
      // on, and an attached pairing is what buys Realtime credentials.
      setCompanionAttached(client.sessionId, false);
    }
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

  // Spread conditionally, never `companionActive: false`. This payload is also
  // written to the study relay log under AGENT_RELAY_LOG_ENABLED, and an
  // always-present key would change every C1-C4 log line for a booth feature
  // those conditions do not have. Consumers test `=== true`, so absent is false.
  const companionActive = Boolean(session.companion && isSocketOpen(session.companion.socket));

  return {
    sessionId,
    hostActive,
    agentCount: agents.length,
    agents,
    ...(companionActive ? { companionActive: true } : {}),
  };
}

/*
  Who is attached, for the two screens a presenter actually looks at.

  A SEPARATE envelope from `relay.presence`, and that separation is the design
  rather than tidiness. `notifySessionPresence` hands the very same object to the
  wire and to `appendSessionLog`, with no projection between them, and every
  logged line advances `session.eventIndex` — so adding a field there would
  rewrite the shape AND the numbering of every C1-C4 session log for a
  booth-only feature. A second builder that is never logged makes that
  invariant structural instead of remembered.

  Durations, never timestamps: the receiver is a kiosk or a phone whose clock
  this server has no reason to trust, and "last seen 4s ago" survives a skewed
  clock where an absolute time would announce a disconnect that never happened.

  No `sessionId` key. This reaches viewers, and that string is deliberately
  withheld from every non-host role at the join reply.
*/
function buildDeviceRosterPayload(sessionId: string, nowMs: number): Record<string, unknown> {
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      kioskActive: false,
      agentCount: 0,
      agents: [],
      viewerCount: 0,
      companionAttachCount: 0,
      companionMissingForMs: null,
      companion: null,
    };
  }

  const agents = Array.from(session.agents)
    .filter((agent) => isSocketOpen(agent.socket))
    .map((agent) => ({ id: agent.id, name: agent.clientName ?? defaultAgentName(agent.id) }));

  const companionOpen = Boolean(session.companion && isSocketOpen(session.companion.socket));

  return {
    kioskActive: Boolean(session.host && isSocketOpen(session.host.socket)),
    agentCount: agents.length,
    agents,
    viewerCount: Array.from(session.viewers).filter((viewer) => isSocketOpen(viewer.socket)).length,
    // Outside `companion` on purpose: both survive the slot emptying, which is
    // exactly when a watching screen needs them to tell "never scanned" from
    // "was here and left".
    companionAttachCount: session.companionAttachCount,
    companionMissingForMs:
      companionOpen || session.companionDetachedAtMs === null
        ? null
        : Math.max(0, nowMs - session.companionDetachedAtMs),
    companion: companionOpen
      ? {
          lastSeenAgoMs:
            session.companionLastSeenAtMs === null
              ? null
              : Math.max(0, nowMs - session.companionLastSeenAtMs),
        }
      : null,
  };
}

/**
 * Demo-only, and never logged. Both are enforced on the first two lines rather
 * than at the call sites, so a future caller cannot leak this into a study
 * session by forgetting a guard.
 */
function notifySessionDevices(sessionId: string): void {
  if (!isDemoRelaySession(sessionId)) return;
  const session = sessions.get(sessionId);
  if (!session) return;

  const payload = buildDeviceRosterPayload(sessionId, Date.now());
  if (session.host) sendEnvelope(session.host.socket, { type: 'relay.devices', payload });
  for (const viewer of session.viewers) {
    sendEnvelope(viewer.socket, { type: 'relay.devices', payload });
  }
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

  fanOutFromAgent(sessionId, message);

  if (!host || !isSocketOpen(host.socket)) {
    sendError(client.socket, 'SESSION_NOT_ACTIVE', 'No active host connection for this session.', message.id);
    return;
  }

  sendEnvelope(host.socket, message);
  appendSessionLog(sessionId, 'out', message.type, message.payload ?? {});
}

/**
 * Memory is the one thing a paired second device sees. Everything else on this
 * relay — tool calls, snapshots, the conversation — stays between the agent and
 * the host.
 *
 * That guarantee is now per-audience rather than global, so the two deliveries
 * are guarded independently. Both audiences happen to be memory-only today; the
 * split exists so widening one can never silently widen the other.
 */
function fanOutFromAgent(sessionId: string, message: RelayEnvelope): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (message.type === 'agent.memory') {
    session.lastMemory = message;
  }

  if (message.type === 'agent.memory') {
    for (const viewer of session.viewers) {
      if (isSocketOpen(viewer.socket)) sendEnvelope(viewer.socket, message);
    }
  }

  if (
    session.companion &&
    isSocketOpen(session.companion.socket) &&
    AGENT_TO_COMPANION_TYPES.has(message.type)
  ) {
    sendEnvelope(session.companion.socket, message);
  }
}

/**
 * Phone -> kiosk. The companion never addresses the agent: the host applies the
 * short-utterance filter, the replay-suppression rule and every log line, and
 * the host alone emits `tts.playback.complete`.
 *
 * An absent host IS reported back, unlike the other direction: a phone whose
 * kiosk is gone must know to stop capturing rather than talk into a void.
 */
function relayCompanionToHost(client: RelayClient, message: RelayEnvelope): void {
  const sessionId = client.sessionId;
  if (!sessionId) return;

  const session = getOrCreateSession(sessionId);
  appendSessionLog(sessionId, 'in', message.type, message.payload ?? {});

  const host = session.host;
  if (!host || !isSocketOpen(host.socket)) {
    // A distinct code from the join refusal. The phone must treat this as
    // transient — the kiosk reconnects on a 1200ms timer — and not as "your
    // pairing is dead", which would strand it for the rest of the session.
    sendError(client.socket, 'HOST_UNAVAILABLE', 'No active host connection for this session.', message.id);
    return;
  }

  sendEnvelope(host.socket, message);
  appendSessionLog(sessionId, 'out', message.type, message.payload ?? {});
}

/**
 * Kiosk -> phone. Dropped silently when no phone is attached: the host may push
 * config the instant a companion detaches, and surfacing that as a relay error
 * would put a spurious failure in front of the person booking a ticket.
 */
function relayHostToCompanion(client: RelayClient, message: RelayEnvelope): void {
  const sessionId = client.sessionId;
  if (!sessionId) return;

  const session = getOrCreateSession(sessionId);
  appendSessionLog(sessionId, 'in', message.type, message.payload ?? {});

  const companion = session.companion;
  if (!companion || !isSocketOpen(companion.socket)) return;

  sendEnvelope(companion.socket, message);
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
        message: 'Send relay.join with role=host|agent|viewer',
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

        if (role !== 'host' && role !== 'agent' && role !== 'viewer' && role !== 'companion') {
          sendError(client.socket, 'INVALID_MESSAGE', 'relay.join payload.role must be "host", "agent", "viewer" or "companion".', message.id);
          return;
        }

        if (role === 'viewer') {
          // A viewer names its session only through a signed read-only token. It
          // cannot pass a raw sessionId, or any device could watch any session
          // by guessing one.
          const viewToken =
            typeof payload.viewToken === 'string' ? payload.viewToken.trim() : '';
          if (!viewToken) {
            sendError(
              client.socket,
              'SESSION_NOT_ACTIVE',
              'relay.join for viewer requires payload.viewToken.',
              message.id
            );
            return;
          }
          const resolved = getRelaySessionIdByViewToken(viewToken);
          if (!resolved) {
            sendError(
              client.socket,
              'SESSION_NOT_ACTIVE',
              'Study session is invalid, finished, or expired.',
              message.id
            );
            return;
          }
          sessionId = resolved;
        }

        if (role === 'companion') {
          // Like a viewer, a companion names its session only through a signed
          // token, never a raw id. Unlike a viewer it can send, so the token is
          // its own scope with its own revocation handle.
          const companionToken =
            typeof payload.companionToken === 'string' ? payload.companionToken.trim() : '';
          if (!companionToken) {
            sendError(
              client.socket,
              'SESSION_NOT_ACTIVE',
              'relay.join for companion requires payload.companionToken.',
              message.id
            );
            return;
          }
          const resolved = getRelaySessionIdByCompanionToken(companionToken);
          if (!resolved) {
            sendError(
              client.socket,
              'COMPANION_PAIRING_INVALID',
              'This pairing is no longer valid. Scan the code again.',
              message.id
            );
            return;
          }
          sessionId = resolved;
        }

        if (role === 'agent') {
          // The agent role can drive the booking GUI (`tool.call`), speak
          // through the kiosk (`agent.message`) and end the session, and it used
          // to need nothing but a relay session id that `relay.joined` handed to
          // every joiner. It now names its session the way host and viewer
          // already do: through a signed, session-scoped token.
          const agentToken =
            typeof payload.agentToken === 'string' ? payload.agentToken.trim() : '';
          if (!agentToken) {
            sendError(
              client.socket,
              'SESSION_NOT_ACTIVE',
              'relay.join for agent requires payload.agentToken.',
              message.id
            );
            return;
          }
          const resolved = getRelaySessionIdByAgentToken(agentToken);
          if (!resolved) {
            sendError(
              client.socket,
              'SESSION_NOT_ACTIVE',
              'Study session is invalid, finished, or expired.',
              message.id
            );
            return;
          }
          sessionId = resolved;
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
          notifySessionDevices(previousSessionId);
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
        } else if (role === 'companion') {
          // Newest wins, like the host slot — a phone that dropped off wifi
          // leaves a half-open socket the server has not noticed yet, and
          // re-scanning must not be refused because of it. The incumbent is told
          // why rather than being closed silently.
          if (session.companion && session.companion.id !== client.id) {
            sendError(
              session.companion.socket,
              'SESSION_NOT_ACTIVE',
              'Companion connection replaced by a newer companion.'
            );
            session.companion.socket.close(1000);
          }
          session.companion = client;
          // Being attached right now is what earns the right to mint a Realtime
          // credential against this session's OpenAI key. A token that was
          // photographed but never paired can mint nothing.
          setCompanionAttached(sessionId, true);
          session.companionAttachCount += 1;
          session.companionDetachedAtMs = null;
          // Attaching is itself proof of life; without this the first roster
          // would report a null lastSeen and read as an already-silent phone.
          session.companionLastSeenAtMs = Date.now();
        } else if (role === 'viewer') {
          // Unbounded on purpose: viewers are read-only and cheap, and a booth
          // may well want the presenter's phone and a wall display at once.
          session.viewers.add(client);
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
            // Only the host is told the relay session id. It was previously
            // echoed to every role, which made a read-only view token enough to
            // learn the id and then rejoin as an agent on a second socket. The
            // agent does not need it back (it is spawned knowing its session)
            // and a viewer never did.
            ...(role === 'host' ? { sessionId } : {}),
            ...(role === 'agent' ? { clientName: client.clientName } : {}),
          },
        });
        if ((role === 'viewer' || role === 'companion') && session.lastMemory) {
          sendEnvelope(client.socket, session.lastMemory);
        }
        notifySessionPresence(sessionId);
        notifySessionDevices(sessionId);
        return;
      }

      if (!client.role || !client.sessionId) {
        sendError(client.socket, 'SESSION_NOT_ACTIVE', 'You must send relay.join before other messages.', message.id);
        return;
      }

      if (client.role === 'viewer') {
        sendError(
          client.socket,
          'INVALID_MESSAGE',
          'A viewer connection is read-only.',
          message.id
        );
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

      if (client.role === 'companion') {
        if (!COMPANION_TO_HOST_TYPES.has(message.type)) {
          sendError(client.socket, 'INVALID_MESSAGE', `Unsupported message type for companion role: ${message.type}`, message.id);
          return;
        }
        if (message.type === 'companion.ping') {
          // Terminates here. Never forwarded, never answered with an error, and
          // never logged — a heartbeat that reported a missing host would be
          // worse than no heartbeat at all.
          const session = client.sessionId ? sessions.get(client.sessionId) : null;
          if (session && session.companion?.id === client.id) {
            session.companionLastSeenAtMs = Date.now();
            notifySessionDevices(client.sessionId as string);
          }
          return;
        }
        relayCompanionToHost(client, message);
        return;
      }

      if (client.role === 'host') {
        // Tested FIRST inside the host arm. If the agent allow-list ran first a
        // companion-bound frame would fall to its error path, and if the sets
        // ever overlapped it would be delivered to the agent instead.
        if (HOST_TO_COMPANION_TYPES.has(message.type)) {
          relayHostToCompanion(client, message);
          return;
        }
        if (!HOST_TO_AGENT_TYPES.has(message.type)) {
          sendError(client.socket, 'INVALID_MESSAGE', `Unsupported message type for host role: ${message.type}`, message.id);
          return;
        }
        relayToAgents(client, message);
        return;
      }

      // Unreachable: `client.role` is one of the literals validated at join.
      // Spelled out anyway, because the host used to be reached by elimination —
      // whatever was neither agent nor viewer fell through to the host's
      // allow-list and was forwarded to the agent. Adding a fourth role to a
      // ladder shaped like that is exactly how a companion frame would end up
      // delivered to the agent.
      sendError(
        client.socket,
        'INVALID_MESSAGE',
        `Unsupported role: ${client.role}`,
        message.id
      );
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
      // Literals, not `!== 'viewer'`. Simplifying would start emitting a
      // presence envelope — and, under AGENT_RELAY_LOG_ENABLED, an extra log
      // line — on every memory-mirror disconnect.
      if (
        previousSessionId &&
        (previousRole === 'host' || previousRole === 'agent' || previousRole === 'companion')
      ) {
        notifySessionPresence(previousSessionId);
      }
      // Every role, unlike presence above: a viewer leaving changes the roster's
      // own count, and this envelope is demo-only and never logged, so the
      // reason that guard exists does not apply to it.
      if (previousSessionId) notifySessionDevices(previousSessionId);
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
