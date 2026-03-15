import { describe, it, expect } from "vitest";
import { ulid } from "./ulid";

describe("ulid", () => {
  it("returns a 26-character string", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
  });

  it("uses only Crockford base32 characters", () => {
    const valid = /^[0-9A-HJKMNP-TV-Z]+$/;
    for (let i = 0; i < 20; i++) {
      expect(ulid()).toMatch(valid);
    }
  });

  it("generates unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => ulid()));
    expect(ids.size).toBe(100);
  });

  it("is roughly time-sorted (same ms batch)", () => {
    // ULIDs generated in quick succession should share the same time prefix
    const a = ulid();
    const b = ulid();
    // First 10 chars are the timestamp portion — likely identical within 1ms
    // At minimum, they should be lexicographically ordered or equal in time prefix
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
  });
});
