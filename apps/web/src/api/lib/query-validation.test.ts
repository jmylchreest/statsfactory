import { describe, it, expect } from "vitest";
import {
  parseFilters,
  parseLimit,
  EventsQuerySchema,
  DimensionsQuerySchema,
  BreakdownQuerySchema,
  MatrixQuerySchema,
  MAX_FILTERS,
  MAX_LIMIT,
  DEFAULT_LIMIT,
} from "./schemas";

// ── parseFilters ────────────────────────────────────────────────────────────

describe("parseFilters", () => {
  it("returns empty array for undefined input", () => {
    expect(parseFilters(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseFilters("")).toEqual([]);
  });

  it("parses a single filter string", () => {
    expect(parseFilters("geo.country:NZ")).toEqual([
      { key: "geo.country", value: "NZ" },
    ]);
  });

  it("parses an array of filter strings", () => {
    expect(parseFilters(["geo.country:NZ", "plugin.status:ok"])).toEqual([
      { key: "geo.country", value: "NZ" },
      { key: "plugin.status", value: "ok" },
    ]);
  });

  it("handles values containing colons", () => {
    expect(parseFilters("url:https://example.com")).toEqual([
      { key: "url", value: "https://example.com" },
    ]);
  });

  it("skips malformed filters without a colon", () => {
    expect(parseFilters(["good.key:value", "nocolon", "another:ok"])).toEqual([
      { key: "good.key", value: "value" },
      { key: "another", value: "ok" },
    ]);
  });

  it("skips filters with colon at position 0", () => {
    expect(parseFilters(":value")).toEqual([]);
  });
});

// ── parseLimit ──────────────────────────────────────────────────────────────

describe("parseLimit", () => {
  it("returns default for undefined", () => {
    expect(parseLimit(undefined, 100, 1000)).toBe(100);
  });

  it("returns default for non-numeric string", () => {
    expect(parseLimit("abc", 100, 1000)).toBe(100);
  });

  it("clamps to min 1", () => {
    expect(parseLimit("-5", 100, 1000)).toBe(1);
  });

  it("clamps to max", () => {
    expect(parseLimit("5000", 100, 1000)).toBe(1000);
  });

  it("parses valid number", () => {
    expect(parseLimit("50", 100, 1000)).toBe(50);
  });
});

// ── EventsQuerySchema ───────────────────────────────────────────────────────

describe("EventsQuerySchema", () => {
  const validParams = {
    app_id: "01ABCDEFGH1234567890",
    from: "2026-03-01T00:00:00Z",
    to: "2026-03-15T00:00:00Z",
  };

  it("validates minimal valid params (from + to)", () => {
    const result = EventsQuerySchema.safeParse(validParams);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.granularity).toBe("day");
      expect(result.data.event_name).toBeUndefined();
    }
  });

  it("accepts granularity=hour", () => {
    const result = EventsQuerySchema.safeParse({ ...validParams, granularity: "hour" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.granularity).toBe("hour");
  });

  it("accepts event_name filter", () => {
    const result = EventsQuerySchema.safeParse({ ...validParams, event_name: "generate" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.event_name).toBe("generate");
  });

  it("rejects missing from", () => {
    const result = EventsQuerySchema.safeParse({ app_id: "01ABCDEFGH1234567890", to: validParams.to });
    expect(result.success).toBe(false);
  });

  it("rejects missing to", () => {
    const result = EventsQuerySchema.safeParse({ app_id: "01ABCDEFGH1234567890", from: validParams.from });
    expect(result.success).toBe(false);
  });

  it("rejects invalid from date", () => {
    const result = EventsQuerySchema.safeParse({ app_id: "01ABCDEFGH1234567890", from: "not-a-date", to: validParams.to });
    expect(result.success).toBe(false);
  });

  it("rejects invalid granularity", () => {
    const result = EventsQuerySchema.safeParse({ ...validParams, granularity: "minute" });
    expect(result.success).toBe(false);
  });
});

// ── DimensionsQuerySchema ───────────────────────────────────────────────────

describe("DimensionsQuerySchema", () => {
  it("validates with app_id only (other fields optional)", () => {
    const result = DimensionsQuerySchema.safeParse({ app_id: "01ABCDEFGH1234567890" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_name).toBeUndefined();
      expect(result.data.from).toBeUndefined();
      expect(result.data.to).toBeUndefined();
    }
  });

  it("rejects missing app_id", () => {
    const result = DimensionsQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts event_name only", () => {
    const result = DimensionsQuerySchema.safeParse({ app_id: "01ABCDEFGH1234567890", event_name: "generate" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.event_name).toBe("generate");
  });

  it("accepts from and to", () => {
    const result = DimensionsQuerySchema.safeParse({
      app_id: "01ABCDEFGH1234567890",
      from: "2026-03-01T00:00:00Z",
      to: "2026-03-15T00:00:00Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBeDefined();
      expect(result.data.to).toBeDefined();
    }
  });

  it("rejects invalid from date", () => {
    const result = DimensionsQuerySchema.safeParse({ app_id: "01ABCDEFGH1234567890", from: "bad-date" });
    expect(result.success).toBe(false);
  });
});

// ── BreakdownQuerySchema ────────────────────────────────────────────────────

describe("BreakdownQuerySchema", () => {
  const validParams = {
    app_id: "01ABCDEFGH1234567890",
    event_name: "plugin_used",
    dim_key: "plugin.name",
    from: "2026-03-01T00:00:00Z",
    to: "2026-03-15T00:00:00Z",
  };

  it("validates minimal valid params", () => {
    const result = BreakdownQuerySchema.safeParse(validParams);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_name).toBe("plugin_used");
      expect(result.data.dim_key).toBe("plugin.name");
    }
  });

  it("rejects missing event_name", () => {
    const { event_name: _, ...rest } = validParams;
    const result = BreakdownQuerySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing dim_key", () => {
    const { dim_key: _, ...rest } = validParams;
    const result = BreakdownQuerySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing from", () => {
    const { from: _, ...rest } = validParams;
    const result = BreakdownQuerySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("accepts custom limit (parsed by parseLimit)", () => {
    const result = BreakdownQuerySchema.safeParse({ ...validParams, limit: "50" });
    expect(result.success).toBe(true);
    if (result.success) {
      // limit is a string in the schema; parseLimit is called in the route handler
      expect(parseLimit(result.data.limit, DEFAULT_LIMIT, MAX_LIMIT)).toBe(50);
    }
  });

  it("clamps limit to max 1000 via parseLimit", () => {
    expect(parseLimit("5000", DEFAULT_LIMIT, MAX_LIMIT)).toBe(1000);
  });

  it("clamps limit to min 1 via parseLimit", () => {
    expect(parseLimit("-5", DEFAULT_LIMIT, MAX_LIMIT)).toBe(1);
  });

  it("uses default limit for non-numeric value via parseLimit", () => {
    expect(parseLimit("abc", DEFAULT_LIMIT, MAX_LIMIT)).toBe(100);
  });

  it("accepts filters", () => {
    const result = BreakdownQuerySchema.safeParse({
      ...validParams,
      filter: "geo.country:NZ",
    });
    expect(result.success).toBe(true);
  });
});

// ── MatrixQuerySchema ───────────────────────────────────────────────────────

describe("MatrixQuerySchema", () => {
  const validParams = {
    app_id: "01ABCDEFGH1234567890",
    event_name: "plugin_used",
    dimensions: ["plugin.name", "plugin.status"],
    from: "2026-03-01T00:00:00Z",
    to: "2026-03-15T00:00:00Z",
  };

  it("validates minimal valid params (2 dimensions)", () => {
    const result = MatrixQuerySchema.safeParse(validParams);
    expect(result.success).toBe(true);
    if (result.success) {
      const dims = Array.isArray(result.data.dimensions)
        ? result.data.dimensions
        : [result.data.dimensions];
      expect(dims).toEqual(["plugin.name", "plugin.status"]);
    }
  });

  it("accepts 3 dimensions", () => {
    const result = MatrixQuerySchema.safeParse({
      ...validParams,
      dimensions: ["plugin.name", "plugin.status", "plugin.version"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const dims = Array.isArray(result.data.dimensions)
        ? result.data.dimensions
        : [result.data.dimensions];
      expect(dims).toHaveLength(3);
    }
  });

  it("accepts more than 3 dimensions (no upper limit)", () => {
    const result = MatrixQuerySchema.safeParse({
      ...validParams,
      dimensions: ["plugin.name", "plugin.status", "plugin.version", "geo.country", "browser"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const dims = Array.isArray(result.data.dimensions)
        ? result.data.dimensions
        : [result.data.dimensions];
      expect(dims).toHaveLength(5);
    }
  });

  it("rejects missing event_name", () => {
    const { event_name: _, ...rest } = validParams;
    const result = MatrixQuerySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing dimensions", () => {
    const { dimensions: _, ...rest } = validParams;
    const result = MatrixQuerySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing from", () => {
    const { from: _, ...rest } = validParams;
    const result = MatrixQuerySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("accepts custom limit", () => {
    const result = MatrixQuerySchema.safeParse({ ...validParams, limit: "200" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(parseLimit(result.data.limit, DEFAULT_LIMIT, MAX_LIMIT)).toBe(200);
    }
  });

  it("accepts filters", () => {
    const result = MatrixQuerySchema.safeParse({
      ...validParams,
      filter: ["geo.country:NZ"],
    });
    expect(result.success).toBe(true);
  });
});
