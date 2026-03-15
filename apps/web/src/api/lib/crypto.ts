/**
 * Cryptographic helpers using the Web Crypto API (Workers-compatible).
 */

/**
 * SHA-256 hash a string and return the hex digest.
 * Used for API key hashing — keys are stored as hashes, never plaintext.
 */
export async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a random API key with a given prefix.
 * Format: `sf_<prefix>_<32 random hex chars>`
 *
 * Returns both the raw key (shown once to the user) and its SHA-256 hash
 * (stored in the database).
 */
export async function generateApiKey(prefix: string): Promise<{
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const rawKey = `sf_${prefix}_${hex}`;
  const keyHash = await hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 8);

  return { rawKey, keyHash, keyPrefix };
}
