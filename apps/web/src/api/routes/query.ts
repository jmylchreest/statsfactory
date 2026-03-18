import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  EventsQuerySchema,
  EventsResponseSchema,
  DimensionsQuerySchema,
  DimensionsResponseSchema,
  BreakdownQuerySchema,
  BreakdownResponseSchema,
  MatrixQuerySchema,
  MatrixResponseSchema,
  SessionsQuerySchema,
  SessionsResponseSchema,
  SessionTimelineQuerySchema,
  SessionTimelineResponseSchema,
  SessionIdParamSchema,
  ErrorResponseSchema,
  parseFilters,
  parseLimit,
  MAX_FILTERS,
  MAX_LIMIT,
  DEFAULT_LIMIT,
} from "../lib/schemas";
import {
  queryEventTimeSeries,
  queryTopEvents,
  queryDimensionKeys,
  queryBreakdown,
  queryMatrix,
  querySessions,
  querySessionTimeline,
} from "../lib/query-builder";
import type { AppEnv } from "../index";

export const queryRouter = new OpenAPIHono<AppEnv>();

// ── GET /v1/query/events ────────────────────────────────────────────────────

const eventsRoute = createRoute({
  method: "get",
  path: "/query/events",
  tags: ["Query"],
  summary: "Event count time-series",
  description:
    "Returns event counts bucketed by time, plus top events in the range. Queries events table directly. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    query: EventsQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: EventsResponseSchema } },
      description: "Time-series and top events.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid query parameters.",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Query failed.",
    },
  },
});

queryRouter.openapi(eventsRoute, async (c) => {
  const query = c.req.valid("query");
  const appId = query.app_id;
  const from = new Date(query.from).toISOString();
  const to = new Date(query.to).toISOString();

  if (from > to) {
    return c.json({ error: '"from" must be before "to"' }, 400);
  }

  const filters = parseFilters(query.filter);
  if (filters.length > MAX_FILTERS) {
    return c.json({ error: `Too many filters: ${filters.length} (max ${MAX_FILTERS})` }, 400);
  }

  const granularity = query.granularity ?? "day";
  const eventName = query.event_name;

  const db = c.get("db");

  const params = { from, to, granularity, filters, eventName };

  try {
    const [timeSeries, topEvents] = await Promise.all([
      queryEventTimeSeries(db, appId, params),
      queryTopEvents(db, appId, from, to),
    ]);

    return c.json({
      time_series: timeSeries,
      top_events: topEvents,
      meta: {
        from,
        to,
        granularity,
        event_name: eventName ?? null,
        filters,
      },
    });
  } catch (err) {
    console.error("Query events failed:", err);
    return c.json({ error: "Query failed" }, 500);
  }
});

// ── GET /v1/query/dimensions ────────────────────────────────────────────────

const dimensionsRoute = createRoute({
  method: "get",
  path: "/query/dimensions",
  tags: ["Query"],
  summary: "List distinct dimension keys",
  description:
    "Returns distinct dimension keys, optionally filtered by event type and date range. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    query: DimensionsQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: DimensionsResponseSchema } },
      description: "Dimension keys list.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid query parameters.",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Query failed.",
    },
  },
});

queryRouter.openapi(dimensionsRoute, async (c) => {
  const query = c.req.valid("query");
  const appId = query.app_id;
  const from = query.from ? new Date(query.from).toISOString() : undefined;
  const to = query.to ? new Date(query.to).toISOString() : undefined;

  if (from && to && from > to) {
    return c.json({ error: '"from" must be before "to"' }, 400);
  }

  // Normalize event_name to array (supports ?event_name=a&event_name=b)
  const rawEvents = query.event_name;
  const eventNames = Array.isArray(rawEvents)
    ? rawEvents
    : rawEvents
      ? [rawEvents]
      : [];

  const db = c.get("db");

  try {
    const dimensions = await queryDimensionKeys(db, appId, {
      eventNames: eventNames.length > 0 ? eventNames : undefined,
      from,
      to,
    });
    return c.json({
      dimensions,
      meta: {
        event_name:
          eventNames.length === 0
            ? null
            : eventNames.length === 1
              ? eventNames[0]
              : eventNames,
        from: from ?? null,
        to: to ?? null,
      },
    });
  } catch (err) {
    console.error("Query dimensions failed:", err);
    return c.json({ error: "Query failed" }, 500);
  }
});

// ── GET /v1/query/breakdown ─────────────────────────────────────────────────

const breakdownRoute = createRoute({
  method: "get",
  path: "/query/breakdown",
  tags: ["Query"],
  summary: "Single dimension breakdown",
  description:
    "Returns event counts grouped by a single dimension value. Queries events table directly. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    query: BreakdownQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: BreakdownResponseSchema } },
      description: "Dimension breakdown.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid query parameters.",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Query failed.",
    },
  },
});

queryRouter.openapi(breakdownRoute, async (c) => {
  const query = c.req.valid("query");
  const appId = query.app_id;
  const from = new Date(query.from).toISOString();
  const to = new Date(query.to).toISOString();

  if (from > to) {
    return c.json({ error: '"from" must be before "to"' }, 400);
  }

  const filters = parseFilters(query.filter);
  if (filters.length > MAX_FILTERS) {
    return c.json({ error: `Too many filters: ${filters.length} (max ${MAX_FILTERS})` }, 400);
  }

  const limit = parseLimit(query.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const db = c.get("db");

  const params = {
    eventName: query.event_name,
    dimKey: query.dim_key,
    from,
    to,
    filters,
    limit,
  };

  try {
    const rows = await queryBreakdown(db, appId, params);
    return c.json({
      breakdown: rows,
      meta: {
        event_name: params.eventName,
        dim_key: params.dimKey,
        from,
        to,
        filters,
        limit,
      },
    });
  } catch (err) {
    console.error("Query breakdown failed:", err);
    return c.json({ error: "Query failed" }, 500);
  }
});

// ── GET /v1/query/matrix ────────────────────────────────────────────────────

const matrixRoute = createRoute({
  method: "get",
  path: "/query/matrix",
  tags: ["Query"],
  summary: "Multi-dimension cross-tabulation",
  description:
    "Returns event counts cross-tabulated across 2+ dimension keys. Supports multiple event types — include 'event_name' as a dimension to group by event type. Requires raw event scan. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    query: MatrixQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: MatrixResponseSchema } },
      description: "Matrix cross-tabulation.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid query parameters.",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Query failed.",
    },
  },
});

queryRouter.openapi(matrixRoute, async (c) => {
  const query = c.req.valid("query");
  const appId = query.app_id;

  // event_name can be string or string[]
  const rawEvents = query.event_name;
  const eventNames = Array.isArray(rawEvents) ? rawEvents : rawEvents ? [rawEvents] : [];
  if (eventNames.length === 0) {
    return c.json({ error: 'At least one "event_name" is required' }, 400);
  }

  // dimensions can be string or string[]
  // event_name can be included as a dimension by the client to group by event type
  const rawDims = query.dimensions;
  const dimensions = Array.isArray(rawDims) ? rawDims : rawDims ? [rawDims] : [];

  if (dimensions.length < 2) {
    return c.json({ error: 'At least 2 "dimensions" are required' }, 400);
  }

  const from = new Date(query.from).toISOString();
  const to = new Date(query.to).toISOString();

  if (from > to) {
    return c.json({ error: '"from" must be before "to"' }, 400);
  }

  const filters = parseFilters(query.filter);
  if (filters.length > MAX_FILTERS) {
    return c.json({ error: `Too many filters: ${filters.length} (max ${MAX_FILTERS})` }, 400);
  }

  const limit = parseLimit(query.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const db = c.get("db");

  try {
    const rows = await queryMatrix(db, appId, {
      eventNames,
      dimensions,
      from,
      to,
      filters,
      limit,
    });
    return c.json({
      matrix: rows,
      meta: {
        event_name: eventNames.length === 1 ? eventNames[0] : eventNames,
        dimensions,
        from,
        to,
        filters,
        limit,
      },
    });
  } catch (err) {
    console.error("Query matrix failed:", err);
    return c.json({ error: "Query failed" }, 500);
  }
});

// ── GET /v1/query/sessions ──────────────────────────────────────────────────

const sessionsRoute = createRoute({
  method: "get",
  path: "/query/sessions",
  tags: ["Query"],
  summary: "List sessions with summary",
  description:
    "Returns sessions with event counts, time range, and event types. Only includes events with a session_id. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    query: SessionsQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: SessionsResponseSchema } },
      description: "Session summaries.",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Query failed.",
    },
  },
});

queryRouter.openapi(sessionsRoute, async (c) => {
  const query = c.req.valid("query");
  const appId = query.app_id;
  const from = query.from ? new Date(query.from).toISOString() : undefined;
  const to = query.to ? new Date(query.to).toISOString() : undefined;
  const limit = parseLimit(query.limit, DEFAULT_LIMIT, MAX_LIMIT);

  if (from && to && from > to) {
    return c.json({ error: '"from" must be before "to"' }, 500);
  }

  const db = c.get("db");

  try {
    const sessions = await querySessions(db, appId, { from, to, limit });
    return c.json({
      sessions: sessions.map((s) => ({
        session_id: s.sessionId,
        event_count: s.eventCount,
        first_event: s.firstEvent,
        last_event: s.lastEvent,
        event_types: s.eventTypes,
      })),
      meta: {
        from: from ?? null,
        to: to ?? null,
        limit,
      },
    });
  } catch (err) {
    console.error("Query sessions failed:", err);
    return c.json({ error: "Query failed" }, 500);
  }
});

// ── GET /v1/query/sessions/:sessionId ───────────────────────────────────────

const sessionTimelineRoute = createRoute({
  method: "get",
  path: "/query/sessions/{sessionId}",
  tags: ["Query"],
  summary: "Session timeline",
  description:
    "Returns all events in a session ordered by timestamp, with their dimensions. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    params: SessionIdParamSchema,
    query: SessionTimelineQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: SessionTimelineResponseSchema } },
      description: "Session events timeline.",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Session not found.",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Query failed.",
    },
  },
});

queryRouter.openapi(sessionTimelineRoute, async (c) => {
  const { sessionId } = c.req.valid("param");
  const { app_id: appId } = c.req.valid("query");

  const db = c.get("db");

  try {
    const events = await querySessionTimeline(db, appId, sessionId);
    if (events.length === 0) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({
      session_id: sessionId,
      events: events.map((e) => ({
        id: e.id,
        event_name: e.eventName,
        timestamp: e.timestamp,
        created_at: e.createdAt,
        dimensions: e.dimensions,
      })),
      meta: {
        event_count: events.length,
      },
    });
  } catch (err) {
    console.error("Query session timeline failed:", err);
    return c.json({ error: "Query failed" }, 500);
  }
});
