import type { FastifyInstance } from 'fastify';
import {
  createStudySession,
  finishSessionByToken,
  getSessionContextByToken,
  listScenarios,
  StudySessionCapacityError,
} from '../study/sessionService';
import { allocateStudySessionId } from '../study/sessionService';
import {
  getStudyModeConfig,
  isStudyModeId,
  isDemoStudyMode,
  DEFAULT_STUDY_MODE,
} from '../study/modes';
import {
  DEMO_ACCESS_CODES_ENABLED,
  redeemAccessCode,
} from '../study/demoAccessCodes';
import {
  checkRedemptionAllowed,
  recordRedemptionFailure,
  recordRedemptionSuccess,
} from '../study/redemptionLimiter';
import {
  appendInteractionLog,
  hasInteractionLogging,
  readInteractionLogFile,
  readLlmTraceLogFile,
} from '../study/interactionLogService';
import { appendPerTrialSurveySubmission } from '../study/perTrialSurveyService';
import { appendPostStudySurveySubmission } from '../study/postStudySurveyService';

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const OPENAI_KEY_VALIDATION_TIMEOUT_MS =
  Number.parseInt(process.env.OPENAI_KEY_VALIDATION_TIMEOUT_MS || '', 10) || 5000;

/**
 * Cheap liveness check for a visitor-supplied key. Anonymous demo visitors paste
 * malformed keys constantly, so reject them before a session (and an agent
 * process) is created. The key is never logged and never leaves this function.
 */
async function isOpenAiApiKeyUsable(apiKey: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_KEY_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    // Drain the body so the socket is released back to the pool.
    const bodyText = await response.text().catch(() => '');
    // Only a genuine credential failure is fatal. A restricted project key
    // without the `api.model.read` scope answers 403 `insufficient_permissions`
    // to /v1/models while still being able to call /v1/responses and
    // /v1/audio/speech, which is all this app needs.
    return response.status !== 401 || !/invalid_api_key/i.test(bodyText);
  } catch {
    // Timeout or network failure: fail open so an OpenAI outage cannot block
    // session creation. Downstream speech/agent calls will surface the problem.
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The demo concurrency cap lives in sessionService. Match the typed error, plus
 * a defensive code/message fallback, so an over-capacity demo never surfaces as
 * a generic 400 "bad request".
 */
function isDemoCapacityError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof StudySessionCapacityError) return true;
  const rawCode = (error as { code?: unknown }).code;
  const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : '';
  const message = (error instanceof Error ? error.message : '').toUpperCase();
  const candidate = `${code} ${message}`;
  if (!candidate.includes('DEMO')) return false;
  return /LIMIT|CAPACITY|CONCURRENT|FULL|BUSY|MAX/.test(candidate);
}

function getStudyTokenFromHeader(headers: Record<string, unknown>): string | null {
  const raw = headers['x-study-session-token'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string' && raw[0].trim()) {
    return raw[0].trim();
  }
  return null;
}

export async function studyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/study/scenarios', async () => {
    return {
      scenarios: listScenarios().map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        background: scenario.background ?? '',
        story: scenario.story,
        stepBriefs: scenario.stepBriefs ?? {},
        narratorPreferenceTypes: scenario.narratorPreferenceTypes,
        seatRows: scenario.seatRows ?? [],
      })),
    };
  });

  fastify.post('/study/surveys/per-trial', async (request, reply) => {
    const body = (request.body ?? {}) as {
      participantId?: unknown;
      studyMode?: unknown;
      conditionLabel?: unknown;
      scenarioId?: unknown;
      setLabel?: unknown;
      responses?: unknown;
      submittedAt?: unknown;
    };

    const participantId =
      typeof body.participantId === 'string' ? body.participantId.trim() : '';
    const studyMode = typeof body.studyMode === 'string' ? body.studyMode.trim() : '';
    const conditionLabel =
      typeof body.conditionLabel === 'string' ? body.conditionLabel.trim() : '';
    const scenarioId = typeof body.scenarioId === 'string' ? body.scenarioId.trim() : undefined;
    const setLabel = typeof body.setLabel === 'string' ? body.setLabel.trim() : undefined;
    const submittedAt =
      typeof body.submittedAt === 'string' ? body.submittedAt.trim() : undefined;

    if (!participantId) {
      return reply.code(400).send({ error: 'participantId is required' });
    }
    if (!studyMode || !isStudyModeId(studyMode)) {
      return reply.code(400).send({ error: 'Valid studyMode is required' });
    }
    // 'demo' became a valid StudyModeId, but the public demo records nothing:
    // never let a submission tagged 'demo' reach the survey file on disk.
    if (isDemoStudyMode(studyMode)) {
      return reply.code(403).send({ error: 'SURVEYS_DISABLED_IN_DEMO' });
    }
    if (!conditionLabel) {
      return reply.code(400).send({ error: 'conditionLabel is required' });
    }
    if (!body.responses || typeof body.responses !== 'object' || Array.isArray(body.responses)) {
      return reply.code(400).send({ error: 'responses must be an object' });
    }

    try {
      const saved = appendPerTrialSurveySubmission({
        participantId,
        studyMode,
        conditionLabel,
        scenarioId,
        setLabel,
        responses: body.responses as Record<string, number>,
        submittedAt,
      });

      return {
        ok: true,
        submissionId: saved.submissionId,
        submittedAt: saved.submittedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save survey';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/study/surveys/post-study', async (request, reply) => {
    const body = (request.body ?? {}) as {
      participantId?: unknown;
      studyMode?: unknown;
      rankings?: unknown;
      rankingReason?: unknown;
      responses?: unknown;
      submittedAt?: unknown;
    };

    const participantId =
      typeof body.participantId === 'string' ? body.participantId.trim() : '';
    const studyMode = typeof body.studyMode === 'string' ? body.studyMode.trim() : '';
    const rankingReason =
      typeof body.rankingReason === 'string' ? body.rankingReason.trim() : '';
    const submittedAt =
      typeof body.submittedAt === 'string' ? body.submittedAt.trim() : undefined;

    if (!participantId) {
      return reply.code(400).send({ error: 'participantId is required' });
    }
    // Same guard as the per-trial sibling: a submission tagged 'demo' must never
    // reach the survey file on disk.
    if (isDemoStudyMode(studyMode)) {
      return reply.code(403).send({ error: 'SURVEYS_DISABLED_IN_DEMO' });
    }
    if (!body.rankings || typeof body.rankings !== 'object' || Array.isArray(body.rankings)) {
      return reply.code(400).send({ error: 'rankings must be an object' });
    }
    if (!rankingReason) {
      return reply.code(400).send({ error: 'rankingReason is required' });
    }
    if (!body.responses || typeof body.responses !== 'object' || Array.isArray(body.responses)) {
      return reply.code(400).send({ error: 'responses must be an object' });
    }

    try {
      const saved = appendPostStudySurveySubmission({
        participantId,
        rankings: body.rankings as Record<string, number>,
        rankingReason,
        responses: body.responses as Record<string, number>,
        submittedAt,
      });

      return {
        ok: true,
        submissionId: saved.submissionId,
        submittedAt: saved.submittedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save survey';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/study/sessions', async (request, reply) => {
    const body = (request.body ?? {}) as {
      scenarioId?: unknown;
      studyMode?: unknown;
      participantId?: unknown;
      loggingParticipantId?: unknown;
      apiKey?: unknown;
      accessCode?: unknown;
    };
    const scenarioId = typeof body.scenarioId === 'string' ? body.scenarioId.trim() : '';
    const studyModeInput = typeof body.studyMode === 'string' ? body.studyMode.trim() : undefined;
    const participantId =
      typeof body.participantId === 'string' ? body.participantId.trim() : undefined;
    const loggingParticipantId =
      typeof body.loggingParticipantId === 'string'
        ? body.loggingParticipantId.trim()
        : undefined;
    // Visitor-supplied OpenAI key. Held in memory only and never echoed back.
    let apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : undefined;
    const accessCode =
      typeof body.accessCode === 'string' && body.accessCode.trim()
        ? body.accessCode.trim()
        : undefined;

    if (!scenarioId) {
      return reply.code(400).send({ error: 'scenarioId is required' });
    }
    if (studyModeInput && !isStudyModeId(studyModeInput)) {
      return reply.code(400).send({ error: 'Invalid studyMode' });
    }
    const isDemo = isDemoStudyMode(studyModeInput ?? '');
    let presetSessionId: string | undefined;

    // A conference access code is the second way into a demo session: it grants
    // the operator key for exactly one session, server-side, so the visitor
    // never sees it. The code is consumed here and nowhere else.
    let redeemedAccessCode: string | undefined;
    if (accessCode) {
      if (!isDemo) {
        return reply.code(400).send({
          error: 'ACCESS_CODE_NOT_APPLICABLE',
          message: 'Access codes only apply to demo sessions.',
        });
      }
      if (!DEMO_ACCESS_CODES_ENABLED) {
        return reply.code(403).send({
          error: 'ACCESS_CODES_DISABLED',
          message: 'Access codes are not enabled on this deployment.',
        });
      }
      const operatorKey = process.env.OPENAI_API_KEY?.trim();
      if (!operatorKey) {
        return reply.code(503).send({
          error: 'OPERATOR_KEY_UNAVAILABLE',
          message: 'This deployment has no operator key configured.',
        });
      }

      const ip = request.ip;
      const gate = checkRedemptionAllowed(ip);
      if (gate.blocked) {
        const retryAfterSeconds = Math.ceil(gate.retryAfterMs / 1000);
        reply.header('retry-after', String(retryAfterSeconds));
        return reply.code(429).send({
          error: 'ACCESS_CODE_RATE_LIMITED',
          message:
            gate.scope === 'global'
              ? 'Too many failed code attempts right now. Please ask the presenter for help.'
              : 'Too many incorrect codes from this device. Please wait a few minutes.',
          retryAfterSeconds,
        });
      }

      // A session id is needed to bind the redemption, and the redemption must
      // happen before the session is created so a failed code costs nothing.
      // Pre-allocating the id keeps both true.
      const pendingSessionId = allocateStudySessionId();
      const redemption = redeemAccessCode(accessCode, pendingSessionId);
      if (!redemption.ok) {
        recordRedemptionFailure(ip);
        const messages: Record<string, string> = {
          unknown: 'That code is not valid.',
          already_redeemed: 'That code has already been used.',
          expired: 'That code has expired.',
          revoked: 'That code is no longer active.',
        };
        return reply.code(400).send({
          error: 'ACCESS_CODE_INVALID',
          reason: redemption.reason,
          message: messages[redemption.reason] ?? 'That code is not valid.',
        });
      }
      recordRedemptionSuccess(ip);
      redeemedAccessCode = redemption.code;
      presetSessionId = pendingSessionId;
      apiKey = operatorKey;
    }

    // A demo session must run on a key it earned: the visitor's own, or the
    // operator key unlocked by a single-use access code. Without this guard an
    // anonymous caller could create a demo session and spend the operator key
    // through the agent and the speech routes.
    if (isDemo && !apiKey) {
      return reply.code(400).send({
        error: 'OPENAI_API_KEY_MISSING',
        message: 'Demo sessions require your own OpenAI API key or an access code.',
      });
    }
    // The operator key is validated at startup, not per request: re-checking it
    // on every redemption would add a round trip to OpenAI for no new
    // information and would leak redemption timing.
    if (apiKey && !redeemedAccessCode && !(await isOpenAiApiKeyUsable(apiKey))) {
      return reply.code(400).send({
        error: 'INVALID_OPENAI_API_KEY',
        message: 'OpenAI rejected this API key. Check the key and try again.',
      });
    }

    try {
      const created = createStudySession({
        scenarioId,
        studyMode: studyModeInput,
        participantId,
        loggingParticipantId,
        apiKey,
        presetSessionId,
      });
      return {
        sessionId: created.record.sessionId,
        relaySessionId: created.record.relaySessionId,
        participantId: created.record.participantId,
        loggingParticipantId: created.record.loggingParticipantId ?? null,
        interactionLogFile: created.record.interactionLogFile ?? null,
        conditionLabel: created.record.conditionLabel,
        studyToken: created.studyToken,
        expiresAt: created.record.expiresAt,
        studyMode: created.record.studyMode,
        studyModeConfig: created.studyModeConfig,
        scenario: {
          id: created.scenario.id,
          title: created.scenario.title,
          background: created.scenario.background ?? '',
          story: created.scenario.story,
          stepBriefs: created.scenario.stepBriefs ?? {},
          narratorPreferenceTypes: created.scenario.narratorPreferenceTypes,
          seatRows: created.scenario.seatRows ?? [],
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create study session';
      if (isDemoCapacityError(error)) {
        const rawStatus = (error as { statusCode?: unknown }).statusCode;
        const rawCode = (error as { code?: unknown }).code;
        reply.header('retry-after', '60');
        return reply.code(typeof rawStatus === 'number' ? rawStatus : 429).send({
          error: typeof rawCode === 'string' ? rawCode : 'DEMO_SESSION_CAPACITY_REACHED',
          message,
        });
      }
      return reply.code(400).send({ error: message });
    }
  });

  fastify.get('/study/sessions/me', async (request, reply) => {
    const token = getStudyTokenFromHeader(request.headers as Record<string, unknown>);
    if (!token) {
      return reply.code(401).send({ error: 'Missing x-study-session-token header' });
    }
    const context = getSessionContextByToken(token);
    if (!context) {
      return reply.code(401).send({ error: 'Invalid or expired study session' });
    }

    return {
      sessionId: context.record.sessionId,
      relaySessionId: context.record.relaySessionId,
      participantId: context.record.participantId,
      loggingParticipantId: context.record.loggingParticipantId ?? null,
      interactionLogFile: context.record.interactionLogFile ?? null,
      conditionLabel: context.record.conditionLabel,
      scenario: {
        id: context.scenario.id,
        title: context.scenario.title,
        background: context.scenario.background ?? '',
        story: context.scenario.story,
        stepBriefs: context.scenario.stepBriefs ?? {},
        narratorPreferenceTypes: context.scenario.narratorPreferenceTypes,
        seatRows: context.scenario.seatRows ?? [],
      },
      background: context.scenario.background ?? '',
      story: context.scenario.story,
      stepBriefs: context.scenario.stepBriefs ?? {},
      narratorPreferenceTypes: context.scenario.narratorPreferenceTypes,
      studyMode: context.record.studyMode,
      studyModeConfig: getStudyModeConfig(context.record.studyMode ?? DEFAULT_STUDY_MODE),
      expiresAt: context.record.expiresAt,
      status: context.record.status,
    };
  });

  fastify.post('/study/sessions/finish', async (request, reply) => {
    const token = getStudyTokenFromHeader(request.headers as Record<string, unknown>);
    if (!token) {
      return reply.code(401).send({ error: 'Missing x-study-session-token header' });
    }
    const record = finishSessionByToken(token);
    if (!record) {
      return reply.code(401).send({ error: 'Invalid or expired study session' });
    }
    return {
      sessionId: record.sessionId,
      status: record.status,
      finishedAt: record.finishedAt ?? null,
      interactionLogFile: record.interactionLogFile ?? null,
    };
  });

  fastify.post('/study/logs/events', async (request, reply) => {
    const token = getStudyTokenFromHeader(request.headers as Record<string, unknown>);
    if (!token) {
      return reply.code(401).send({ error: 'Missing x-study-session-token header' });
    }

    const context = getSessionContextByToken(token);
    if (!context) {
      return reply.code(401).send({ error: 'Invalid or expired study session' });
    }

    if (!hasInteractionLogging(context.record)) {
      return {
        enabled: false,
        logged: 0,
        interactionLogFile: null,
      };
    }

    const body = (request.body ?? {}) as {
      events?: unknown;
    };
    const rawEvents = body.events;
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
      return reply.code(400).send({ error: 'events must be a non-empty array' });
    }

    let logged = 0;
    for (const rawEvent of rawEvents) {
      if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
        return reply.code(400).send({ error: 'Each event must be an object' });
      }
      const event = rawEvent as {
        type?: unknown;
        payload?: unknown;
        clientTimestamp?: unknown;
      };
      const type = typeof event.type === 'string' ? event.type.trim() : '';
      if (!type) {
        return reply.code(400).send({ error: 'Each event requires a non-empty string type' });
      }

      appendInteractionLog(context.record, {
        type,
        payload: event.payload ?? null,
        clientTimestamp:
          typeof event.clientTimestamp === 'string' && event.clientTimestamp.trim()
            ? event.clientTimestamp.trim()
            : undefined,
      });
      logged += 1;
    }

    return {
      enabled: true,
      logged,
      interactionLogFile: context.record.interactionLogFile ?? null,
    };
  });

  fastify.get('/study/logs/export', async (request, reply) => {
    const token = getStudyTokenFromHeader(request.headers as Record<string, unknown>);
    if (!token) {
      return reply.code(401).send({ error: 'Missing x-study-session-token header' });
    }

    const context = getSessionContextByToken(token);
    if (!context) {
      return reply.code(401).send({ error: 'Invalid or expired study session' });
    }

    if (!hasInteractionLogging(context.record)) {
      return reply.code(404).send({ error: 'Interaction logging is not enabled for this session' });
    }

    const logFile = readInteractionLogFile(context.record);
    if (!logFile) {
      return reply.code(404).send({ error: 'Interaction log file was not found' });
    }

    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${logFile.fileName}"`);
    reply.header('cache-control', 'no-store');
    return reply.send(logFile.content);
  });

  fastify.get('/study/logs/llm-trace/export', async (request, reply) => {
    const token = getStudyTokenFromHeader(request.headers as Record<string, unknown>);
    if (!token) {
      return reply.code(401).send({ error: 'Missing x-study-session-token header' });
    }

    const context = getSessionContextByToken(token);
    if (!context) {
      return reply.code(401).send({ error: 'Invalid or expired study session' });
    }

    if (!hasInteractionLogging(context.record)) {
      return reply.code(404).send({ error: 'Interaction logging is not enabled for this session' });
    }

    const logFile = readLlmTraceLogFile(context.record);
    if (!logFile) {
      return reply.code(404).send({ error: 'LLM trace log file was not found' });
    }

    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${logFile.fileName}"`);
    reply.header('cache-control', 'no-store');
    return reply.send(logFile.content);
  });
}
