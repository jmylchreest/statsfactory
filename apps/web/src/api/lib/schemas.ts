/**
 * Zod schemas for OpenAPI spec generation.
 *
 * These schemas are the single source of truth for request/response
 * validation AND OpenAPI documentation. They replace the hand-written
 * validators in validation.ts, query-validation.ts, and manage-validation.ts.
 */
import { z } from "@hono/zod-openapi";

// ── Constants ────────────────────────────────────────────────────────────────
//
// D1 enforces a 100 bind-parameter-per-statement limit. These constants are
// tuned so that ingestion chunking stays within that limit:
//
//   events table:         7 cols → max 14 rows/chunk (98 params)
//   event_dimensions:     4 cols → max 25 rows/chunk (100 params)
//
// Each dimension costs 1 extra row written (event_dimensions). Rollups are
// not used — aggregation happens at query time, trading cheap reads for
// expensive writes. Formula: rows_per_event = 1 + D (1 event + D dims).
//
// Enrichment adds server-side dims after filtering (see enrich.ts
// DEFAULT_ENABLED_DIMS). The number of enriched dims is server-controlled
// per app via enabled_dims config — typically 5-9 depending on mode.
//
// D1 free tier limits: 50 statements per Worker invocation. Each statement
// in db.batch() counts toward this. The ingest handler checks total
// statement count after building the batch and rejects if over 50.
// Formula: ceil(events/14) + ceil(total_dim_rows/25) ≤ 50.
//
// At typical usage (10 user + 5 enriched = 15 dims): 16 rows/event.
// On D1 free tier (100K writes/day): ~6,250 events/day typical.
// At max (25 user + 9 enriched = 34 dims): 35 rows/event → ~2,857 events/day.

export const MAX_EVENTS_PER_BATCH = 25;
export const MAX_DIMENSIONS_PER_EVENT = 25;
export const MAX_DIM_VALUE_LENGTH = 1024;
export const MAX_FILTERS = 10;
export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 100;
// Regex patterns — exported for tests
export const EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const DIM_KEY_RE = /^[a-z][a-z0-9_.]{0,63}$/;
export const APP_NAME_RE = /^[a-zA-Z][a-zA-Z0-9 _-]{0,63}$/;
export const KEY_NAME_RE = /^[a-zA-Z][a-zA-Z0-9 _-]{0,63}$/;

// ── Shared schemas ──────────────────────────────────────────────────────────

export const ErrorResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi("ErrorResponse");

// ── Ingest schemas ──────────────────────────────────────────────────────────

/** A single event within an ingest batch. */
export const IngestEventSchema = z
  .object({
    event: z.string().regex(EVENT_NAME_RE, "Invalid event name").openapi({
      example: "page_view",
      description:
        "Lowercase alphanumeric + underscores, max 64 chars. Must start with a letter.",
    }),
    event_key: z.string().max(64).optional().openapi({
      example: "01JBKV1K7QHGZ9MZXR5V6N4T8P",
      description:
        "Client-generated unique key (e.g. ULID) that identifies this event instance. " +
        "When multiple items in the same batch share the same event_key and event name, " +
        "their dimensions are merged into a single event. This allows SDKs to split " +
        "large dimension sets across multiple batch items. The first occurrence's " +
        "timestamp, session_id, and distinct_id are used.",
    }),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .optional()
      .openapi({
        example: "2026-03-14T10:30:00Z",
        description: "ISO 8601 timestamp. Defaults to server time if omitted.",
      }),
    session_id: z.string().optional().openapi({
      example: "abc123def456",
      description: "Client-provided session identifier.",
    }),
    distinct_id: z.string().optional().openapi({
      example: "user_42",
      description: "Client-provided distinct user identifier.",
    }),
    dimensions: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.union([z.string(), z.number(), z.boolean()])),
        ]),
      )
      .optional()
      .openapi({
        example: {
          "plugin.name": "kitty",
          "plugin.version": 2,
          enabled: true,
          "output.plugins": ["kitty", "waybar"],
        },
        description:
          `Key-value dimensions. Keys: lowercase alphanumeric + dots + underscores, max 64 chars. Values: string (max ${MAX_DIM_VALUE_LENGTH} chars), number, boolean, or array of scalars (JSON-serialized, max ${MAX_DIM_VALUE_LENGTH} chars). Max ${MAX_DIMENSIONS_PER_EVENT} user-provided dimensions per event.`,
      }),
  })
  .openapi("IngestEvent");

/** Request body for POST /v1/events. */
export const IngestRequestSchema = z
  .object({
    events: z
      .array(IngestEventSchema)
      .min(1, "events must not be empty")
      .max(MAX_EVENTS_PER_BATCH, `Batch size exceeds max ${MAX_EVENTS_PER_BATCH}`)
      .openapi({
        description: `Array of events to ingest (1-${MAX_EVENTS_PER_BATCH}).`,
      }),
  })
  .openapi("IngestRequest");

/** Validation error for a single event in the batch. */
export const ValidationErrorSchema = z
  .object({
    index: z.number().openapi({ example: 0, description: "Event index (-1 for batch-level errors)." }),
    message: z.string().openapi({ example: 'Invalid event name "BAD"' }),
  })
  .openapi("ValidationError");

/** Response for POST /v1/events. */
export const IngestResponseSchema = z
  .object({
    accepted: z.number().openapi({ example: 3 }),
    errors: z.array(ValidationErrorSchema).openapi({ description: "Per-event validation errors." }),
  })
  .openapi("IngestResponse");

// ── Query schemas ───────────────────────────────────────────────────────────

/** Parse a "dim_key:value" filter string into { key, value }. */
export const FILTER_OPERATORS = ["eq", "neq", "contains", "in"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const DimensionFilterSchema = z
  .object({
    key: z.string(),
    op: z.enum(FILTER_OPERATORS),
    value: z.string(),
  })
  .openapi("DimensionFilter");

/**
 * Parse filter query params into structured filters.
 *
 * Format: `key:op:value` where op is one of eq, neq, contains, in.
 *
 * Examples:
 *   geo.country:eq:NZ
 *   output.plugins:contains:kitty
 *   geo.country:in:NZ,AU,GB
 *   geo.country:neq:US
 */
export function parseFilters(raw: string | string[] | undefined): z.infer<typeof DimensionFilterSchema>[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const filters: z.infer<typeof DimensionFilterSchema>[] = [];

  for (const f of arr) {
    // Find first colon (key separator)
    const firstColon = f.indexOf(":");
    if (firstColon <= 0) continue; // skip malformed

    const key = f.slice(0, firstColon);
    const rest = f.slice(firstColon + 1);

    // Find second colon (op:value separator)
    const secondColon = rest.indexOf(":");
    if (secondColon <= 0) continue; // must have op:value

    const maybeOp = rest.slice(0, secondColon);
    const value = rest.slice(secondColon + 1);

    if (!(FILTER_OPERATORS as readonly string[]).includes(maybeOp)) continue; // unknown operator
    if (value === undefined || value === "") continue;

    filters.push({ key, op: maybeOp as FilterOperator, value });
  }

  return filters;
}

/** Query params for GET /v1/query/events. */
export const EventsQuerySchema = z
  .object({
    app_id: z.string().min(1).openapi({
      example: "01J1ABCDE...",
      description: "App ID to query (ULID, required).",
    }),
    from: z.string().datetime({ offset: true }).openapi({
      example: "2026-03-01T00:00:00Z",
      description: "Start date (ISO 8601, required).",
    }),
    to: z.string().datetime({ offset: true }).openapi({
      example: "2026-03-15T00:00:00Z",
      description: "End date (ISO 8601, required).",
    }),
    granularity: z.enum(["hour", "day"]).optional().default("day").openapi({
      example: "day",
      description: 'Time bucket granularity. Defaults to "day".',
    }),
    event_name: z.string().optional().openapi({
      example: "page_view",
      description: "Filter to a specific event type.",
    }),
    filter: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        example: "geo.country:eq:NZ",
        description:
          'Dimension filter(s) in "key:op:value" format. Operators: eq, neq, contains, in. For "in", comma-separate values (e.g. geo.country:in:NZ,AU). Repeatable.',
      }),
  })
  .openapi("EventsQuery");


export const EventsResponseSchema = z
  .object({
    time_series: z.array(
      z.object({
        bucket: z.string(),
        event_name: z.string(),
        count: z.number(),
      }),
    ),
    top_events: z.array(
      z.object({
        event_name: z.string(),
        count: z.number(),
      }),
    ),
    meta: z.object({
      from: z.string(),
      to: z.string(),
      granularity: z.string(),
      event_name: z.string().nullable(),
      filters: z.array(DimensionFilterSchema),
    }),
  })
  .openapi("EventsResponse");

/** Query params for GET /v1/query/dimensions. */
export const DimensionsQuerySchema = z
  .object({
    app_id: z.string().min(1).openapi({
      example: "01J1ABCDE...",
      description: "App ID to query (ULID, required).",
    }),
    event_name: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        example: "page_view",
        description:
          "Filter to specific event type(s). Repeat for multiple (e.g. ?event_name=a&event_name=b).",
      }),
    from: z.string().datetime({ offset: true }).optional().openapi({
      example: "2026-03-01T00:00:00Z",
      description: "Start date (ISO 8601, optional).",
    }),
    to: z.string().datetime({ offset: true }).optional().openapi({
      example: "2026-03-15T00:00:00Z",
      description: "End date (ISO 8601, optional).",
    }),
  })
  .openapi("DimensionsQuery");

/** Response for GET /v1/query/dimensions. */
export const DimensionsResponseSchema = z
  .object({
    dimensions: z.array(
      z.object({
        dim_key: z.string(),
        event_types: z.array(z.string()),
      }),
    ),
    meta: z.object({
      event_name: z.union([z.string(), z.array(z.string())]).nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
    }),
  })
  .openapi("DimensionsResponse");

/** Query params for GET /v1/query/breakdown. */
export const BreakdownQuerySchema = z
  .object({
    app_id: z.string().min(1).openapi({
      example: "01J1ABCDE...",
      description: "App ID to query (ULID, required).",
    }),
    event_name: z.string().openapi({
      example: "plugin_used",
      description: "Event type (required).",
    }),
    dim_key: z.string().openapi({
      example: "plugin.name",
      description: "Dimension key to break down by (required).",
    }),
    from: z.string().datetime({ offset: true }).openapi({
      example: "2026-03-01T00:00:00Z",
      description: "Start date (ISO 8601, required).",
    }),
    to: z.string().datetime({ offset: true }).openapi({
      example: "2026-03-15T00:00:00Z",
      description: "End date (ISO 8601, required).",
    }),
    filter: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        example: "geo.country:eq:NZ",
        description: 'Dimension filter(s) in "key:op:value" format. Operators: eq, neq, contains, in. Repeatable.',
      }),
    limit: z
      .string()
      .optional()
      .openapi({
        example: "100",
        description: `Max results (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
      }),
  })
  .openapi("BreakdownQuery");

/** Response for GET /v1/query/breakdown. */
export const BreakdownResponseSchema = z
  .object({
    breakdown: z.array(
      z.object({
        dim_value: z.string(),
        count: z.number(),
      }),
    ),
    meta: z.object({
      event_name: z.string(),
      dim_key: z.string(),
      from: z.string(),
      to: z.string(),
      filters: z.array(DimensionFilterSchema),
      limit: z.number(),
    }),
  })
  .openapi("BreakdownResponse");

/** Query params for GET /v1/query/matrix. */
export const MatrixQuerySchema = z
  .object({
    app_id: z.string().min(1).openapi({
      example: "01J1ABCDE...",
      description: "App ID to query (ULID, required).",
    }),
    event_name: z
      .union([z.string(), z.array(z.string())])
      .openapi({
        example: "page_view",
        description:
          "Event type(s). Pass once for a single event, repeat for multi-event cross-tabulation.",
      }),
    dimensions: z
      .union([z.string(), z.array(z.string())])
      .openapi({
        example: ["plugin.name", "plugin.status"],
        description: `Dimension keys to cross-tabulate (2+, repeatable).`,
      }),
    from: z.string().datetime({ offset: true }).openapi({
      example: "2026-03-01T00:00:00Z",
      description: "Start date (ISO 8601, required).",
    }),
    to: z.string().datetime({ offset: true }).openapi({
      example: "2026-03-15T00:00:00Z",
      description: "End date (ISO 8601, required).",
    }),
    filter: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        example: "geo.country:eq:NZ",
        description: 'Dimension filter(s) in "key:op:value" format. Operators: eq, neq, contains, in. Repeatable.',
      }),
    limit: z
      .string()
      .optional()
      .openapi({
        example: "100",
        description: `Max results (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
      }),
  })
  .openapi("MatrixQuery");

/** Response for GET /v1/query/matrix. */
export const MatrixResponseSchema = z
  .object({
    matrix: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
    meta: z.object({
      event_name: z.union([z.string(), z.array(z.string())]),
      dimensions: z.array(z.string()),
      from: z.string(),
      to: z.string(),
      filters: z.array(DimensionFilterSchema),
      limit: z.number(),
    }),
  })
  .openapi("MatrixResponse");

// ── Session schemas ─────────────────────────────────────────────────────────

/** Query params for GET /v1/query/sessions. */
export const SessionsQuerySchema = z
  .object({
    app_id: z.string().min(1).openapi({
      example: "01J1ABCDE...",
      description: "App ID to query (ULID, required).",
    }),
    from: z.string().datetime({ offset: true }).optional().openapi({
      example: "2026-03-01T00:00:00Z",
      description: "Start date (ISO 8601, optional).",
    }),
    to: z.string().datetime({ offset: true }).optional().openapi({
      example: "2026-03-15T00:00:00Z",
      description: "End date (ISO 8601, optional).",
    }),
    limit: z
      .string()
      .optional()
      .openapi({
        example: "50",
        description: `Max sessions to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
      }),
  })
  .openapi("SessionsQuery");

/** Response for GET /v1/query/sessions. */
export const SessionsResponseSchema = z
  .object({
    sessions: z.array(
      z.object({
        session_id: z.string(),
        event_count: z.number(),
        first_event: z.string(),
        last_event: z.string(),
        event_types: z.array(z.string()),
      }),
    ),
    meta: z.object({
      from: z.string().nullable(),
      to: z.string().nullable(),
      limit: z.number(),
    }),
  })
  .openapi("SessionsResponse");

/** Query params for GET /v1/query/sessions/:sessionId. */
export const SessionTimelineQuerySchema = z
  .object({
    app_id: z.string().min(1).openapi({
      example: "01J1ABCDE...",
      description: "App ID to query (ULID, required).",
    }),
  })
  .openapi("SessionTimelineQuery");

/** Path params for GET /v1/query/sessions/:sessionId. */
export const SessionIdParamSchema = z
  .object({
    sessionId: z.string().min(1).openapi({
      param: { name: "sessionId", in: "path" },
      example: "abc123def456",
      description: "Session ID.",
    }),
  })
  .openapi("SessionIdParam");

/** Response for GET /v1/query/sessions/:sessionId. */
export const SessionTimelineResponseSchema = z
  .object({
    session_id: z.string(),
    events: z.array(
      z.object({
        id: z.string(),
        event_name: z.string(),
        timestamp: z.string(),
        created_at: z.string(),
        dimensions: z.record(z.string(), z.string()),
      }),
    ),
    meta: z.object({
      event_count: z.number(),
    }),
  })
  .openapi("SessionTimelineResponse");

// ── Manage schemas ──────────────────────────────────────────────────────────

/** Request body for POST /v1/apps. */
export const CreateAppSchema = z
  .object({
    name: z.string().regex(APP_NAME_RE, "Invalid app name").openapi({
      example: "My App",
      description:
        "App name. Alphanumeric + spaces/hyphens/underscores, max 64 chars. Must start with a letter.",
    }),
    retention_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .openapi({
        example: 90,
        description: "Data retention in days (1-365). Defaults to 90.",
      }),
    enabled_dims: z
      .array(z.string())
      .optional()
      .openapi({
        example: ["geo.country", "client.browser", "client.os"],
        description:
          "Enriched dimension keys to enable for this app. Each enabled dim adds 1 row written per event. Defaults to DEFAULT_ENABLED_DIMS.",
      }),
  })
  .openapi("CreateApp");

/** Response for POST /v1/apps. */
export const CreateAppResponseSchema = z
  .object({
    id: z.string().openapi({ example: "01J1ABCDE..." }),
    name: z.string().openapi({ example: "My App" }),
  })
  .openapi("CreateAppResponse");

/** Response for GET /v1/apps. */
export const ListAppsResponseSchema = z
  .object({
    apps: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        retentionDays: z.number(),
        enabledDims: z.array(z.string()),
        createdAt: z.string(),
      }),
    ),
  })
  .openapi("ListAppsResponse");

/** Request body for POST /v1/apps/:appId/keys. */
export const CreateKeySchema = z
  .object({
    name: z.string().regex(KEY_NAME_RE, "Invalid key name").openapi({
      example: "Production Key",
      description:
        "Key name. Alphanumeric + spaces/hyphens/underscores, max 64 chars. Must start with a letter.",
    }),
  })
  .openapi("CreateKey");

/** Response for POST /v1/apps/:appId/keys. */
export const CreateKeyResponseSchema = z
  .object({
    id: z.string(),
    key: z.string().openapi({ description: "Raw app key for event ingestion." }),
    key_prefix: z.string(),
    name: z.string(),
  })
  .openapi("CreateKeyResponse");

/** Response for GET /v1/apps/:appId/keys. */
export const ListKeysResponseSchema = z
  .object({
    keys: z.array(
      z.object({
        id: z.string(),
        keyPrefix: z.string(),
        rawKey: z.string().nullable().openapi({ description: "Full app key (null for keys created before this field was added)." }),
        name: z.string(),
        createdAt: z.string(),
        revokedAt: z.string().nullable(),
      }),
    ),
  })
  .openapi("ListKeysResponse");

/** Path params for /v1/apps/:appId/... */
export const AppIdParamSchema = z
  .object({
    appId: z.string().min(1).openapi({
      param: { name: "appId", in: "path" },
      example: "01J1ABCDE...",
      description: "App ID (ULID).",
    }),
  })
  .openapi("AppIdParam");

/** Path params for /v1/apps/:appId/keys/:keyId. */
export const KeyIdParamSchema = z
  .object({
    appId: z.string().min(1).openapi({
      param: { name: "appId", in: "path" },
      example: "01J1ABCDE...",
      description: "App ID (ULID).",
    }),
    keyId: z.string().min(1).openapi({
      param: { name: "keyId", in: "path" },
      example: "01J1FGHIJ...",
      description: "Key ID (ULID).",
    }),
  })
  .openapi("KeyIdParam");

/** Request body for PATCH /v1/apps/:appId. */
export const UpdateAppSchema = z
  .object({
    name: z.string().regex(APP_NAME_RE, "Invalid app name").optional().openapi({
      example: "My Updated App",
      description: "New app name.",
    }),
    retention_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .openapi({
        example: 30,
        description: "Data retention in days (1-365).",
      }),
    enabled_dims: z
      .array(z.string())
      .optional()
      .openapi({
        example: ["geo.country", "client.browser", "client.os"],
        description: "Enriched dimension keys to enable for this app.",
      }),
  })
  .openapi("UpdateApp");

/** Response for PATCH /v1/apps/:appId. */
export const UpdateAppResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    retentionDays: z.number(),
    enabledDims: z.array(z.string()),
  })
  .openapi("UpdateAppResponse");

/** Response for DELETE /v1/apps/:appId. */
export const DeleteAppResponseSchema = z
  .object({
    deleted: z.boolean(),
  })
  .openapi("DeleteAppResponse");

/** Response for POST /v1/apps/:appId/keys/:keyId/revoke. */
export const RevokeKeyResponseSchema = z
  .object({
    revoked: z.boolean(),
  })
  .openapi("RevokeKeyResponse");

// ── Health schema ───────────────────────────────────────────────────────────

export const HealthResponseSchema = z
  .object({
    status: z.string().openapi({ example: "ok" }),
    timestamp: z.string().openapi({ example: "2026-03-15T00:00:00.000Z" }),
  })
  .openapi("HealthResponse");

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine the dim_type for a dimension value.
 * Preserved from validation.ts — used by the ingest route.
 */
export function dimType(value: string | number | boolean | unknown[]): "string" | "number" | "boolean" | "array" {
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

/**
 * Validate individual events for partial acceptance.
 *
 * Zod schema validates overall structure; this function validates
 * individual events so valid ones can be accepted even when some fail.
 * This replicates the per-event validation from the old validation.ts.
 */
export type IngestEvent = z.infer<typeof IngestEventSchema>;
export type ValidationError = z.infer<typeof ValidationErrorSchema>;

export function validateEvents(events: IngestEvent[]): {
  valid: { index: number; event: IngestEvent }[];
  errors: ValidationError[];
} {
  const valid: { index: number; event: IngestEvent }[] = [];
  const errors: ValidationError[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    // Validate dimensions in detail (Zod schema allows the broad shape,
    // but we need to enforce key format, value length, and count limits).
    if (ev.dimensions) {
      const dimKeys = Object.keys(ev.dimensions);

      if (dimKeys.length > MAX_DIMENSIONS_PER_EVENT) {
        errors.push({
          index: i,
          message: `Too many dimensions: ${dimKeys.length} (max ${MAX_DIMENSIONS_PER_EVENT})`,
        });
        continue;
      }

      let dimValid = true;
      for (const key of dimKeys) {
        if (!DIM_KEY_RE.test(key)) {
          errors.push({
            index: i,
            message: `Invalid dimension key "${key}". Must match ${DIM_KEY_RE}`,
          });
          dimValid = false;
          break;
        }

        const val = ev.dimensions[key];
        if (typeof val === "string" && val.length > MAX_DIM_VALUE_LENGTH) {
          errors.push({
            index: i,
            message: `Dimension "${key}" value exceeds ${MAX_DIM_VALUE_LENGTH} chars`,
          });
          dimValid = false;
          break;
        }

        if (Array.isArray(val)) {
          if (val.length === 0) {
            errors.push({
              index: i,
              message: `Dimension "${key}" array must not be empty`,
            });
            dimValid = false;
            break;
          }
          const serialized = JSON.stringify(val);
          if (serialized.length > MAX_DIM_VALUE_LENGTH) {
            errors.push({
              index: i,
              message: `Dimension "${key}" serialized array exceeds ${MAX_DIM_VALUE_LENGTH} chars`,
            });
            dimValid = false;
            break;
          }
        }
      }

      if (!dimValid) continue;
    }

    valid.push({ index: i, event: ev });
  }

  return { valid, errors };
}

/**
 * Parse and clamp a limit query param.
 */
export function parseLimit(raw: string | undefined, defaultVal: number, max: number): number {
  const parsed = parseInt(raw ?? "", 10);
  if (isNaN(parsed)) return defaultVal;
  return Math.min(Math.max(1, parsed), max);
}

// ── Re-exported types ───────────────────────────────────────────────────────

export type Granularity = "hour" | "day";

export type DimensionFilter = z.infer<typeof DimensionFilterSchema>;

export type EventsQueryParams = {
  eventName?: string;
  from: string;
  to: string;
  granularity: Granularity;
  filters: DimensionFilter[];
};

export type DimensionsQueryParams = {
  eventNames?: string[];
  from?: string;
  to?: string;
};

export type BreakdownQueryParams = {
  eventName: string;
  dimKey: string;
  from: string;
  to: string;
  filters: DimensionFilter[];
  limit: number;
};

export type MatrixQueryParams = {
  eventNames: string[];
  dimensions: string[];
  from: string;
  to: string;
  filters: DimensionFilter[];
  limit: number;
};

export type CreateAppBody = z.infer<typeof CreateAppSchema>;
export type CreateKeyBody = z.infer<typeof CreateKeySchema>;
