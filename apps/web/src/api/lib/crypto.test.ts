import { describe, it, expect } from "vitest";
import { hashKey, generateApiKey } from "./crypto";

describe("hashKey", () => {
  it("returns a 64-char hex string", async () => {
    const hash = await hashKey("test-key");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", async () => {
    const a = await hashKey("same-key");
    const b = await hashKey("same-key");
    expect(a).toBe(b);
  });

  it("produces different hashes for different keys", async () => {
    const a = await hashKey("key-one");
    const b = await hashKey("key-two");
    expect(a).not.toBe(b);
  });

  it("produces a known SHA-256 for a known input", async () => {
    // SHA-256("hello") = well-known hash
    const hash = await hashKey("hello");
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("generateApiKey", () => {
  it("generates a key with the sf_ prefix format", async () => {
    const { rawKey } = await generateApiKey("live");
    expect(rawKey).toMatch(/^sf_live_[0-9a-f]{32}$/);
  });

  it("generates a keyPrefix of first 8 chars", async () => {
    const { rawKey, keyPrefix } = await generateApiKey("live");
    expect(keyPrefix).toBe(rawKey.slice(0, 8));
  });

  it("generates a matching hash", async () => {
    const { rawKey, keyHash } = await generateApiKey("live");
    const expectedHash = await hashKey(rawKey);
    expect(keyHash).toBe(expectedHash);
  });

  it("generates unique keys", async () => {
    const keys = await Promise.all(
      Array.from({ length: 10 }, () => generateApiKey("test")),
    );
    const rawKeys = new Set(keys.map((k) => k.rawKey));
    expect(rawKeys.size).toBe(10);
  });
});
