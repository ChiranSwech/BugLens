/**
 * Perceptual Hash (pHash) — DCT-based image fingerprinting.
 *
 * Used for screenshot deduplication: if two consecutive screenshots have
 * a similarity > 95% (Hamming distance < 4/64 bits), the second is skipped.
 *
 * Runs on the client (extension) to avoid uploading redundant images,
 * and re-checked server-side before confirming an upload.
 *
 * Algorithm:
 *   1. Resize image to 32×32 grayscale
 *   2. Apply DCT to 8×8 top-left frequency block
 *   3. Compare each value to the median — set bit 1 if above, 0 if below
 *   4. Return 64-bit hash as 16-char hex string
 *
 * Note: This implementation uses OffscreenCanvas (available in MV3 service
 * workers and Web Workers). For Node.js, use the server-side sharp-based
 * implementation in packages/backend.
 */

const HASH_SIZE = 8; // 8x8 = 64 bits
const SAMPLE_SIZE = 32; // resize to 32x32 before DCT

/**
 * Compute perceptual hash from an ImageBitmap (browser/extension).
 * Returns a 16-character hex string (64-bit hash).
 */
export async function computePhash(bitmap: ImageBitmap): Promise<string> {
  const canvas = new OffscreenCanvas(SAMPLE_SIZE, SAMPLE_SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D context from OffscreenCanvas');

  ctx.drawImage(bitmap, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

  // Convert to grayscale
  const gray: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    // Luminance formula
    gray.push(0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0));
  }

  const dctValues = applyDct(gray);
  const top = dctValues.slice(0, HASH_SIZE * HASH_SIZE);
  const median = computeMedian(top);

  let hash = 0n;
  for (let i = 0; i < top.length; i++) {
    if ((top[i] ?? 0) > median) hash |= 1n << BigInt(i);
  }

  return hash.toString(16).padStart(16, '0');
}

/**
 * Hamming distance between two 16-char hex pHashes.
 * Returns number of differing bits (0–64). Lower = more similar.
 */
export function hammingDistance(hashA: string, hashB: string): number {
  const a = BigInt('0x' + hashA);
  const b = BigInt('0x' + hashB);
  let xor = a ^ b;
  let dist = 0;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return dist;
}

/**
 * Returns true if two screenshots are considered duplicates (>95% similar).
 * Threshold: 4 or fewer differing bits out of 64.
 */
export function isDuplicate(hashA: string, hashB: string, threshold = 4): boolean {
  return hammingDistance(hashA, hashB) <= threshold;
}

// ─── DCT helpers (simplified 1D applied twice) ────────────────────────────────

function applyDct(signal: number[]): number[] {
  const n = SAMPLE_SIZE;
  const result: number[] = [];
  for (let u = 0; u < n; u++) {
    let sum = 0;
    for (let x = 0; x < n; x++) {
      sum += (signal[x] ?? 0) * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
    }
    result.push(sum);
  }
  return result;
}

function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
