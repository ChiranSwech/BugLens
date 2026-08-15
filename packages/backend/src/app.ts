import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { randomUUID } from 'crypto';

import { config, isDev } from './config.js';
import { authRoutes } from './auth/routes.js';
import { bugRoutes } from './bugs/routes.js';
import { sessionRoutes } from './sessions/routes.js';
import { uploadRoutes } from './uploads/routes.js';
import { aiRoutes } from './ai/routes.js';
import { integrationRoutes } from './integrations/routes.js';

export async function buildApp() {
  const loggerOpts = {
    level: isDev ? 'debug' : 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  };
  if (isDev) {
    Object.assign(loggerOpts, {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  }

  const app = Fastify({
    logger: loggerOpts,
    genReqId: () => randomUUID(),
    trustProxy: true,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: false,
        allErrors: false,
      },
    },
  });

  // ─── Security headers ────────────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  // ─── CORS ────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : [config.CORS_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-ID', 'X-CSRF-Token', 'Authorization'],
    maxAge: 86400, // 24 hours preflight cache
  });

  // ─── Cookie support (for HttpOnly refresh token cookies) ────────────────
  await app.register(cookie, {
    secret: config.SESSION_SECRET, // Signs cookies to detect tampering
  });

  // ─── Rate limiting (in-memory store — works on single-instance deployments) ─
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => {
      // Use user ID if authenticated, otherwise fall back to IP
      const userId = (request as unknown as { user?: { sub: string } }).user?.sub;
      return userId ?? request.ip;
    },
    errorResponseBuilder: (_request, context) => ({
      type: 'https://buglens.app/errors/rate-limit-exceeded',
      title: 'Too Many Requests',
      status: 429,
      detail: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
    }),
  });

  // ─── Multipart (file uploads — capped at 20 MB) ──────────────────────────
  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024, // 20 MB
      files: 1,
    },
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown[]; code?: string }, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;

    request.log.error(
      { err: isDev ? error : { message: error.message, code: error.code }, statusCode },
      'Request error'
    );

    const isClientError = statusCode >= 400 && statusCode < 500;
    reply.status(statusCode).send({
      type: `https://buglens.app/errors/${error.code ?? 'internal-error'}`,
      title: isClientError ? error.message : 'An unexpected error occurred',
      status: statusCode,
      ...(isClientError && error.validation ? { errors: error.validation } : {}),
    });
  });

  // ─── 404 handler ─────────────────────────────────────────────────────────
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      type: 'https://buglens.app/errors/not-found',
      title: 'Not Found',
      status: 404,
      detail: `Route ${request.method} ${request.url} not found`,
    });
  });

  // ─── Health check (unauthenticated) ──────────────────────────────────────
  app.get('/health', { logLevel: 'silent' }, async (_request, reply) => {
    reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ─── Routes ──────────────────────────────────────────────────────────────
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(bugRoutes, { prefix: '/v1/bugs' });
  await app.register(sessionRoutes, { prefix: '/v1/sessions' });
  await app.register(uploadRoutes, { prefix: '/v1/uploads' });
  await app.register(aiRoutes, { prefix: '/v1/ai' });
  await app.register(integrationRoutes, { prefix: '/v1/integrations' });

  return app;
}
