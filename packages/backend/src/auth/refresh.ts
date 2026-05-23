import { createHash, randomBytes } from 'crypto';
import { query } from '../db/pool.js';

const REFRESH_TOKEN_BYTES = 48; // 384-bit token
const REFRESH_TOKEN_TTL_DAYS = 30;

/** Generate a cryptographically secure refresh token and store its hash. */
export async function issueRefreshToken(userId: string): Promise<string> {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const hash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hash, expiresAt]
  );

  return token;
}

/**
 * Validate and rotate a refresh token.
 * Old token is immediately revoked; a new one is issued.
 * Returns null if the token is invalid, expired, or already revoked.
 */
export async function rotateRefreshToken(
  incomingToken: string
): Promise<{ userId: string; newToken: string } | null> {
  const hash = hashToken(incomingToken);

  const result = await query<{ user_id: string; id: string }>(
    `SELECT id, user_id FROM refresh_tokens
     WHERE token_hash = $1
       AND expires_at > now()
       AND revoked_at IS NULL`,
    [hash]
  );

  if (result.rowCount === 0) return null;

  const { id, user_id: userId } = result.rows[0]!;

  // Revoke old token immediately (rotation)
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [id]);

  // Issue a new one
  const newToken = await issueRefreshToken(userId);
  return { userId, newToken };
}

/** Revoke all refresh tokens for a user (logout everywhere). */
export async function revokeAllTokens(userId: string): Promise<void> {
  await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
