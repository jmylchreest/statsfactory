import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { ulid } from "../lib/ulid";
import {
  IngestRequestSchema,
  IngestResponseSchema,
  ErrorResponseSchema,
  validateEvents,
  dimType,
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
 */
ingestRouter.openapi(ingestRoute, async (c) => {
  const body = c.req.valid("json");

  // Per-event validation for partial acceptance.
  // The Zod schema validates structure, but we need per-event
  // dimension key/value/count checks so valid events can be accepted
  // even when some fail.
  const { valid: validEvents, errors } = validateEvents(body.events);

  if (errors.length > 0 && validEvents.length === 0) {
    return c.json({ accepted: 0, errors }, 400);
  }

  const appId = c.get("appId");
  const enrichedDims = c.get("enrichedDimensions") ?? {};
  const db = c.get("db");
  const now = new Date().toISOString();

  const eventRows: (typeof events.$inferInsert)[] = [];
  const dimRows: (typeof eventDimensions.$inferInsert)[] = [];

  for (const ev of validEvents) {
    const eventId = ulid();
    const timestamp = ev.timestamp ?? now;

    eventRows.push({
      id: eventId,
      appId,
      eventName: ev.event,
      timestamp,
      sessionId: ev.session_id ?? null,
      distinctId: ev.distinct_id ?? null,
      createdAt: now,
    });

    // Merge user dimensions + server-enriched dimensions
    // User dimensions take precedence (they can override enriched ones if needed)
    const allDims: Record<string, string | number | boolean> = {
      ...enrichedDims,
      ...(ev.dimensions ?? {}),
    };

    for (const [key, value] of Object.entries(allDims)) {
      dimRows.push({
        eventId,
        dimKey: key,
        dimValue: String(value),
        dimType: dimType(value),
      });
    }
  }

  // Batch insert into D1/Turso.
  // D1 limits bind parameters to 100 per statement, so we chunk inserts.
  // Events: 7 columns → max 14 rows/chunk. Dimensions: 4 columns → max 25 rows/chunk.
  const EVENT_CHUNK = 14;
  const DIM_CHUNK = 25;

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
    accepted: validEvents.length,
    errors,
  });
});
