import './env';
import path from 'path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { movieRoutes } from './routes/movies';
import { theaterRoutes } from './routes/theaters';
import { showingRoutes } from './routes/showings';
import { seatRoutes } from './routes/seats';
import { bookingRoutes } from './routes/bookings';
import { agentRelayRoutes } from './routes/agentRelay';
import { agentConfigRoutes } from './routes/agentConfig';
import { speechRoutes } from './routes/speech';
import { studyRoutes } from './routes/study';
import { studyContextPlugin } from './plugins/studyContext';
import { stopAllSessionAgents } from './study/agentSupervisor';

const fastify = Fastify({
  logger: {
    // User-supplied OpenAI keys and study tokens must never reach a log line,
    // whatever a future serializer decides to include.
    redact: {
      paths: [
        'req.headers["x-openai-api-key"]',
        'req.headers["x-study-session-token"]',
        'req.headers.authorization',
        'req.body.apiKey',
        'apiKey',
        '*.apiKey',
      ],
      censor: '[REDACTED]',
    },
  },
});

const start = async () => {
  try {
    await fastify.register(cors, {
      origin: true,
    });
    await fastify.register(websocket);

    // Register API routes
    await fastify.register(studyRoutes);
    // Register request hook on the root instance so it applies to all protected routes.
    await studyContextPlugin(fastify);
    await fastify.register(movieRoutes);
    await fastify.register(theaterRoutes);
    await fastify.register(showingRoutes);
    await fastify.register(seatRoutes);
    await fastify.register(bookingRoutes);
    await fastify.register(agentRelayRoutes);
    await fastify.register(agentConfigRoutes);
    await fastify.register(speechRoutes);

    // Health check
    fastify.get('/health', async () => {
      return { status: 'ok' };
    });

    // Serve static frontend files in production
    if (process.env.NODE_ENV === 'production') {
      const frontendPath = path.join(__dirname, '../../frontend/dist');
      /*
        Two cache policies, chosen by path.

        Vite writes every bundle under /assets/ with a content hash in its
        name, so a given URL can only ever hold one set of bytes: those may be
        cached for a year and marked immutable, which is what stops a tablet
        from re-downloading 200 KB of JavaScript on every launch. Everything
        else — index.html, sw.js, manifest.webmanifest, the icons — keeps its
        name across builds and is the thing that *names* the current hashes,
        so it must be revalidated on every load for a redeploy to take effect
        on the next launch. That is also why public/sw.js caches nothing: a
        service worker holding a stale index.html would keep running the old
        build with no visible symptom.

        `cacheControl: false` stops @fastify/send from writing its own single
        policy for the whole tree; the one header we want is set here instead.
      */
      await fastify.register(fastifyStatic, {
        root: frontendPath,
        prefix: '/',
        cacheControl: false,
        setHeaders: (res, filePath) => {
          const relative = path.relative(frontendPath, filePath);
          const hashedAsset = relative.startsWith(`assets${path.sep}`);
          res.setHeader(
            'Cache-Control',
            hashedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=0'
          );
        },
      });

      // SPA fallback - serve index.html for non-API routes
      fastify.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/health')) {
          reply.status(404).send({ error: 'Not Found' });
        } else {
          (reply as any).sendFile('index.html');
        }
      });
    }

    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await fastify.listen({ port, host: '0.0.0.0' });

    console.log(`Server is running on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopAllSessionAgents();
    process.exit(0);
  });
}
