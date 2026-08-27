import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getSessionApiKeyByToken, getSessionContextByToken } from '../study/sessionService';
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

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'alloy';
const REALTIME_STT_MODEL = process.env.OPENAI_REALTIME_STT_MODEL || 'gpt-4o-mini-transcribe';
// Realtime's speed range is narrower than /audio/speech's 0.25-4. Clamping to
// 1.5 keeps the study's tuned rate valid under either range.
const REALTIME_SPEED = (() => {
  const raw = process.env.OPENAI_REALTIME_SPEED || process.env.OPENAI_TTS_SPEED || '1.5';
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return 1.5;
  return Math.min(1.5, Math.max(0.25, parsed));
})();
const REALTIME_VAD_THRESHOLD = readEnvNumber('OPENAI_REALTIME_VAD_THRESHOLD', 0.5, 0, 1);
const REALTIME_VAD_SILENCE_MS = readEnvNumber('OPENAI_REALTIME_VAD_SILENCE_MS', 900, 100, 5000);
const REALTIME_VAD_PREFIX_MS = readEnvNumber('OPENAI_REALTIME_VAD_PREFIX_MS', 300, 0, 2000);
const REALTIME_TOKEN_TTL_SECONDS = readEnvNumber('REALTIME_TOKEN_TTL_SECONDS', 600, 60, 3600);

// The realtime model is a voice I/O layer, not the assistant: the tuning agent
// composes every utterance and drives every GUI action. The session is minted
// with turn_detection.create_response=false so the model can never answer on its
// own; it only speaks text handed to it via response.create.
const REALTIME_VOICE_INSTRUCTIONS = [
  'You are the voice channel of a movie-booking assistant. You never decide what to say.',
  'You only speak when you are explicitly given a message to repeat, and then you repeat it',
  'verbatim in English: no additions, no omissions, no rephrasing, no translation.',
  'Preserve labels such as seat ids ("C1"), times ("7:30 PM"), and prices exactly as written.',
  'If you are not given a message to repeat, stay silent.',
].join(' ');

const STUDY_SESSION_TOKEN_HEADER = 'x-study-session-token';
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
 * key attached server-side by a redeemed single-use access code.
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
          instructions: REALTIME_VOICE_INSTRUCTIONS,
          output_modalities: ['audio'],
          audio: {
            input: {
              transcription: { model: REALTIME_STT_MODEL, language: 'en' },
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
        return reply.code(401).send({
          error: 'OPENAI_AUTH_FAILED',
          message,
        });
      }
      return reply.code(502).send({
        error: 'OPENAI_REALTIME_SESSION_FAILED',
        message,
      });
    }

    const payload = (await response.json().catch(() => null)) as
      | { value?: unknown; expires_at?: unknown }
      | null;
    const clientSecret = trimToNull(payload?.value);
    if (!clientSecret) {
      return reply.code(502).send({
        error: 'OPENAI_REALTIME_SESSION_FAILED',
        message: 'OpenAI returned no client secret.',
      });
    }

    reply.header('cache-control', 'no-store');
    return {
      clientSecret,
      expiresAt: typeof payload?.expires_at === 'number' ? payload.expires_at : null,
      model: REALTIME_MODEL,
      // The frontend re-sends the transcription block via session.update to add
      // the on-screen options as a prompt, so it needs the model name we minted
      // with -- a partial block would otherwise drop it.
      transcriptionModel: REALTIME_STT_MODEL,
    };
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
