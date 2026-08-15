import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/authenticate.js';
import { auditLog } from '../middleware/audit.js';
import { query } from '../db/pool.js';
import { CreateSessionSchema, UpdateSessionSchema, AppendEventsSchema } from '@buglens/shared';

export async function sessionRoutes(app: FastifyInstance) {
  // ─── Start a recording session ─────────────────────────────────────────────
  app.post('/', {
    preHandler: [authenticate],
    onResponse: [auditLog('session')],
  }, async (request, reply) => {
    const body = CreateSessionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ title: 'Validation Error', status: 400, errors: body.error.errors });
    }

    const { deviceFingerprint, templateProfileId } = body.data;
    const { sub: userId, orgId } = request.user;

    const result = await query<{ id: string; expires_at: string }>(
      `INSERT INTO sessions (org_id, user_id, device_fingerprint, template_profile_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, expires_at`,
      [orgId, userId, JSON.stringify(deviceFingerprint), templateProfileId ?? null]
    );

    reply.status(201).send(result.rows[0]);
  });

  // ─── Update session status ─────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: [authenticate],
    onResponse: [auditLog('session')],
  }, async (request, reply) => {
    const body = UpdateSessionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ title: 'Validation Error', status: 400 });
    }

    const { id } = request.params;
    const { sub: userId, orgId } = request.user;
    const { status } = body.data;

    const result = await query(
      `UPDATE sessions
       SET status = $1::session_status, ended_at = CASE WHEN $1::session_status IN ('COMPLETED', 'ABANDONED') THEN now() ELSE ended_at END
       WHERE id = $2 AND org_id = $3 AND user_id = $4
       RETURNING id, status`,
      [status, id, orgId, userId]
    );

    if (!result.rowCount) {
      return reply.status(404).send({ title: 'Session not found', status: 404 });
    }

    reply.send(result.rows[0]);
  });

  // ─── Append events to session (batch, offline-queue friendly) ─────────────
  app.post<{ Params: { id: string } }>('/:id/events', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const body = AppendEventsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ title: 'Validation Error', status: 400, errors: body.error.errors });
    }

    const { id } = request.params;
    const { sub: userId, orgId } = request.user;

    // Verify ownership
    const session = await query(
      'SELECT id FROM sessions WHERE id = $1 AND org_id = $2 AND user_id = $3 AND status = $4',
      [id, orgId, userId, 'ACTIVE']
    );
    if (!session.rowCount) {
      return reply.status(404).send({ title: 'Active session not found', status: 404 });
    }

    // Events stored in session's device_fingerprint JSONB for now;
    // in v1.x, they'll have their own table for fast replay queries
    // For now, just acknowledge receipt (steps are submitted with the bug)
    reply.status(202).send({ received: body.data.events.length });
  });
}
