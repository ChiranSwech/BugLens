import { z } from 'zod';

export const SessionStatusSchema = z.enum([
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'ABANDONED',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** Device fingerprint captured at session start */
export const DeviceFingerprintSchema = z.object({
  os: z.string().max(100),
  browser: z.string().max(100),
  browserVersion: z.string().max(50),
  viewportWidth: z.number().int(),
  viewportHeight: z.number().int(),
  devicePixelRatio: z.number(),
  timezone: z.string().max(100),
  language: z.string().max(20),
  /** Available memory in MB (navigator.deviceMemory) */
  memoryGb: z.number().nullable().optional(),
  /** Logical CPU core count */
  cpuCores: z.number().int().nullable().optional(),
  url: z.string().url().max(2048),
  userAgent: z.string().max(500),
});
export type DeviceFingerprint = z.infer<typeof DeviceFingerprintSchema>;

export const CreateSessionSchema = z.object({
  deviceFingerprint: DeviceFingerprintSchema,
  templateProfileId: z.string().uuid().optional(),
});
export type CreateSession = z.infer<typeof CreateSessionSchema>;

export const SessionSchema = CreateSessionSchema.extend({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  status: SessionStatusSchema.default('ACTIVE'),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().optional(),
  /** ISO 8601 — session auto-abandoned after 4 hours inactivity */
  expiresAt: z.string().datetime(),
});
export type Session = z.infer<typeof SessionSchema>;

export const UpdateSessionSchema = z.object({
  status: SessionStatusSchema,
});
export type UpdateSession = z.infer<typeof UpdateSessionSchema>;

/** Batched event append from the recorder */
export const AppendEventsSchema = z.object({
  events: z.array(
    z.object({
      actionType: z.string().max(50),
      elementLabel: z.string().max(500),
      cssSelector: z.string().max(2000).optional(),
      xPath: z.string().max(2000).optional(),
      valueMasked: z.string().max(1000).optional(),
      timestamp: z.string().datetime(),
    })
  ).min(1).max(100),
});
export type AppendEvents = z.infer<typeof AppendEventsSchema>;
