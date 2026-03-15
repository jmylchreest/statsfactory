import { describe, it, expect } from "vitest";
import {
  CreateAppSchema,
  CreateKeySchema,
} from "./schemas";

describe("CreateAppSchema", () => {
  it("rejects missing name", () => {
    const result = CreateAppSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = CreateAppSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name starting with number", () => {
    const result = CreateAppSchema.safeParse({ name: "123app" });
    expect(result.success).toBe(false);
  });

  it("accepts valid simple name", () => {
    const result = CreateAppSchema.safeParse({ name: "My App" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("My App");
    }
  });

  it("accepts name with hyphens and underscores", () => {
    const result = CreateAppSchema.safeParse({ name: "my-app_v2" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("my-app_v2");
    }
  });

  it("rejects invalid geo_precision", () => {
    const result = CreateAppSchema.safeParse({
      name: "test",
      geo_precision: "zipcode",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid geo_precision values", () => {
    for (const gp of ["country", "city", "none"]) {
      const result = CreateAppSchema.safeParse({
        name: "test",
        geo_precision: gp,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects retention_days out of range (too low)", () => {
    const result = CreateAppSchema.safeParse({
      name: "test",
      retention_days: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects retention_days out of range (too high)", () => {
    const result = CreateAppSchema.safeParse({
      name: "test",
      retention_days: 400,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric retention_days", () => {
    const result = CreateAppSchema.safeParse({
      name: "test",
      retention_days: "30",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid retention_days", () => {
    const result = CreateAppSchema.safeParse({
      name: "test",
      retention_days: 30,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.retention_days).toBe(30);
    }
  });

  it("defaults optional fields to undefined", () => {
    const result = CreateAppSchema.safeParse({ name: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.geo_precision).toBeUndefined();
      expect(result.data.retention_days).toBeUndefined();
    }
  });
});

describe("CreateKeySchema", () => {
  it("rejects missing name", () => {
    const result = CreateKeySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = CreateKeySchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("accepts valid key name", () => {
    const result = CreateKeySchema.safeParse({ name: "Production Key" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Production Key");
    }
  });
});
