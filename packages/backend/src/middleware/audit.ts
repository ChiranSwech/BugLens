import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { query } from '../db/pool.js';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * onResponse hook: writes an audit log entry for every authenticated
 * state-changing request (POST, PATCH, PUT, DELETE).
 *
 * Fires after the response is sent — never blocks the request.
 * The audit_log table is append-only (application user has no DELETE privilege on it).
 */
export function auditLog(resourceType: string) {
  return function (
    request: FastifyRequest,
    _reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void {
    // Fire-and-forget — never delay the response
    if (WRITE_METHODS.has(request.method)) {
      const actor = request.user;
      const resourceId = (request.params as Record<string, string>)['id'] ?? null;
      const ip = request.ip;
      const ua = request.headers['user-agent'] ?? null;

      query(
        `INSERT INTO audit_log (actor_id, action, resource_type, resource_id, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5::inet, $6)`,
        [
          actor?.sub ?? null,
          `${request.method}:${resourceType}`,
          resourceType,
          resourceId,
          ip,
          ua?.slice(0, 500) ?? null,
        ]
      ).catch((err: Error) => {
        // Log but don't throw — audit failure should not break the API
        request.log.error({ err }, '[AUDIT] Failed to write audit log entry');
      });
    }
    done();
  };
}
