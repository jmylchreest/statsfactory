/**
 * Minimal ULID generator for Cloudflare Workers.
 *
 * ULIDs are 26-char, Crockford base32-encoded, time-sortable unique IDs.
 * Format: 10 chars timestamp (48-bit ms) + 16 chars randomness (80-bit).
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

function encodeTime(now: number, len: number): string {
  let str = "";
  for (let i = len; i > 0; i--) {
    const mod = now % 32;
    str = ENCODING[mod] + str;
    now = (now - mod) / 32;
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let str = "";
  for (let i = 0; i < len; i++) {
    str += ENCODING[bytes[i] % 32];
  }
  return str;
}

/**
 * Generate a new ULID. Uses `crypto.getRandomValues` (available in Workers).
 */
export function ulid(): string {
  const now = Date.now();
  return encodeTime(now, 10) + encodeRandom(16);
}
