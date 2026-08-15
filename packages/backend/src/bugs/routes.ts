import type { FastifyInstance } from 'fastify';
import { Client as MinioClient } from 'minio';
import { randomUUID } from 'crypto';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { auditLog } from '../middleware/audit.js';
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { CreateBugSchema, UpdateBugSchema, BugListQuerySchema } from '@buglens/shared';
import { piiQueue, integrationQueue } from '../workers/queues.js';

export async function bugRoutes(app: FastifyInstance) {
  // Lazy MinIO client — only instantiated if attachments are present
  let _minio: MinioClient | null = null;
  function getMinio() {
    if (!_minio) {
      _minio = new MinioClient({
        endPoint: config.MINIO_ENDPOINT,
        port: config.MINIO_PORT,
        useSSL: config.MINIO_USE_SSL,
        accessKey: config.MINIO_ACCESS_KEY,
        secretKey: config.MINIO_SECRET_KEY,
      });
    }
    return _minio;
  }

  // ─── Create bug ────────────────────────────────────────────────────────────
  app.post('/', {
    preHandler: [authenticate],
    onResponse: [auditLog('bug')],
    // Base64 screenshots in the payload can be large; allow up to 25 MB
    // (Fastify default is 1 MB — this only applies to this route)
    bodyLimit: 25 * 1024 * 1024,
  }, async (request, reply) => {
    const body = CreateBugSchema.safeParse(request.body);
    if (!body.success) {
      request.log.error({ validationErrors: body.error.errors }, 'Bug submission validation failed');
      return reply.status(400).send({
        type: 'https://buglens.app/errors/validation-error',
        title: 'Validation Error',
        status: 400,
        errors: body.error.errors,
      });
    }

    const {
      sessionId,
      title,
      description,
      severity,
      reproductionConfidence,
      steps,
      attachments,
      networkLogs,
      integrations,
      expectedResult,
      actualResult,
      consoleLogs,
      storageSnapshot,
      bugUrl,
      testData,
      mainImageIndex,
    } = body.data;
    const { sub: reporterId, orgId } = request.user;

    // Verify session belongs to this user + org
    const sessionCheck = await query(
      'SELECT id FROM sessions WHERE id = $1 AND org_id = $2 AND user_id = $3',
      [sessionId, orgId, reporterId]
    );
    if (!sessionCheck.rowCount) {
      return reply.status(403).send({
        type: 'https://buglens.app/errors/forbidden',
        title: 'Session not found or does not belong to you',
        status: 403,
      });
    }

    const bug = await withTransaction(async (client) => {
      const bugResult = await client.query<{ id: string }>(
        `INSERT INTO bugs (
          session_id, org_id, reporter_id, title, description, severity, reproduction_confidence,
          expected_result, actual_result, console_logs, storage_snapshot, bug_url, test_data, main_image_index
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [
          sessionId,
          orgId,
          reporterId,
          title,
          description ?? null,
          severity,
          reproductionConfidence ?? null,
          expectedResult ?? null,
          actualResult ?? null,
          consoleLogs ? JSON.stringify(consoleLogs) : null,
          storageSnapshot ? JSON.stringify(storageSnapshot) : null,
          bugUrl ?? null,
          testData ?? null,
          mainImageIndex ?? null,
        ]
      );
      const bugId = bugResult.rows[0]!.id;

      // Insert all steps
      for (const step of steps) {
        await client.query(
          `INSERT INTO steps (bug_id, "order", action_type, element_label, css_selector, x_path,
                              value_masked, screenshot_id, "timestamp", failure_type, edited_description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            bugId, step.order, step.actionType, step.elementLabel,
            step.cssSelector ?? null, step.xPath ?? null, step.valueMasked ?? null,
            step.screenshotId ?? null, step.timestamp, step.failureType, step.editedDescription ?? null,
          ]
        );
      }

      // Persist inline base64 screenshots to MinIO and record in attachments table
      if (attachments && attachments.length > 0) {
        const minio = getMinio();
        // Ensure bucket exists
        const exists = await minio.bucketExists(config.MINIO_BUCKET);
        if (!exists) await minio.makeBucket(config.MINIO_BUCKET, 'us-east-1');

        for (const att of attachments) {
          try {
            // Parse data URL: data:image/jpeg;base64,<data>
            const [header, b64] = att.dataUrl.split(',') as [string, string];
            const mimeType = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
            const ext = mimeType.split('/')[1] ?? 'jpg';
            const buffer = Buffer.from(b64, 'base64');
            const storageKey = `${orgId}/${sessionId}/${randomUUID()}.${ext}`;

            await minio.putObject(config.MINIO_BUCKET, storageKey, buffer, buffer.length, {
              'Content-Type': mimeType,
            });

            const attResult = await client.query<{ id: string }>(
              `INSERT INTO attachments (session_id, bug_id, storage_key, mime_type, size_bytes)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [sessionId, bugId, storageKey, mimeType, buffer.length]
            );

            const attachmentId = attResult.rows[0]?.id;
            if (!attachmentId) continue;

            // Queue PII redaction for this attachment
            await piiQueue.add('redact', {
              attachmentId,
              storageKey,
              sessionId
            });

            // Link attachment to step if step index maps to a step in the bug
            const step = steps[att.stepIndex];
            if (step && attachmentId) {
              await client.query(
                `UPDATE steps SET screenshot_id = $1
                 WHERE bug_id = $2 AND "order" = $3`,
                [attachmentId, bugId, (step.order ?? att.stepIndex + 1)]
              );
            }
          } catch (err) {
            // Log but don't fail the bug submission for attachment errors
            request.log.warn({ err, stepIndex: att.stepIndex }, 'Failed to store attachment');
          }
        }
      }

      // Persist failed network logs as JSONB metadata on the bug
      if (networkLogs && networkLogs.length > 0) {
        await client.query(
          `UPDATE bugs SET network_logs = $1 WHERE id = $2`,
          [JSON.stringify(networkLogs), bugId]
        );
      }

      return bugId;
    });

    // Queue integration dispatch (e.g. Jira sync) after successful transaction commit
    if (integrations && integrations.length > 0) {
      for (const integrationType of integrations) {
        await integrationQueue.add('dispatch', {
          bugId: bug,
          orgId,
          event: 'bug.created',
          integrationType
        });
      }
    }

    reply.status(201).send({ id: bug });
  });

  // ─── List bugs (paginated, org-scoped) ────────────────────────────────────
  app.get('/', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const queryParams = BugListQuerySchema.safeParse(request.query);
    if (!queryParams.success) {
      return reply.status(400).send({ title: 'Invalid query parameters', status: 400 });
    }

    const { page, limit, status, severity, reporterId, assigneeId, from, to, search } = queryParams.data;
    const { orgId } = request.user;
    const offset = (page - 1) * limit;

    // Build query dynamically with parameterised values only
    const conditions: string[] = ['b.org_id = $1', 'b.deleted_at IS NULL'];
    const params: unknown[] = [orgId];
    let paramIdx = 2;

    if (status) { conditions.push(`b.status = $${paramIdx++}`); params.push(status); }
    if (severity) { conditions.push(`b.severity = $${paramIdx++}`); params.push(severity); }
    if (reporterId) { conditions.push(`b.reporter_id = $${paramIdx++}`); params.push(reporterId); }
    if (assigneeId) { conditions.push(`b.assignee_id = $${paramIdx++}`); params.push(assigneeId); }
    if (from) { conditions.push(`b.created_at >= $${paramIdx++}`); params.push(from); }
    if (to) { conditions.push(`b.created_at <= $${paramIdx++}`); params.push(to); }
    if (search) { conditions.push(`b.title ILIKE $${paramIdx++}`); params.push(`%${search}%`); }

    const where = conditions.join(' AND ');
    params.push(limit, offset);

    const result = await query(
      `SELECT b.id, b.title, b.severity, b.status, b.reproduction_confidence,
              b.created_at, b.updated_at,
              u.name AS reporter_name, u.email AS reporter_email
       FROM bugs b
       JOIN users u ON u.id = b.reporter_id
       WHERE ${where}
       ORDER BY b.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM bugs b WHERE ${where}`,
      params.slice(0, -2) // exclude limit/offset
    );

    reply.send({
      data: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0]?.['count'] as string ?? '0', 10),
      },
    });
  });

  // ─── Get single bug ────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { id } = request.params;
    const { orgId } = request.user;

    const bugResult = await query(
      `SELECT b.*, u.name AS reporter_name, u.email AS reporter_email, s.device_fingerprint
       FROM bugs b
       JOIN users u ON u.id = b.reporter_id
       JOIN sessions s ON s.id = b.session_id
       WHERE b.id = $1 AND b.org_id = $2 AND b.deleted_at IS NULL`,
      [id, orgId]
    );

    if (!bugResult.rowCount) {
      return reply.status(404).send({ title: 'Bug not found', status: 404 });
    }

    const stepsResult = await query<{
      id: string;
      bug_id: string;
      order: number;
      action_type: string;
      element_label: string;
      css_selector?: string;
      x_path?: string;
      value_masked?: string;
      screenshot_id?: string;
      timestamp: string;
      failure_type: string;
      edited_description?: string;
      storage_key?: string;
    }>(
      `SELECT s.*, a.storage_key FROM steps s
       LEFT JOIN attachments a ON a.id = s.screenshot_id
       WHERE s.bug_id = $1 ORDER BY s."order" ASC`,
      [id]
    );

    const minio = getMinio();
    const stepsWithUrls = await Promise.all(
      stepsResult.rows.map(async (step) => {
        if (step.screenshot_id && step.storage_key) {
          try {
            const url = await minio.presignedGetObject(
              config.MINIO_BUCKET,
              step.storage_key,
              3600 // 1 hour
            );
            return { ...step, screenshotUrl: url };
          } catch (err) {
            request.log.error(
              { err, stepId: step.id },
              'Failed to generate pre-signed URL for step attachment'
            );
            return step;
          }
        }
        return step;
      })
    );

    reply.send({ ...bugResult.rows[0], steps: stepsWithUrls });
  });

  // ─── Update bug ────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: [authenticate],
    onResponse: [auditLog('bug')],
  }, async (request, reply) => {
    const body = UpdateBugSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ title: 'Validation Error', status: 400, errors: body.error.errors });
    }

    const { id } = request.params;
    const { orgId } = request.user;
    const updates = body.data;

    // Build SET clause dynamically
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (updates.title !== undefined) { fields.push(`title = $${idx++}`); values.push(updates.title); }
    if (updates.description !== undefined) { fields.push(`description = $${idx++}`); values.push(updates.description); }
    if (updates.severity !== undefined) { fields.push(`severity = $${idx++}`); values.push(updates.severity); }
    if (updates.status !== undefined) { fields.push(`status = $${idx++}`); values.push(updates.status); }
    if ('assigneeId' in updates) { fields.push(`assignee_id = $${idx++}`); values.push(updates.assigneeId ?? null); }

    if (fields.length === 0) {
      return reply.status(400).send({ title: 'No fields to update', status: 400 });
    }

    values.push(id, orgId);
    const result = await query(
      `UPDATE bugs SET ${fields.join(', ')} WHERE id = $${idx++} AND org_id = $${idx} AND deleted_at IS NULL RETURNING id`,
      values
    );

    if (!result.rowCount) {
      return reply.status(404).send({ title: 'Bug not found', status: 404 });
    }

    reply.send({ id });
  });

  // ─── Soft delete bug (qa-lead or admin only) ──────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [authenticate, authorize('qa-lead')],
    onResponse: [auditLog('bug')],
  }, async (request, reply) => {
    const { id } = request.params;
    const { orgId } = request.user;

    const result = await query(
      `UPDATE bugs SET deleted_at = now() WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, orgId]
    );

    if (!result.rowCount) {
      return reply.status(404).send({ title: 'Bug not found', status: 404 });
    }

    reply.status(204).send();
  });

  // ─── Session replay event log ──────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/replay', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { id } = request.params;
    const { orgId } = request.user;

    const bug = await query(
      'SELECT id FROM bugs WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [id, orgId]
    );
    if (!bug.rowCount) return reply.status(404).send({ title: 'Bug not found', status: 404 });

    const steps = await query(
      `SELECT s.*, a.storage_key AS attachment_key
       FROM steps s
       LEFT JOIN attachments a ON a.id = s.screenshot_id
       WHERE s.bug_id = $1
       ORDER BY s."order" ASC`,
      [id]
    );

    reply.send({ steps: steps.rows });
  });
}
