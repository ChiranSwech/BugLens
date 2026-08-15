import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config, isDev } from '../config.js';
import { query } from '../db/pool.js';
import { signAccessToken, initJwtKeys } from './jwt.js';
import { issueRefreshToken, rotateRefreshToken, revokeAllTokens } from './refresh.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const COOKIE_OPTS = {
  httpOnly: true,
  secure: !isDev,
  sameSite: 'strict' as const,
  path: '/',
};

interface GoogleUserInfo {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export async function authRoutes(app: FastifyInstance) {
  // Ensure JWT keys are loaded before any auth routes are used
  await initJwtKeys();

  // ─── Step 1: Redirect to Google ──────────────────────────────────────────
  app.get<{ Querystring: { redirect_uri?: string } }>('/google', async (request, reply) => {
    const extensionRedirect = request.query.redirect_uri || '';
    
    // Store extension redirect URL in the state param (base64 encoded to be safe)
    const state = extensionRedirect ? Buffer.from(extensionRedirect).toString('base64') : '';

    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      redirect_uri: `${config.API_BASE_URL}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'select_account',
      state: state,
    });
    reply.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  // ─── Step 2: Google OAuth callback ───────────────────────────────────────
  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
    '/google/callback',
    async (request, reply) => {
      const { code, error, state } = request.query;

      if (error || !code) {
        return reply.status(400).send({
          type: 'https://bugbuddy.app/errors/oauth-error',
          title: 'OAuth Error',
          status: 400,
          detail: error ?? 'No authorization code received',
        });
      }

      // Exchange code for Google tokens
      const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.GOOGLE_CLIENT_ID,
          client_secret: config.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${config.API_BASE_URL}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        request.log.error({ status: tokenResponse.status }, 'Google token exchange failed');
        return reply.status(502).send({
          type: 'https://bugbuddy.app/errors/oauth-exchange-failed',
          title: 'Authentication Failed',
          status: 502,
        });
      }

      const tokens = (await tokenResponse.json()) as { access_token: string };

      // Fetch user profile
      const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!userInfoResponse.ok) {
        return reply.status(502).send({
          type: 'https://bugbuddy.app/errors/userinfo-failed',
          title: 'Failed to retrieve user profile',
          status: 502,
        });
      }

      const googleUser = (await userInfoResponse.json()) as GoogleUserInfo;

      const user = await upsertGoogleUser(googleUser);

      // Issue tokens
      const accessToken = await signAccessToken({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role as import('@buglens/shared').UserRole,
        orgId: user.org_id,
      });
      const refreshToken = await issueRefreshToken(user.id);

      // Set refresh token in HttpOnly cookie (never accessible to JS)
      reply.setCookie('refresh_token', refreshToken, {
        ...COOKIE_OPTS,
        maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
      });

      // If state exists, it's a redirect target (extension or web)
      if (state) {
        try {
          const redirectUrl = Buffer.from(state, 'base64').toString('ascii');
          // Allow redirects to our known frontend origins
          const isExtension = redirectUrl.startsWith('chrome-extension://') || redirectUrl.includes('.chromiumapp.org');
          const isWebDashboard = redirectUrl.startsWith('http://localhost:3000');
          
          if (isExtension || isWebDashboard) {
            // Append token as hash or query param. Hash is safer for tokens but query is easier for current FE logic.
            const separator = redirectUrl.includes('?') ? '&' : '?';
            return reply.redirect(`${redirectUrl}${separator}access_token=${accessToken}&refresh_token=${refreshToken}`);
          }
        } catch (e) {
          request.log.warn('Invalid state parameter in OAuth callback');
        }
      }

      // Web dashboard flow (returns JSON to popup window to be posted via postMessage, or just JSON)
      reply.send({
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          orgId: user.org_id,
        },
      });
    }
  );

  // ─── Refresh access token ─────────────────────────────────────────────────
  app.post<{ Body?: { refreshToken?: string } }>('/refresh', async (request, reply) => {
    const bodyToken = request.body?.refreshToken;
    const refreshToken = bodyToken || request.cookies['refresh_token'];
    if (!refreshToken) {
      return reply.status(401).send({
        type: 'https://bugbuddy.app/errors/no-refresh-token',
        title: 'Unauthorized',
        status: 401,
      });
    }

    const rotation = await rotateRefreshToken(refreshToken);
    if (!rotation) {
      // Token invalid or expired — force re-login
      reply.clearCookie('refresh_token', COOKIE_OPTS);
      return reply.status(401).send({
        type: 'https://bugbuddy.app/errors/invalid-refresh-token',
        title: 'Session expired. Please log in again.',
        status: 401,
      });
    }

    const userResult = await query<{ id: string; email: string; name: string; role: string; org_id: string }>(
      'SELECT id, email, name, role, org_id FROM users WHERE id = $1',
      [rotation.userId]
    );

    if (!userResult.rowCount) {
      return reply.status(401).send({ title: 'User not found', status: 401 });
    }

    const user = userResult.rows[0]!;
    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role as import('@buglens/shared').UserRole,
      orgId: user.org_id,
    });

    // Rotate cookie
    reply.setCookie('refresh_token', rotation.newToken, {
      ...COOKIE_OPTS,
      maxAge: 30 * 24 * 60 * 60,
    });

    reply.send({ accessToken, refreshToken: rotation.newToken });
  });

  // ─── Logout ──────────────────────────────────────────────────────────────
  app.post('/logout', async (request, reply) => {
    const refreshToken = request.cookies['refresh_token'];
    if (refreshToken) {
      const result = await rotateRefreshToken(refreshToken);
      if (result) {
        await revokeAllTokens(result.userId);
      }
    }
    reply.clearCookie('refresh_token', COOKIE_OPTS);
    reply.send({ message: 'Logged out successfully' });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsertGoogleUser(googleUser: GoogleUserInfo) {
  // First, ensure the user exists or create them with a personal org
  const existing = await query<{ id: string; email: string; name: string; role: string; org_id: string }>(
    'SELECT id, email, name, role, org_id FROM users WHERE google_id = $1',
    [googleUser.sub]
  );

  if (existing.rowCount && existing.rowCount > 0) {
    // Update last login
    await query(
      'UPDATE users SET email=$1, name=$2, picture=$3, last_login_at=now() WHERE google_id=$4',
      [googleUser.email, googleUser.name, googleUser.picture ?? null, googleUser.sub]
    );
    return existing.rows[0]!;
  }

  // New user — create personal org then user
  const orgResult = await query<{ id: string }>(
    "INSERT INTO orgs (name) VALUES ($1) RETURNING id",
    [`${googleUser.name}'s Workspace`]
  );
  const orgId = orgResult.rows[0]!.id;

  const userResult = await query<{ id: string; email: string; name: string; role: string; org_id: string }>(
    `INSERT INTO users (google_id, email, name, picture, org_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, name, role, org_id`,
    [googleUser.sub, googleUser.email, googleUser.name, googleUser.picture ?? null, orgId]
  );
  return userResult.rows[0]!;
}
