/**
 * Query builder for analytics queries.
 *
 * Uses Drizzle ORM to construct efficient SQL queries against the
 * events + event_dimensions tables. Supports time-series aggregation,
 * dimension breakdowns, and multi-dimension cross-tabulation (matrix).
 */

import { sql, and, eq, gte, lte, inArray } from "drizzle-orm";
import { events, eventDimensions } from "../../db/schema";
import type { Database } from "../../db/client";
import type {
  EventsQueryParams,
  DimensionsQueryParams,
  BreakdownQueryParams,
  MatrixQueryParams,
  Granularity,
  DimensionFilter,
} from "./schemas";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * SQLite expression to truncate a timestamp to a given granularity bucket.
 *
 * - hour: "2026-03-14T10" (first 13 chars of ISO string)
 * - day:  "2026-03-14"    (first 10 chars of ISO string)
 */
function timeBucket(granularity: Granularity) {
  const len = granularity === "hour" ? 13 : 10;
  return sql<string>`substr(${events.timestamp}, 1, ${len})`;
}

/**
 * Build WHERE conditions for the events table.
 * Always scoped to appId + date range, optionally filtered by event name.
 */
function eventsWhere(appId: string, params: { from: string; to: string; eventName?: string }) {
  const conditions = [
    eq(events.appId, appId),
    gte(events.timestamp, params.from),
    lte(events.timestamp, params.to),
  ];
  if (params.eventName) {
    conditions.push(eq(events.eventName, params.eventName));
  }
  return and(...conditions)!;
}

/**
 * Filter events by dimension criteria using self-joins.
 * Returns event IDs matching ALL dimension filters, or null if no filters.
 */
async function filteredEventIds(
  db: Database,
  appId: string,
  params: { from: string; to: string; eventName?: string; eventNames?: string[]; filters: DimensionFilter[] },
): Promise<string[] | null> {
  if (params.filters.length === 0) return null;

  // Build a query that self-joins event_dimensions for each filter.
  // Each filter becomes an INNER JOIN requiring that dimension key/value exists.
  const joinParts = params.filters.map(
    (f, i) =>
      sql`INNER JOIN event_dimensions ${sql.raw(`df${i}`)} ON ${sql.raw(`df${i}`)}.event_id = e.id AND ${sql.raw(`df${i}`)}.dim_key = ${f.key} AND ${sql.raw(`df${i}`)}.dim_value = ${f.value}`,
  );

  const conditions = [
    sql`e.app_id = ${appId}`,
    sql`e.timestamp >= ${params.from}`,
    sql`e.timestamp <= ${params.to}`,
  ];

  // Support both single eventName and array eventNames
  const names = params.eventNames ?? (params.eventName ? [params.eventName] : []);
  if (names.length === 1) {
    conditions.push(sql`e.event_name = ${names[0]}`);
  } else if (names.length > 1) {
    conditions.push(
      sql`e.event_name IN (${sql.join(
        names.map((n) => sql`${n}`),
        sql`, `,
      )})`,
    );
  }

  const query = sql`
    SELECT e.id
    FROM events e
    ${sql.join(joinParts, sql` `)}
    WHERE ${sql.join(conditions, sql` AND `)}
  `;

  const rows = await db.all(query);
  return (rows as Array<{ id: string }>).map((r) => r.id);
}

// ── Query functions ─────────────────────────────────────────────────────────

export type TimeSeriesBucket = {
  bucket: string;
  count: number;
};

/**
 * Event count time-series.
 * Groups events into time buckets (hour or day) and counts them.
 */
export async function queryEventTimeSeries(
  db: Database,
  appId: string,
  params: EventsQueryParams,
): Promise<TimeSeriesBucket[]> {
  const eventIds = await filteredEventIds(db, appId, {
    from: params.from,
    to: params.to,
    eventName: params.eventName,
    filters: params.filters,
  });

  const bucket = timeBucket(params.granularity);
  const baseWhere = eventsWhere(appId, params);

  if (eventIds !== null && eventIds.length === 0) return [];

  const where =
    eventIds !== null ? and(baseWhere, inArray(events.id, eventIds))! : baseWhere;

  const rows = await db
    .select({
      bucket,
      count: sql<number>`count(*)`,
    })
    .from(events)
    .where(where)
    .groupBy(bucket)
    .orderBy(bucket);

  return rows.map((r) => ({
    bucket: r.bucket,
    count: Number(r.count),
  }));
}

export type TopEvent = {
  eventName: string;
  count: number;
};

/**
 * Top events by count within a date range.
 * Useful for the overview page.
 */
export async function queryTopEvents(
  db: Database,
  appId: string,
  from: string,
  to: string,
  limit = 20,
): Promise<TopEvent[]> {
  const rows = await db
    .select({
      eventName: events.eventName,
      count: sql<number>`count(*)`,
    })
    .from(events)
    .where(eventsWhere(appId, { from, to }))
    .groupBy(events.eventName)
    .orderBy(sql`count(*) desc`)
    .limit(limit);

  return rows.map((r) => ({
    eventName: r.eventName,
    count: Number(r.count),
  }));
}

export type DimensionKey = {
  dimKey: string;
  distinctValues: number;
};

/**
 * List distinct dimension keys (and count of distinct values) for an event type.
 */
export async function queryDimensionKeys(
  db: Database,
  appId: string,
  params: DimensionsQueryParams,
): Promise<DimensionKey[]> {
  const conditions = [eq(events.appId, appId)];
  if (params.eventName) conditions.push(eq(events.eventName, params.eventName));
  if (params.from) conditions.push(gte(events.timestamp, params.from));
  if (params.to) conditions.push(lte(events.timestamp, params.to));

  const rows = await db
    .select({
      dimKey: eventDimensions.dimKey,
      distinctValues: sql<number>`count(distinct ${eventDimensions.dimValue})`,
    })
    .from(eventDimensions)
    .innerJoin(events, eq(eventDimensions.eventId, events.id))
    .where(and(...conditions))
    .groupBy(eventDimensions.dimKey)
    .orderBy(eventDimensions.dimKey);

  return rows.map((r) => ({
    dimKey: r.dimKey,
    distinctValues: Number(r.distinctValues),
  }));
}

export type BreakdownRow = {
  value: string;
  count: number;
};

/**
 * Single dimension breakdown: for a given event + dim_key, count events per dim_value.
 */
export async function queryBreakdown(
  db: Database,
  appId: string,
  params: BreakdownQueryParams,
): Promise<BreakdownRow[]> {
  const eventIds = await filteredEventIds(db, appId, {
    from: params.from,
    to: params.to,
    eventName: params.eventName,
    filters: params.filters,
  });

  if (eventIds !== null && eventIds.length === 0) return [];

  const conditions = [
    eq(events.appId, appId),
    gte(events.timestamp, params.from),
    lte(events.timestamp, params.to),
    eq(events.eventName, params.eventName),
    eq(eventDimensions.dimKey, params.dimKey),
  ];

  if (eventIds !== null) {
    conditions.push(inArray(events.id, eventIds));
  }

  const rows = await db
    .select({
      value: eventDimensions.dimValue,
      count: sql<number>`count(*)`,
    })
    .from(eventDimensions)
    .innerJoin(events, eq(eventDimensions.eventId, events.id))
    .where(and(...conditions))
    .groupBy(eventDimensions.dimValue)
    .orderBy(sql`count(*) desc`)
    .limit(params.limit);

  return rows.map((r) => ({
    value: r.value,
    count: Number(r.count),
  }));
}

export type MatrixRow = Record<string, string | number>;

/**
 * Multi-dimension cross-tabulation (the killer feature).
 *
 * Self-joins event_dimensions for each requested dimension key to produce
 * a pivot-table-style result. Uses aliased columns (dim0, dim1, dim2) so
 * each dimension's value has a unique column name in the raw result.
 *
 * Example with dimensions=["plugin.name", "plugin.status"]:
 * Returns: [{ "plugin.name": "kitty", "plugin.status": "ok", count: 123 }, ...]
 */
export async function queryMatrix(
  db: Database,
  appId: string,
  params: MatrixQueryParams,
): Promise<MatrixRow[]> {
  const eventIds = await filteredEventIds(db, appId, {
    from: params.from,
    to: params.to,
    eventNames: params.eventNames,
    filters: params.filters,
  });

  if (eventIds !== null && eventIds.length === 0) return [];

  // Separate "event_name" (virtual column on events table) from real dimension keys
  const hasEventNameDim = params.dimensions.includes("event_name");
  const realDims = params.dimensions.filter((d) => d !== "event_name");

  // Build SELECT columns with unique aliases: d0.dim_value AS dim0, d1.dim_value AS dim1, ...
  const selectParts: ReturnType<typeof sql>[] = [];
  if (hasEventNameDim) {
    selectParts.push(sql`e.event_name AS event_name_dim`);
  }
  selectParts.push(
    ...realDims.map(
      (_, i) => sql`${sql.raw(`d${i}`)}.dim_value AS ${sql.raw(`dim${i}`)}`,
    ),
  );

  // Build JOINs: each real dimension is a self-join on event_dimensions
  const joinParts = realDims.map(
    (dimKey, i) =>
      sql`INNER JOIN event_dimensions ${sql.raw(`d${i}`)} ON e.id = ${sql.raw(`d${i}`)}.event_id AND ${sql.raw(`d${i}`)}.dim_key = ${dimKey}`,
  );

  // Build GROUP BY
  const groupByParts: ReturnType<typeof sql>[] = [];
  if (hasEventNameDim) {
    groupByParts.push(sql.raw("e.event_name"));
  }
  groupByParts.push(
    ...realDims.map((_, i) => sql.raw(`d${i}.dim_value`)),
  );

  // WHERE clause
  const conditions = [
    sql`e.app_id = ${appId}`,
    sql`e.timestamp >= ${params.from}`,
    sql`e.timestamp <= ${params.to}`,
  ];

  // event_name filter: single = or IN(...)
  if (params.eventNames.length === 1) {
    conditions.push(sql`e.event_name = ${params.eventNames[0]}`);
  } else {
    conditions.push(
      sql`e.event_name IN (${sql.join(
        params.eventNames.map((n) => sql`${n}`),
        sql`, `,
      )})`,
    );
  }

  if (eventIds !== null) {
    conditions.push(
      sql`e.id IN (${sql.join(
        eventIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }

  const query = sql`
    SELECT ${sql.join([...selectParts, sql`COUNT(*) AS count`], sql`, `)}
    FROM events e
    ${sql.join(joinParts, sql` `)}
    WHERE ${sql.join(conditions, sql` AND `)}
    GROUP BY ${sql.join(groupByParts, sql`, `)}
    ORDER BY count DESC
    LIMIT ${params.limit}
  `;

  const rows = await db.all(query);

  // Map aliased columns back to dimension key names
  return (rows as Record<string, unknown>[]).map((row) => {
    const mapped: MatrixRow = {};
    for (const dim of params.dimensions) {
      if (dim === "event_name") {
        mapped["event_name"] = String(row["event_name_dim"] ?? "");
      } else {
        const idx = realDims.indexOf(dim);
        mapped[dim] = String(row[`dim${idx}`] ?? "");
      }
    }
    mapped.count = Number(row.count ?? 0);
    return mapped;
  });
}

// ── Session queries ─────────────────────────────────────────────────────────

export type SessionSummary = {
  sessionId: string;
  eventCount: number;
  firstEvent: string;
  lastEvent: string;
  eventTypes: string[];
};

/**
 * List sessions with summary info (event count, time range, event types).
 * Only includes events that have a session_id. Uses the idx_events_session index.
 */
export async function querySessions(
  db: Database,
  appId: string,
  params: { from?: string; to?: string; limit: number },
): Promise<SessionSummary[]> {
  const conditions = [
    sql`e.app_id = ${appId}`,
    sql`e.session_id IS NOT NULL`,
  ];
  if (params.from) conditions.push(sql`e.timestamp >= ${params.from}`);
  if (params.to) conditions.push(sql`e.timestamp <= ${params.to}`);

  const query = sql`
    SELECT
      e.session_id,
      COUNT(*) AS event_count,
      MIN(e.timestamp) AS first_event,
      MAX(e.timestamp) AS last_event,
      GROUP_CONCAT(DISTINCT e.event_name) AS event_types
    FROM events e
    WHERE ${sql.join(conditions, sql` AND `)}
    GROUP BY e.session_id
    ORDER BY MAX(e.timestamp) DESC
    LIMIT ${params.limit}
  `;

  const rows = await db.all(query);
  return (rows as Array<{
    session_id: string;
    event_count: number;
    first_event: string;
    last_event: string;
    event_types: string;
  }>).map((r) => ({
    sessionId: r.session_id,
    eventCount: Number(r.event_count),
    firstEvent: r.first_event,
    lastEvent: r.last_event,
    eventTypes: r.event_types ? r.event_types.split(",") : [],
  }));
}

export type SessionEvent = {
  id: string;
  eventName: string;
  timestamp: string;
  dimensions: Record<string, string>;
};

/**
 * Get all events in a session, ordered by timestamp.
 * Batch-fetches dimensions for all events in the session.
 */
export async function querySessionTimeline(
  db: Database,
  appId: string,
  sessionId: string,
): Promise<SessionEvent[]> {
  const rows = await db
    .select({
      id: events.id,
      eventName: events.eventName,
      timestamp: events.timestamp,
    })
    .from(events)
    .where(
      and(
        eq(events.appId, appId),
        eq(events.sessionId, sessionId),
      )!,
    )
    .orderBy(events.timestamp);

  if (rows.length === 0) return [];

  // Batch fetch dimensions for all events in the session
  const eventIds = rows.map((r) => r.id);
  const dims = await db
    .select({
      eventId: eventDimensions.eventId,
      dimKey: eventDimensions.dimKey,
      dimValue: eventDimensions.dimValue,
    })
    .from(eventDimensions)
    .where(inArray(eventDimensions.eventId, eventIds));

  const dimsByEvent = new Map<string, Record<string, string>>();
  for (const d of dims) {
    let map = dimsByEvent.get(d.eventId);
    if (!map) {
      map = {};
      dimsByEvent.set(d.eventId, map);
    }
    map[d.dimKey] = d.dimValue;
  }

  return rows.map((r) => ({
    id: r.id,
    eventName: r.eventName,
    timestamp: r.timestamp,
    dimensions: dimsByEvent.get(r.id) ?? {},
  }));
}
