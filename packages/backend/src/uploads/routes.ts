import type { FastifyInstance } from 'fastify';
import { Client as MinioClient } from 'minio';
import { randomUUID } from 'crypto';
import { authenticate } from '../middleware/authenticate.js';
import { query } from '../db/pool.js';
import { PresignRequestSchema, UploadConfirmSchema } from '@bugbuddy/shared';
import { isDuplicate } from '@bugbuddy/shared';
import { config } from '../config.js';

const minio = new MinioClient({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
});

// Ensure bucket exists on startup
async function ensureBucket() {
  const exists = await minio.bucketExists(config.MINIO_BUCKET);
  if (!exists) {
    await minio.makeBucket(config.MINIO_BUCKET, 'us-east-1');
    // Apply a private bucket policy (no public access)
    await minio.setBucketPolicy(config.MINIO_BUCKET, JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [`arn:aws:s3:::${config.MINIO_BUCKET}/*`],
        Condition: { StringNotEquals: { 'aws:username': config.MINIO_ACCESS_KEY } },
      }],
    }));
  }
}
ensureBucket().catch(console.error);

export async function uploadRoutes(app: FastifyInstance) {
  // ─── Request a pre-signed upload URL ──────────────────────────────────────
  app.post('/presign', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const body = PresignRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ title: 'Validation Error', status: 400, errors: body.error.errors });
    }

    const { filename, mimeType, sizeBytes, sessionId, phash } = body.data;
    const { orgId, sub: userId } = request.user;

    // Verify session ownership
    const session = await query(
      'SELECT id FROM sessions WHERE id = $1 AND org_id = $2 AND user_id = $3',
      [sessionId, orgId, userId]
    );
    if (!session.rowCount) {
      return reply.status(403).send({ title: 'Session not found', status: 403 });
    }

    // Server-side pHash dedup check
    if (phash) {
      const recent = await query<{ phash: string }>(
        `SELECT phash FROM attachments WHERE session_id = $1 AND phash IS NOT NULL
         ORDER BY created_at DESC LIMIT 5`,
        [sessionId]
      );
      for (const row of recent.rows) {
        if (row.phash && isDuplicate(phash, row.phash)) {
          return reply.status(409).send({
            type: 'https://bugbuddy.app/errors/duplicate-screenshot',
            title: 'Duplicate screenshot detected',
            status: 409,
            detail: 'This screenshot is too similar to a recent capture and was skipped.',
          });
        }
      }
    }

    // Generate a unique, opaque storage key (never expose original filenames)
    const ext = filename.split('.').pop()?.toLowerCase() ?? 'png';
    const storageKey = `${orgId}/${sessionId}/${randomUUID()}.${ext}`;

    // Pre-signed URL valid for 5 minutes
    const presignedUrl = await minio.presignedPutObject(config.MINIO_BUCKET, storageKey, 300);

    reply.send({ presignedUrl, storageKey });
  });

  // ─── Confirm upload & register attachment ─────────────────────────────────
  app.post('/confirm', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const body = UploadConfirmSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ title: 'Validation Error', status: 400 });
    }

    const { storageKey, sessionId, phash, sizeBytes, mimeType } = body.data;
    const { orgId, sub: userId } = request.user;

    // Verify the session
    const session = await query(
      'SELECT id FROM sessions WHERE id = $1 AND org_id = $2 AND user_id = $3',
      [sessionId, orgId, userId]
    );
    if (!session.rowCount) {
      return reply.status(403).send({ title: 'Session not found', status: 403 });
    }

    // Verify the object actually exists in MinIO (prevents phantom registrations)
    try {
      await minio.statObject(config.MINIO_BUCKET, storageKey);
    } catch {
      return reply.status(404).send({ title: 'Upload not found in storage', status: 404 });
    }

    const result = await query<{ id: string }>(
      `INSERT INTO attachments (session_id, storage_key, phash, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [sessionId, storageKey, phash ?? null, mimeType, sizeBytes]
    );

    // Queue PII redaction worker job (async — non-blocking)
    // Worker will be wired in Phase 3
    reply.status(201).send({ id: result.rows[0]!.id });
  });

  // ─── Get a signed download URL (1-hour expiry) ────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/url', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { id } = request.params;
    const { orgId } = request.user;

    // Verify ownership via session→org chain
    const attachment = await query<{ storage_key: string }>(
      `SELECT a.storage_key FROM attachments a
       JOIN sessions s ON s.id = a.session_id
       WHERE a.id = $1 AND s.org_id = $2`,
      [id, orgId]
    );

    if (!attachment.rowCount) {
      return reply.status(404).send({ title: 'Attachment not found', status: 404 });
    }

    const url = await minio.presignedGetObject(
      config.MINIO_BUCKET,
      attachment.rows[0]!.storage_key,
      3600 // 1 hour
    );

    reply.send({ url });
  });
}
