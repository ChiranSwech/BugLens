import { z } from 'zod';

export const UserRoleSchema = z.enum(['viewer', 'reporter', 'qa-lead', 'admin']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  googleId: z.string().max(255),
  email: z.string().email().max(255),
  name: z.string().max(255),
  picture: z.string().url().max(2048).nullable().optional(),
  role: UserRoleSchema.default('reporter'),
  orgId: z.string().uuid(),
  createdAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().nullable().optional(),
});
export type User = z.infer<typeof UserSchema>;

/** JWT access token payload */
export const JwtPayloadSchema = z.object({
  sub: z.string().uuid(),         // user ID
  email: z.string().email(),
  name: z.string(),
  role: UserRoleSchema,
  orgId: z.string().uuid(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().uuid(),         // JWT ID — for revocation checks
});
export type JwtPayload = z.infer<typeof JwtPayloadSchema>;
