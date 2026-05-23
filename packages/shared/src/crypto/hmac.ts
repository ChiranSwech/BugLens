/**
 * HMAC-SHA256 payload signing utility.
 *
 * Works in both browser (SubtleCrypto) and Node.js (crypto.subtle) environments.
 */

const ALGO = { name: 'HMAC', hash: 'SHA-256' };

function getSubtleCrypto(): SubtleCrypto {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subtle = (globalThis as any).crypto?.subtle as SubtleCrypto | undefined;
  if (!subtle) throw new Error('SubtleCrypto not available in this environment');
  return subtle;
}

export async function importHmacKey(hexKey: string): Promise<CryptoKey> {
  return getSubtleCrypto().importKey('raw', hexToBuffer(hexKey), ALGO, false, ['sign', 'verify']);
}

export async function signPayload(payload: string, key: CryptoKey): Promise<string> {
  const data = stringToBuffer(payload);
  const signature = await getSubtleCrypto().sign(ALGO, key, data);
  return bufferToHex(signature);
}

export async function verifyPayload(
  payload: string,
  hexSignature: string,
  key: CryptoKey
): Promise<boolean> {
  const data = stringToBuffer(payload);
  const signature = hexToBuffer(hexSignature);
  return getSubtleCrypto().verify(ALGO, key, signature, data);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stringToBuffer(str: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(str);
  // Copy to a plain ArrayBuffer to satisfy SubtleCrypto's strict BufferSource type
  const buf = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buf).set(encoded);
  return buf;
}

function hexToBuffer(hex: string): ArrayBuffer {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const buf = new ArrayBuffer(hex.length / 2);
  const view = new Uint8Array(buf);
  for (let i = 0; i < hex.length; i += 2) {
    view[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return buf;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
