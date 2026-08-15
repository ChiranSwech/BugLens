import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from '../auth/jwt.js';
import type { JwtPayload } from '@buglens/shared';

// Augment Fastify's request type with our user
declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
  }
}

/**
 * Prehandler: validates Bearer JWT and injects req.user.
 * Rejects with 401 on any failure — never reveals why the token failed.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({
      type: 'https://buglens.app/errors/unauthorized',
      title: 'Authentication required',
      status: 401,
    });
  }

  const token = authHeader.slice(7);

  try {
    const payload = await verifyAccessToken(token);
    request.user = payload;
  } catch {
    // Never expose token error details (expired, invalid signature, etc.)
    return reply.status(401).send({
      type: 'https://buglens.app/errors/unauthorized',
      title: 'Authentication required',
      status: 401,
    });
  }
}
