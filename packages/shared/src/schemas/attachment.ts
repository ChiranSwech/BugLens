import { z } from 'zod';

export const AttachmentSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  bugId: z.string().uuid().optional(),
  /** MinIO / S3 object key */
  storageKey: z.string().max(1024),
  /** Perceptual hash (64-bit hex) for deduplication */
  phash: z.string().length(16).optional(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sizeBytes: z.number().int().nonnegative(),
  /** Whether the file is AES-256-GCM encrypted at rest */
  encrypted: z.boolean().default(true),
  createdAt: z.string().datetime(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const PresignRequestSchema = z.object({
  filename: z
    .string()
    .max(255)
    .regex(/^[\w\-. ]+\.(png|jpg|jpeg|webp)$/i, 'Invalid filename'),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024), // 20 MB max
  sessionId: z.string().uuid(),
  /** Client-computed pHash for dedup check before upload */
  phash: z.string().length(16).optional(),
});
export type PresignRequest = z.infer<typeof PresignRequestSchema>;

export const UploadConfirmSchema = z.object({
  storageKey: z.string().max(1024),
  sessionId: z.string().uuid(),
  phash: z.string().length(16).optional(),
  sizeBytes: z.number().int().positive(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
});
export type UploadConfirm = z.infer<typeof UploadConfirmSchema>;
