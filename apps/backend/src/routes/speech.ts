import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  consumeCompanionApiKey,
  getSessionApiKeyByToken,
  getSessionContextByToken,
} from '../study/sessionService';
import { isDemoStudyMode } from '../study/modes';

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const OPENAI_REALTIME_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
// Still used by /speech/synthesize-preview (the pre-session speaker check) and,
// via OPENAI_TTS_SPEED, by the agent's text-mode reading-delay estimate.
const DEFAULT_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const DEFAULT_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const DEFAULT_TTS_FORMAT = process.env.OPENAI_TTS_FORMAT || 'wav';
const DEFAULT_TTS_SPEED = (() => {
  const parsed = Number.parseFloat(process.env.OPENAI_TTS_SPEED || '1.5');
  if (!Number.isFinite(parsed)) return 1.5;
  return Math.min(4, Math.max(0.25, parsed));
})();

function readEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(process.env[name] || '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// The mini tier is the right default here precisely because this model never
// decides anything: create_response is forced off below, so its whole job is
// speaking the agent's text back and yielding on barge-in. Full gpt-realtime-2.1
// costs 3.2x per audio token for that. Set OPENAI_REALTIME_MODEL to move back.
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini';
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'alloy';
// This model never decides anything -- it repeats the agent's sentence and
// yields on barge-in -- so the lowest rung is the right one. OpenAI's own
// guidance reserves `minimal` for "lowest latency matters most and the task is
// simple", which is exactly this. Interruption is unaffected: barge-in is
// server VAD, not a model judgement. Field shape is `session.reasoning.effort`;
// a top-level `reasoning_effort` is rejected.
const REALTIME_REASONING_EFFORT =
  process.env.OPENAI_REALTIME_REASONING_EFFORT || 'minimal';
const REALTIME_STT_MODEL = process.env.OPENAI_REALTIME_STT_MODEL || 'gpt-4o-mini-transcribe';
// Realtime's speed range is narrower than /audio/speech's 0.25-4, so clamp to 1.5.
//
// Defaults to 1.0 — a natural speaking rate. The 1.5 the study used was a
// deliberate choice for a timed lab task, and it sounds rushed in a live demo.
// It also deliberately does NOT fall back to OPENAI_TTS_SPEED any more: that
// constant still drives the agent's text-mode reading delay, and letting one
// knob set both the voice rate and the text pacing is what coupled the text
// conditions to a voice-only parameter in the first place.
const REALTIME_SPEED = (() => {
  const raw = process.env.OPENAI_REALTIME_SPEED || '1.0';
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return 1.0;
  return Math.min(1.5, Math.max(0.25, parsed));
})();
/**
 * Server-side noise reduction on the input stream.
 *
 * `near_field` suits a headset or earbuds held close to the mouth — AirPods,
 * a laptop mic at arm's length — and is the right default for a booth where
 * the room is loud but the speaker is close. `far_field` is for a room mic on
 * a table. `off` disables it.
 */
const REALTIME_NOISE_REDUCTION = (() => {
  const raw = (process.env.OPENAI_REALTIME_NOISE_REDUCTION || 'near_field').trim();
  if (raw === 'off' || raw === 'none' || raw === 'null') return null;
  return raw === 'far_field' ? 'far_field' : 'near_field';
})();
const REALTIME_VAD_THRESHOLD = readEnvNumber('OPENAI_REALTIME_VAD_THRESHOLD', 0.5, 0, 1);
const REALTIME_VAD_SILENCE_MS = readEnvNumber('OPENAI_REALTIME_VAD_SILENCE_MS', 900, 100, 5000);
const REALTIME_VAD_PREFIX_MS = readEnvNumber('OPENAI_REALTIME_VAD_PREFIX_MS', 300, 0, 2000);
const REALTIME_TOKEN_TTL_SECONDS = readEnvNumber('REALTIME_TOKEN_TTL_SECONDS', 600, 60, 3600);

// The realtime model is a voice I/O layer, not the assistant: the tuning agent
// composes every utterance and drives every GUI action. The session is minted
// with turn_detection.create_response=false so the model can never answer on its
// own; it only speaks text handed to it via response.create.
/**
 * The realtime model is an output device here, not a speaker with opinions, so
 * the instruction is the same in both languages apart from what "verbatim"
 * means: the planner already wrote the message in the session's language, and
 * the one thing that must not happen is this layer deciding to translate it
 * either way.
 */
const REALTIME_VOICE_INSTRUCTIONS: Record<SessionLanguage, string> = {
  en: [
    'You are the voice channel of a movie-booking assistant. You never decide what to say.',
    'You only speak when you are explicitly given a message to repeat, and then you repeat it',
    'verbatim in English: no additions, no omissions, no rephrasing, no translation.',
    'Preserve labels such as seat ids ("C1"), times ("7:30 PM"), and prices exactly as written.',
    'If you are not given a message to repeat, stay silent.',
  ].join(' '),
  ko: [
    'You are the voice channel of a movie-booking assistant. You never decide what to say.',
    'You only speak when you are explicitly given a message to repeat, and then you repeat it',
    'verbatim: no additions, no omissions, no rephrasing, no translation.',
    'The message is written in Korean and may contain English film titles, cinema names,',
    'formats and seat ids. Read the Korean as Korean and read those labels as they are written,',
    'in English. Preserve seat ids ("C1"), times ("7:30 PM") and prices exactly as written.',
    'If you are not given a message to repeat, stay silent.',
  ].join(' '),
};

type SessionLanguage = 'en' | 'ko';

function parseSessionLanguage(value: unknown): SessionLanguage {
  return value === 'ko' ? 'ko' : 'en';
}

const STUDY_SESSION_TOKEN_HEADER = 'x-study-session-token';
/** The paired phone's credential. Deliberately a different header name so a
 *  companion token can never be mistaken for a study token by a handler. */
const COMPANION_SESSION_TOKEN_HEADER = 'x-companion-session-token';
const INLINE_API_KEY_HEADER = 'x-openai-api-key';
// /speech/synthesize-preview is unauthenticated; keep its payload tiny.
const PREVIEW_BODY_LIMIT_BYTES = 8 * 1024;
const PREVIEW_MAX_TEXT_LENGTH = 600;
// Opt-in escape hatch for a private lab deployment where the operator key is the
// only key and participants never type one: it lets the pre-session speaker test
// run on OPENAI_API_KEY. Must stay false on any public demo deployment -- the
// route is unauthenticated, so enabling it makes the operator key spendable by
// anyone who can reach the server.
const PREVIEW_ALLOWS_ENV_KEY = process.env.SPEECH_PREVIEW_ALLOW_ENV_KEY?.trim() === 'true';

function getEnvOpenAiApiKey(): string | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  return apiKey ? apiKey : null;
}

function readHeader(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string' && raw[0].trim()) {
    return raw[0].trim();
  }
  return null;
}

/**
 * Resolves a user-provided OpenAI key for this request: first the key bound to
 * the study session (public demo visitors register it at session creation), then
 * an inline `x-openai-api-key` header. Never logged, never echoed.
 */
function resolveUserApiKey(request: FastifyRequest): string | null {
  const studyToken = readHeader(request, STUDY_SESSION_TOKEN_HEADER);
  if (studyToken) {
    const sessionKey = getSessionApiKeyByToken(studyToken);
    if (sessionKey && sessionKey.trim()) return sessionKey.trim();
  }
  return readHeader(request, INLINE_API_KEY_HEADER);
}

/**
 * True when this request belongs to a public demo session. Demo visitors bring
 * their own key by contract, so the operator key must never back their calls.
 */
function isDemoSessionRequest(request: FastifyRequest): boolean {
  const studyToken = readHeader(request, STUDY_SESSION_TOKEN_HEADER);
  if (!studyToken) return false;
  const context = getSessionContextByToken(studyToken);
  return context ? isDemoStudyMode(context.record.studyMode) : false;
}

/**
 * Resolve the key backing this request.
 *
 * The env fallback is gated because `POST /study/sessions` is unauthenticated
 * and only *demo* sessions require a key: anyone could create a session in a
 * non-demo studyMode and reach the speech routes with no credential of their
 * own. That was harmless while the operator key was kept out of the container
 * entirely, but the conference access-code flow puts `OPENAI_API_KEY` in the
 * backend environment, which turns that gap into a drain path.
 *
 * So the fallback is now opt-in and defaults off. A private lab deployment,
 * where every session is created by the researcher, sets
 * `ALLOW_OPERATOR_KEY_FALLBACK=true`. A public deployment leaves it unset, and
 * every session must carry a key it earned — the visitor's own, or the operator
 * key attached server-side by a redeemed access code.
 */
const ALLOW_OPERATOR_KEY_FALLBACK =
  process.env.ALLOW_OPERATOR_KEY_FALLBACK?.trim() === 'true';

function resolveApiKeyWithEnvFallback(request: FastifyRequest): string | null {
  const userApiKey = resolveUserApiKey(request);
  if (userApiKey) return userApiKey;
  if (isDemoSessionRequest(request)) return null;
  if (!ALLOW_OPERATOR_KEY_FALLBACK) return null;
  return getEnvOpenAiApiKey();
}

function isOpenAiAuthFailure(response: Response): boolean {
  return response.status === 401 || response.status === 403;
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function contentTypeFromFormat(format: string): string {
  switch (format.toLowerCase()) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/opus';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'pcm':
      return 'audio/pcm';
    default:
      return 'application/octet-stream';
  }
}

// OpenAI echoes the offending key back in some error bodies; never relay that.
function redactApiKeys(message: string): string {
  return message.replace(/sk-[A-Za-z0-9_-]{4,}/g, 'sk-***');
}

async function readOpenAiError(response: Response): Promise<string> {
  const fallback = `OpenAI request failed with HTTP ${response.status}`;
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: unknown } }
      | null;
    const message = payload?.error?.message;
    return typeof message === 'string' && message.trim()
      ? redactApiKeys(message.trim())
      : fallback;
  }

  const text = await response.text().catch(() => '');
  return text.trim() ? redactApiKeys(text.trim()) : fallback;
}

async function synthesizeSpeechWithOpenAi(text: string, apiKey: string): Promise<Response> {
  return fetch(OPENAI_SPEECH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_TTS_MODEL,
      voice: DEFAULT_TTS_VOICE,
      input: text,
      response_format: DEFAULT_TTS_FORMAT,
      speed: DEFAULT_TTS_SPEED,
    }),
  });
}

export async function speechRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Mints a short-lived OpenAI Realtime client secret so the browser can open a
   * WebRTC session directly. The caller's real key never leaves this process.
   *
   * The session config is server-authoritative: baking turn_detection here is
   * what keeps the realtime model a voice I/O layer rather than a second brain.
   * The transcription prompt is deliberately left unset -- the frontend sends it
   * per screen via session.update, since only it knows the active UI spec.
   */
  fastify.post('/speech/realtime-session', async (request, reply) => {
    const apiKey = resolveApiKeyWithEnvFallback(request);
    if (!apiKey) {
      return reply.code(503).send({ error: 'OPENAI_API_KEY_MISSING' });
    }

    const language = parseSessionLanguage((request.body as { language?: unknown } | null)?.language);
    const minted = await mintRealtimeClientSecret(apiKey, language);
    if (!minted.ok) {
      return reply.code(minted.status).send({ error: minted.error, message: minted.message });
    }

    reply.header('cache-control', 'no-store');
    return minted.body;
  });

  /**
   * The paired phone's own Realtime credential.
   *
   * Separate from the route above because it authenticates on a companion token
   * rather than a study token, and because what bounds it is different. The
   * session-bound key at a conference booth IS the operator key — the
   * access-code flow copies `OPENAI_API_KEY` into the session — so "this handler
   * never calls getEnvOpenAiApiKey" would be a hollow guarantee. What actually
   * bounds it is `consumeCompanionApiKey`: the pairing must be current, a phone
   * must have actually attached to the relay to earn an allowance, and each mint
   * spends one. Someone who photographed the QR but never paired gets nothing,
   * and someone who does pair evicts the visitor's phone visibly.
   *
   * Served under /study/ rather than /speech/ deliberately: /speech is a
   * studyContext PROTECTED_PREFIX and would demand a study token, which is
   * exactly the credential a companion must not have.
   */
  fastify.post('/study/companion/realtime-session', async (request, reply) => {
    const companionToken = readHeader(request, COMPANION_SESSION_TOKEN_HEADER);
    if (!companionToken) {
      return reply.code(401).send({ error: 'COMPANION_TOKEN_MISSING' });
    }

    const apiKey = consumeCompanionApiKey(companionToken);
    if (!apiKey) {
      // One code for every refusal: an invalid pairing, a spent allowance and a
      // phone that never attached must not be distinguishable from outside.
      return reply.code(403).send({ error: 'COMPANION_NOT_PAIRED' });
    }

    const language = parseSessionLanguage((request.body as { language?: unknown } | null)?.language);
    const minted = await mintRealtimeClientSecret(apiKey, language);
    if (!minted.ok) {
      return reply.code(minted.status).send({ error: minted.error, message: minted.message });
    }

    reply.header('cache-control', 'no-store');
    return minted.body;
  });

  // Unauthenticated public path: it runs on a caller-supplied key only. Falling
  // back to process.env.OPENAI_API_KEY here would let any anonymous visitor
  // drain the operator's key, so that fallback exists only behind the explicit
  // SPEECH_PREVIEW_ALLOW_ENV_KEY opt-in for private lab deployments.
  fastify.post(
    '/speech/synthesize-preview',
    { bodyLimit: PREVIEW_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const apiKey =
        resolveUserApiKey(request) ?? (PREVIEW_ALLOWS_ENV_KEY ? getEnvOpenAiApiKey() : null);
      if (!apiKey) {
        return reply.code(503).send({ error: 'OPENAI_API_KEY_MISSING' });
      }

      const body = (request.body ?? {}) as {
        text?: unknown;
      };
      const text = trimToNull(body.text);
      if (!text) {
        return reply.code(400).send({ error: 'text is required' });
      }
      if (text.length > PREVIEW_MAX_TEXT_LENGTH) {
        return reply
          .code(400)
          .send({ error: `text must be ${PREVIEW_MAX_TEXT_LENGTH} characters or fewer` });
      }

      const response = await synthesizeSpeechWithOpenAi(text, apiKey);

      if (!response.ok) {
        const message = await readOpenAiError(response);
        if (isOpenAiAuthFailure(response)) {
          return reply.code(401).send({
            error: 'OPENAI_AUTH_FAILED',
            message,
          });
        }
        return reply.code(502).send({
          error: 'OPENAI_TTS_FAILED',
          message,
        });
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      reply.header('content-type', contentTypeFromFormat(DEFAULT_TTS_FORMAT));
      reply.header('cache-control', 'no-store');
      return reply.send(audioBuffer);
    }
  );
}


interface RealtimeMintSuccess {
  ok: true;
  body: {
    clientSecret: string;
    expiresAt: number | null;
    model: string;
    transcriptionModel: string;
    language: SessionLanguage;
  };
}

interface RealtimeMintFailure {
  ok: false;
  status: number;
  error: string;
  message: string;
}

/**
 * The one place a Realtime session is configured, shared by the kiosk route and
 * the companion route so the two can never drift apart on VAD, voice, speed or
 * the create_response:false rule that keeps the model an output device.
 *
 * The 401/502 split is preserved rather than collapsed into one failure: a bad
 * key is a thing the operator can fix and the frontend surfaces it differently
 * from an OpenAI outage.
 */
async function mintRealtimeClientSecret(
  apiKey: string,
  language: SessionLanguage
): Promise<RealtimeMintSuccess | RealtimeMintFailure> {
    const response = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: REALTIME_TOKEN_TTL_SECONDS },
        session: {
          type: 'realtime',
          model: REALTIME_MODEL,
          instructions: REALTIME_VOICE_INSTRUCTIONS[language],
          reasoning: { effort: REALTIME_REASONING_EFFORT },
          output_modalities: ['audio'],
          audio: {
            input: {
              transcription: { model: REALTIME_STT_MODEL, language },
              // Suppresses room noise before VAD and transcription see the
              // stream, so a loud booth does not keep opening turns the user
              // never started.
              ...(REALTIME_NOISE_REDUCTION
                ? { noise_reduction: { type: REALTIME_NOISE_REDUCTION } }
                : {}),
              turn_detection: {
                type: 'server_vad',
                threshold: REALTIME_VAD_THRESHOLD,
                prefix_padding_ms: REALTIME_VAD_PREFIX_MS,
                silence_duration_ms: REALTIME_VAD_SILENCE_MS,
                // The tuning agent composes every reply, so the model must never
                // answer on its own; it may still cut its own speech short when
                // the user starts talking, which is what makes barge-in work.
                create_response: false,
                interrupt_response: true,
              },
            },
            output: { voice: REALTIME_VOICE, speed: REALTIME_SPEED },
          },
        },
      }),
    });

    if (!response.ok) {
      const message = await readOpenAiError(response);
      if (isOpenAiAuthFailure(response)) {
        return { ok: false, status: 401, error: 'OPENAI_AUTH_FAILED', message };
      }
      return { ok: false, status: 502, error: 'OPENAI_REALTIME_SESSION_FAILED', message };
    }

    const payload = (await response.json().catch(() => null)) as
      | { value?: unknown; expires_at?: unknown }
      | null;
    const clientSecret = trimToNull(payload?.value);
    if (!clientSecret) {
      return {
        ok: false,
        status: 502,
        error: 'OPENAI_REALTIME_SESSION_FAILED',
        message: 'OpenAI returned no client secret.',
      };
    }

    return {
      ok: true,
      body: {
        clientSecret,
        expiresAt: typeof payload?.expires_at === 'number' ? payload.expires_at : null,
        model: REALTIME_MODEL,
        // The frontend re-sends the transcription block via session.update to add
        // the on-screen options as a prompt, so it needs the model name we minted
        // with -- a partial block would otherwise drop it.
        transcriptionModel: REALTIME_STT_MODEL,
        language,
      },
    };
}
