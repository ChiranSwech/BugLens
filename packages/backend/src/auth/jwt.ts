import { SignJWT, jwtVerify, importPKCS8, importSPKI, generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import type { KeyLike } from 'jose';
import { randomUUID } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import type { JwtPayload } from '@buglens/shared';

const KEY_DIR = config.JWT_KEYS_DIR;
const PRIVATE_KEY_PATH = join(KEY_DIR, 'private.pem');
const PUBLIC_KEY_PATH = join(KEY_DIR, 'public.pem');

let privateKey: KeyLike;
let publicKey: KeyLike;

/**
 * Load or generate RS256 keypair on startup.
 * Keys are persisted to disk (Docker volume in production) so they survive restarts.
 */
export async function initJwtKeys(): Promise<void> {
  if (existsSync(PRIVATE_KEY_PATH) && existsSync(PUBLIC_KEY_PATH)) {
    const [privPem, pubPem] = await Promise.all([
      readFile(PRIVATE_KEY_PATH, 'utf-8'),
      readFile(PUBLIC_KEY_PATH, 'utf-8'),
    ]);
    privateKey = await importPKCS8(privPem, 'RS256');
    publicKey = await importSPKI(pubPem, 'RS256');
    console.info('[JWT] Loaded existing RS256 keypair');
  } else {
    console.info('[JWT] Generating new RS256 keypair...');
    const pair = await generateKeyPair('RS256', { modulusLength: 2048 });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;

    const [privPem, pubPem] = await Promise.all([
      exportPKCS8(pair.privateKey),
      exportSPKI(pair.publicKey),
    ]);

    await mkdir(KEY_DIR, { recursive: true });
    await Promise.all([
      writeFile(PRIVATE_KEY_PATH, privPem, { mode: 0o600 }),
      writeFile(PUBLIC_KEY_PATH, pubPem, { mode: 0o644 }),
    ]);
    console.info('[JWT] Keypair generated and persisted');
  }
}

/** Issues a short-lived access JWT (15 minutes). */
export async function signAccessToken(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'>
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'RS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('15m')
    .setIssuer('buglens')
    .setAudience('buglens-api')
    .sign(privateKey);
}

/** Verifies an access JWT and returns the typed payload. */
export async function verifyAccessToken(token: string): Promise<JwtPayload> {
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: 'buglens',
    audience: 'buglens-api',
    algorithms: ['RS256'],
  });
  return payload as unknown as JwtPayload;
}

/** Returns the public key in PEM format for JWKS endpoints (future). */
export async function getPublicKeyPem(): Promise<string> {
  return exportSPKI(publicKey);
}
