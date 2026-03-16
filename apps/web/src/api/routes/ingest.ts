import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { ulid } from "../lib/ulid";
import {
  IngestRequestSchema,
  IngestResponseSchema,
  ErrorResponseSchema,
  validateEvents,
  dimType,
  MAX_DIMENSIONS_PER_EVENT,
  type IngestEvent,
  type ValidationError,
} from "../lib/schemas";
import { events, eventDimensions } from "../../db/schema";
import type { AppEnv } from "../index";

export const ingestRouter = new OpenAPIHono<AppEnv>();

const ingestRoute = createRoute({
  method: "post",
  path: "/events",
  tags: ["Ingestion"],
  summary: "Batch event ingestion",
  description:
    "Ingest a batch of analytics events. Valid events are accepted even if some events in the batch fail validation (partial acceptance).",
  request: {
    body: {
      content: {
        "application/json": {
          schema: IngestRequestSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: IngestResponseSchema,
        },
      },
      description: "Events accepted (possibly with partial errors).",
    },
    400: {
      content: {
        "application/json": {
          schema: IngestResponseSchema,
        },
      },
      description: "All events rejected due to validation errors.",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Missing or invalid API key.",
    },
    500: {
      content: {
        "application/json": {
          schema: IngestResponseSchema,
        },
      },
      description: "Database insert failed.",
    },
  },
});

/**
 * POST /v1/events — Batch event ingestion.
 *
 * Auth: Bearer API key (handled by auth middleware)
 * Enrichment: geo/UA dimensions (handled by enrich middleware)
 *
 * Supports event_key for correlating multiple batch items into a single
 * logical event. When items share the same event_key + event name, their
 * dimensions are merged (later entries override earlier for duplicate keys).
 * The first occurrence's timestamp/session_id/distinct_id are used.
 */
ingestRouter.openapi(ingestRoute, async (c) => {
  const body = c.req.valid("json");

  // Per-event validation for partial acceptance.
  // The Zod schema validates structure, but we need per-event
  // dimension key/value/count checks so valid events can be accepted
  // even when some fail.
  const { valid: validItems, errors } = validateEvents(body.events);

  if (errors.length > 0 && validItems.length === 0) {
    return c.json({ accepted: 0, errors }, 400);
  }

  const appId = c.get("appId");
  const enrichedDims = c.get("enrichedDimensions") ?? {};
  const db = c.get("db");
  const now = new Date().toISOString();

  // ── Merge events by event_key ──────────────────────────────────────────
  // Events sharing the same event_key + event name are merged into one.
  // Events without event_key are treated as standalone (one per item).

  type MergedEvent = {
    event: string;
    timestamp: string;
    sessionId: string | null;
    distinctId: string | null;
    dims: Record<string, string | number | boolean>;
    indices: number[]; // original batch indices (for error reporting)
  };

  const mergedMap = new Map<string, MergedEvent>(); // key: event_key:event_name
  const standalone: MergedEvent[] = [];

  for (const { index, event: ev } of validItems) {
    const timestamp = ev.timestamp ?? now;

    // Merge user dimensions + server-enriched dimensions
    // User dimensions take precedence (they can override enriched ones)
    const evDims: Record<string, string | number | boolean> = {
      ...enrichedDims,
      ...(ev.dimensions ?? {}),
    };

    if (ev.event_key) {
      const mergeKey = `${ev.event_key}:${ev.event}`;
      const existing = mergedMap.get(mergeKey);

      if (existing) {
        // Merge dims — later entries override earlier for duplicate keys
        Object.assign(existing.dims, evDims);
        existing.indices.push(index);
      } else {
        mergedMap.set(mergeKey, {
          event: ev.event,
          timestamp,
          sessionId: ev.session_id ?? null,
          distinctId: ev.distinct_id ?? null,
          dims: evDims,
          indices: [index],
        });
      }
    } else {
      standalone.push({
        event: ev.event,
        timestamp,
        sessionId: ev.session_id ?? null,
        distinctId: ev.distinct_id ?? null,
        dims: evDims,
        indices: [index],
      });
    }
  }

  // Collect all merged events and validate merged dim counts
  const mergeErrors: ValidationError[] = [];
  const finalEvents: MergedEvent[] = [...standalone];

  for (const merged of mergedMap.values()) {
    // Check user-provided dim count on merged result
    const userDimCount = Object.keys(merged.dims).filter(
      (k) => !(k in enrichedDims),
    ).length;
    if (userDimCount > MAX_DIMENSIONS_PER_EVENT) {
      // Reject all items that contributed to this merged event
      for (const idx of merged.indices) {
        mergeErrors.push({
          index: idx,
          message: `Merged event (event_key) has ${userDimCount} user dimensions (max ${MAX_DIMENSIONS_PER_EVENT})`,
        });
      }
      continue;
    }

    finalEvents.push(merged);
  }

  const allErrors = [...errors, ...mergeErrors];

  if (finalEvents.length === 0 && allErrors.length > 0) {
    return c.json({ accepted: 0, errors: allErrors }, 400);
  }

  // ── Build rows ─────────────────────────────────────────────────────────

  const eventRows: (typeof events.$inferInsert)[] = [];
  const dimRows: (typeof eventDimensions.$inferInsert)[] = [];

  for (const merged of finalEvents) {
    const eventId = ulid();

    eventRows.push({
      id: eventId,
      appId,
      eventName: merged.event,
      timestamp: merged.timestamp,
      sessionId: merged.sessionId,
      distinctId: merged.distinctId,
      createdAt: now,
    });

    for (const [key, value] of Object.entries(merged.dims)) {
      dimRows.push({
        eventId,
        dimKey: key,
        dimValue: String(value),
        dimType: dimType(value),
      });
    }
  }

  // Batch insert into D1.
  // D1 limits bind parameters to 100 per statement, so we chunk inserts.
  // Events: 7 columns → max 14 rows/chunk. Dimensions: 4 columns → max 25 rows/chunk.
  // D1 free tier limits total statements to 50 per Worker invocation.
  const EVENT_CHUNK = 14;
  const DIM_CHUNK = 25;
  const MAX_STATEMENTS = 50;

  try {
    const statements: Parameters<typeof db.batch>[0] = [];

    for (let i = 0; i < eventRows.length; i += EVENT_CHUNK) {
      statements.push(db.insert(events).values(eventRows.slice(i, i + EVENT_CHUNK)));
    }
    for (let i = 0; i < dimRows.length; i += DIM_CHUNK) {
      statements.push(
        db.insert(eventDimensions).values(dimRows.slice(i, i + DIM_CHUNK)),
      );
    }

    if (statements.length > MAX_STATEMENTS) {
      return c.json(
        {
          accepted: 0,
          errors: [
            {
              index: -1,
              message: `Batch requires ${statements.length} D1 statements (max ${MAX_STATEMENTS}). Reduce the number of events or dimensions per event.`,
            },
          ],
        },
        400,
      );
    }

    if (statements.length > 0) {
      await db.batch(statements as [typeof statements[0], ...typeof statements]);
    }
  } catch (err) {
    console.error("Failed to insert events:", err);
    return c.json(
      {
        accepted: 0,
        errors: [{ index: -1, message: "Database insert failed" }],
      },
      500,
    );
  }

  return c.json({
    accepted: finalEvents.length,
    errors: allErrors,
  });
});
