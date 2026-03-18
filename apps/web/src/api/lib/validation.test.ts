import { describe, it, expect } from "vitest";
import {
  dimType,
  IngestRequestSchema,
  validateEvents,
  EVENT_NAME_RE,
  DIM_KEY_RE,
  MAX_EVENTS_PER_BATCH,
  MAX_DIMENSIONS_PER_EVENT,
  MAX_DIM_VALUE_LENGTH,
} from "./schemas";

describe("dimType", () => {
  it("returns 'string' for strings", () => {
    expect(dimType("hello")).toBe("string");
    expect(dimType("")).toBe("string");
  });

  it("returns 'number' for numbers", () => {
    expect(dimType(42)).toBe("number");
    expect(dimType(0)).toBe("number");
    expect(dimType(-1.5)).toBe("number");
  });

  it("returns 'boolean' for booleans", () => {
    expect(dimType(true)).toBe("boolean");
    expect(dimType(false)).toBe("boolean");
  });

  it("returns 'array' for arrays", () => {
    expect(dimType(["kitty", "waybar"])).toBe("array");
    expect(dimType([1, 2, 3])).toBe("array");
    expect(dimType(["hello", 42, true])).toBe("array");
  });
});

describe("IngestRequestSchema (Zod)", () => {
  describe("top-level validation", () => {
    it("rejects missing events array", () => {
      const result = IngestRequestSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects non-array events", () => {
      const result = IngestRequestSchema.safeParse({ events: "not array" });
      expect(result.success).toBe(false);
    });

    it("rejects empty events array", () => {
      const result = IngestRequestSchema.safeParse({ events: [] });
      expect(result.success).toBe(false);
    });

    it("rejects batch exceeding 25 events", () => {
      const events = Array.from({ length: 26 }, (_, i) => ({
        event: `event_${i}`,
      }));
      const result = IngestRequestSchema.safeParse({ events });
      expect(result.success).toBe(false);
    });

    it("accepts batch of exactly 25 events", () => {
      const events = Array.from({ length: 25 }, () => ({
        event: "test_event",
      }));
      const result = IngestRequestSchema.safeParse({ events });
      expect(result.success).toBe(true);
    });
  });

  describe("event-level validation (Zod schema)", () => {
    it("rejects missing event name", () => {
      const result = IngestRequestSchema.safeParse({ events: [{}] });
      expect(result.success).toBe(false);
    });

    it("rejects event names starting with uppercase", () => {
      const result = IngestRequestSchema.safeParse({
        events: [{ event: "MyEvent" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects event names with dots", () => {
      const result = IngestRequestSchema.safeParse({
        events: [{ event: "my.event" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects event names with hyphens", () => {
      const result = IngestRequestSchema.safeParse({
        events: [{ event: "my-event" }],
      });
      expect(result.success).toBe(false);
    });

    it("accepts valid event names", () => {
      const validNames = ["a", "generate", "plugin_used", "event_123"];
      for (const name of validNames) {
        const result = IngestRequestSchema.safeParse({ events: [{ event: name }] });
        expect(result.success).toBe(true);
      }
    });

    it("rejects invalid timestamps", () => {
      const result = IngestRequestSchema.safeParse({
        events: [{ event: "test", timestamp: "not-a-date" }],
      });
      expect(result.success).toBe(false);
    });

    it("accepts valid ISO timestamps", () => {
      const result = IngestRequestSchema.safeParse({
        events: [{ event: "test", timestamp: "2026-03-14T10:30:00Z" }],
      });
      expect(result.success).toBe(true);
    });

    it("accepts events without optional fields", () => {
      const result = IngestRequestSchema.safeParse({
        events: [{ event: "test" }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.events[0].timestamp).toBeUndefined();
        expect(result.data.events[0].session_id).toBeUndefined();
        expect(result.data.events[0].distinct_id).toBeUndefined();
        expect(result.data.events[0].dimensions).toBeUndefined();
      }
    });
  });

  describe("dimension type validation (Zod schema)", () => {
    it("rejects dimension values of wrong type (object)", () => {
      const result = IngestRequestSchema.safeParse({
        events: [
          {
            event: "test",
            dimensions: { key: { nested: true } },
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("accepts string, number, boolean, and array dimension values", () => {
      const result = IngestRequestSchema.safeParse({
        events: [
          {
            event: "test",
            dimensions: {
              str_dim: "hello",
              num_dim: 42,
              bool_dim: true,
              arr_dim: ["kitty", "waybar"],
            },
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects nested arrays in dimension values", () => {
      const result = IngestRequestSchema.safeParse({
        events: [
          {
            event: "test",
            dimensions: {
              nested: [["a", "b"]],
            },
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("validateEvents (per-event partial validation)", () => {
  describe("dimension validation", () => {
    it("rejects more than 25 dimensions", () => {
      const dimensions: Record<string, string> = {};
      for (let i = 0; i < 26; i++) {
        dimensions[`dim_${String(i).padStart(3, "0")}`] = "val";
      }
      const { valid, errors } = validateEvents([
        { event: "test", dimensions },
      ]);
      expect(valid).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/Too many dimensions/);
    });

    it("accepts exactly 25 dimensions", () => {
      const dimensions: Record<string, string> = {};
      for (let i = 0; i < 25; i++) {
        dimensions[`dim_${String(i).padStart(3, "0")}`] = "val";
      }
      const { valid, errors } = validateEvents([
        { event: "test", dimensions },
      ]);
      expect(valid).toHaveLength(1);
      expect(errors).toHaveLength(0);
    });

    it("rejects dimension keys starting with uppercase", () => {
      const { valid, errors } = validateEvents([
        { event: "test", dimensions: { "Bad.key": "val" } },
      ]);
      expect(valid).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it("rejects dimension keys with hyphens", () => {
      const { valid, errors } = validateEvents([
        { event: "test", dimensions: { "my-key": "val" } },
      ]);
      expect(valid).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it("accepts valid dimension keys with dots and underscores", () => {
      const { valid, errors } = validateEvents([
        {
          event: "test",
          dimensions: {
            "plugin.name": "kitty",
            "plugin.version": "1.0",
            simple_key: "val",
            a: "b",
          },
        },
      ]);
      expect(valid).toHaveLength(1);
      expect(errors).toHaveLength(0);
    });

    it("rejects string values exceeding 1024 chars", () => {
      const { valid, errors } = validateEvents([
        {
          event: "test",
          dimensions: { long_val: "x".repeat(1025) },
        },
      ]);
      expect(valid).toHaveLength(0);
      expect(errors[0].message).toMatch(/exceeds 1024 chars/);
    });

    it("accepts string values at exactly 1024 chars", () => {
      const { valid, errors } = validateEvents([
        {
          event: "test",
          dimensions: { long_val: "x".repeat(1024) },
        },
      ]);
      expect(valid).toHaveLength(1);
      expect(errors).toHaveLength(0);
    });

    it("rejects empty array dimension values", () => {
      const { valid, errors } = validateEvents([
        {
          event: "test",
          dimensions: { tags: [] },
        },
      ]);
      expect(valid).toHaveLength(0);
      expect(errors[0].message).toMatch(/array must not be empty/);
    });

    it("rejects array dimension values exceeding serialized length limit", () => {
      // Create an array whose JSON serialization exceeds 1024 chars
      const longArray = Array.from({ length: 200 }, (_, i) => `long_value_${i}_${"x".repeat(10)}`);
      const { valid, errors } = validateEvents([
        {
          event: "test",
          dimensions: { tags: longArray },
        },
      ]);
      expect(valid).toHaveLength(0);
      expect(errors[0].message).toMatch(/serialized array exceeds 1024 chars/);
    });

    it("accepts valid array dimension values", () => {
      const { valid, errors } = validateEvents([
        {
          event: "test",
          dimensions: { tags: ["kitty", "waybar"] },
        },
      ]);
      expect(valid).toHaveLength(1);
      expect(errors).toHaveLength(0);
    });

    it("accepts array with mixed scalar types", () => {
      const { valid, errors } = validateEvents([
        {
          event: "test",
          dimensions: { mixed: ["hello", 42, true] },
        },
      ]);
      expect(valid).toHaveLength(1);
      expect(errors).toHaveLength(0);
    });
  });

  describe("partial validation (some valid, some invalid)", () => {
    it("returns valid events alongside errors for invalid ones", () => {
      const { valid, errors } = validateEvents([
        { event: "valid_event" },
        { event: "another_valid", dimensions: { "Bad.key": "val" } },
        { event: "third_valid" },
      ]);
      expect(valid).toHaveLength(2);
      expect(valid[0].event.event).toBe("valid_event");
      expect(valid[1].event.event).toBe("third_valid");
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(1);
    });
  });
});
