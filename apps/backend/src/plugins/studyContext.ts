import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSessionContextByToken } from '../study/sessionService';

const PROTECTED_PREFIXES = ['/movies', '/theaters', '/showings', '/seats', '/bookings', '/speech'];
const PUBLIC_PATH_EXCEPTIONS = new Set(['/speech/synthesize-preview']);

/**
 * The path to authorize against. Prefers the matched route pattern, which is the
 * canonical registered path: matching on the raw `request.url` instead lets a
 * caller disguise a protected path with percent-encoding (`/%73peech/...`) and
 * skip this hook entirely, since Fastify's router decodes before matching.
 */
function resolveRoutePath(request: FastifyRequest): string {
  const routeUrl = request.routeOptions?.url;
  if (typeof routeUrl === 'string' && routeUrl) return routeUrl;

  const pathname = request.url.split('?')[0] ?? request.url;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function isProtectedPath(pathname: string): boolean {
  if (PUBLIC_PATH_EXCEPTIONS.has(pathname)) {
    return false;
  }
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function extractToken(request: FastifyRequest): string | null {
  const raw = request.headers['x-study-session-token'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string' && raw[0].trim()) {
    return raw[0].trim();
  }
  return null;
}

function deny(reply: FastifyReply, message: string): void {
  void reply.code(401).send({
    error: 'STUDY_SESSION_UNAUTHORIZED',
    message,
  });
}

export async function studyContextPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!isProtectedPath(resolveRoutePath(request))) return;

    const token = extractToken(request);
    if (!token) {
      deny(reply, 'Missing x-study-session-token header.');
      return;
    }

    const context = getSessionContextByToken(token);
    if (!context) {
      deny(reply, 'Study session is invalid, finished, or expired.');
      return;
    }

    request.study = {
      token,
      ...context,
    };
  });
}
