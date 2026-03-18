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
  FilterOperator,
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
 * Build the value-matching condition for a single filter, based on operator.
 *
 * For array dimensions, `contains` checks if an element exists in the JSON array.
 * For scalar dimensions, `contains` does a LIKE substring match.
 * The `in` operator matches if the scalar value is in a comma-separated set,
 * or if any array element is in the set.
 */
function filterCondition(alias: string, f: DimensionFilter): ReturnType<typeof sql> {
  switch (f.op) {
    case "eq":
      return sql`${sql.raw(alias)}.dim_value = ${f.value}`;

    case "neq":
      return sql`${sql.raw(alias)}.dim_value != ${f.value}`;

    case "contains":
      // For arrays: EXISTS (SELECT 1 FROM json_each(dim_value) WHERE value = ?)
      // For scalars: dim_value LIKE '%?%'
      // We use OR to handle both cases transparently (dim_type can be checked, but
      // the json_each approach is safe on non-JSON text — it just returns no rows).
      return sql`(
        EXISTS (SELECT 1 FROM json_each(${sql.raw(alias)}.dim_value) WHERE json_each.value = ${f.value})
        OR (${sql.raw(alias)}.dim_type != 'array' AND ${sql.raw(alias)}.dim_value LIKE ${"%" + f.value + "%"})
      )`;

    case "in": {
      const values = f.value.split(",").map((v) => v.trim()).filter(Boolean);
      if (values.length === 0) return sql`0`; // no values = no match
      const valuePlaceholders = sql.join(values.map((v) => sql`${v}`), sql`, `);
      // For arrays: any element in the set. For scalars: value in the set.
      return sql`(
        EXISTS (SELECT 1 FROM json_each(${sql.raw(alias)}.dim_value) WHERE json_each.value IN (${valuePlaceholders}))
        OR (${sql.raw(alias)}.dim_type != 'array' AND ${sql.raw(alias)}.dim_value IN (${valuePlaceholders}))
      )`;
    }

    default:
      return sql`${sql.raw(alias)}.dim_value = ${f.value}`;
  }
}

/**
 * Filter events by dimension criteria using self-joins.
 * Returns event IDs matching ALL dimension filters, or null if no filters.
 *
 * Each filter becomes an INNER JOIN on event_dimensions with operator-specific
 * value matching (eq, neq, contains, in). Array dimensions are supported via
 * SQLite json_each() for contains/in operators.
 */
async function filteredEventIds(
  db: Database,
  appId: string,
  params: { from: string; to: string; eventName?: string; eventNames?: string[]; filters: DimensionFilter[] },
): Promise<string[] | null> {
  if (params.filters.length === 0) return null;

  // Build a query that self-joins event_dimensions for each filter.
  // neq uses LEFT JOIN + IS NULL pattern to find events that DON'T have the value.
  const joinParts = params.filters.map((f, i) => {
    const alias = `df${i}`;
    if (f.op === "neq") {
      // LEFT JOIN: find events where the dim either doesn't exist or has a different value
      return sql`LEFT JOIN event_dimensions ${sql.raw(alias)} ON ${sql.raw(alias)}.event_id = e.id AND ${sql.raw(alias)}.dim_key = ${f.key} AND ${sql.raw(alias)}.dim_value = ${f.value}`;
    }
    // INNER JOIN with operator-specific condition
    return sql`INNER JOIN event_dimensions ${sql.raw(alias)} ON ${sql.raw(alias)}.event_id = e.id AND ${sql.raw(alias)}.dim_key = ${f.key} AND ${filterCondition(alias, f)}`;
  });

  const conditions = [
    sql`e.app_id = ${appId}`,
    sql`e.timestamp >= ${params.from}`,
    sql`e.timestamp <= ${params.to}`,
  ];

  // For neq: add WHERE df{i}.event_id IS NULL (no matching row = value doesn't match)
  params.filters.forEach((f, i) => {
    if (f.op === "neq") {
      conditions.push(sql`${sql.raw(`df${i}`)}.event_id IS NULL`);
    }
  });

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
    SELECT DISTINCT e.id
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
  eventTypes: string[];
};

/**
 * List distinct dimension keys (and count of distinct values) for event type(s).
 * Also returns which event types each dimension appears on.
 */
export async function queryDimensionKeys(
  db: Database,
  appId: string,
  params: DimensionsQueryParams,
): Promise<DimensionKey[]> {
  const conditions = [eq(events.appId, appId)];
  if (params.eventNames && params.eventNames.length > 0) {
    if (params.eventNames.length === 1) {
      conditions.push(eq(events.eventName, params.eventNames[0]));
    } else {
      conditions.push(inArray(events.eventName, params.eventNames));
    }
  }
  if (params.from) conditions.push(gte(events.timestamp, params.from));
  if (params.to) conditions.push(lte(events.timestamp, params.to));

  const rows = await db
    .select({
      dimKey: eventDimensions.dimKey,
      distinctValues: sql<number>`count(distinct ${eventDimensions.dimValue})`,
      eventTypesRaw: sql<string>`group_concat(distinct ${events.eventName})`,
    })
    .from(eventDimensions)
    .innerJoin(events, eq(eventDimensions.eventId, events.id))
    .where(and(...conditions))
    .groupBy(eventDimensions.dimKey)
    .orderBy(eventDimensions.dimKey);

  return rows.map((r) => ({
    dimKey: r.dimKey,
    distinctValues: Number(r.distinctValues),
    eventTypes: r.eventTypesRaw ? String(r.eventTypesRaw).split(",") : [],
  }));
}

export type BreakdownRow = {
  value: string;
  count: number;
};

/**
 * Single dimension breakdown: for a given event + dim_key, count events per dim_value.
 *
 * For array dimensions, uses json_each() to explode array elements so each
 * element is counted separately. Duplicate elements within a single array
 * are preserved (e.g. ["a","a"] counts "a" twice). Mixed scalar + array
 * values for the same dim_key are handled via UNION ALL.
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

  // Base conditions shared by both branches
  const baseConds = [
    sql`e.app_id = ${appId}`,
    sql`e.timestamp >= ${params.from}`,
    sql`e.timestamp <= ${params.to}`,
    sql`e.event_name = ${params.eventName}`,
    sql`d.dim_key = ${params.dimKey}`,
  ];
  if (eventIds !== null) {
    baseConds.push(
      sql`e.id IN (${sql.join(eventIds.map((id) => sql`${id}`), sql`, `)})`,
    );
  }

  const whereSql = sql.join(baseConds, sql` AND `);

  // UNION ALL: scalar values + exploded array values
  const query = sql`
    SELECT dim_value, SUM(cnt) AS count FROM (
      SELECT d.dim_value AS dim_value, COUNT(*) AS cnt
      FROM events e
      INNER JOIN event_dimensions d ON d.event_id = e.id
      WHERE ${whereSql} AND d.dim_type != 'array'
      GROUP BY d.dim_value

      UNION ALL

      SELECT je.value AS dim_value, COUNT(*) AS cnt
      FROM events e
      INNER JOIN event_dimensions d ON d.event_id = e.id,
      json_each(d.dim_value) je
      WHERE ${whereSql} AND d.dim_type = 'array'
      GROUP BY je.value
    )
    GROUP BY dim_value
    ORDER BY count DESC
    LIMIT ${params.limit}
  `;

  const rows = await db.all(query);
  return (rows as Array<{ dim_value: string; count: number }>).map((r) => ({
    value: String(r.dim_value),
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
 * Array dimensions are handled with CASE/json_each: for array-typed dims,
 * we LEFT JOIN json_each() to explode values. For scalars, we use dim_value
 * directly. This gives correct cross-tabulation with mixed scalar + array dims.
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

  // For each real dimension, we:
  // 1. INNER JOIN event_dimensions (aliased d0, d1, ...) to get the dim row
  // 2. LEFT JOIN json_each() (aliased je0, je1, ...) to explode arrays
  // 3. SELECT: COALESCE(je{i}.value, d{i}.dim_value) — uses exploded value for arrays, raw for scalars
  const selectParts: ReturnType<typeof sql>[] = [];
  if (hasEventNameDim) {
    selectParts.push(sql`e.event_name AS event_name_dim`);
  }
  selectParts.push(
    ...realDims.map(
      (_, i) =>
        sql`CASE WHEN ${sql.raw(`d${i}`)}.dim_type = 'array' THEN ${sql.raw(`je${i}`)}.value ELSE ${sql.raw(`d${i}`)}.dim_value END AS ${sql.raw(`dim${i}`)}`,
    ),
  );

  // Build JOINs
  const joinParts: ReturnType<typeof sql>[] = [];
  for (let i = 0; i < realDims.length; i++) {
    const dimKey = realDims[i];
    // INNER JOIN the dimension row
    joinParts.push(
      sql`INNER JOIN event_dimensions ${sql.raw(`d${i}`)} ON e.id = ${sql.raw(`d${i}`)}.event_id AND ${sql.raw(`d${i}`)}.dim_key = ${dimKey}`,
    );
    // LEFT JOIN json_each for array explosion (produces 1 row for scalars via CASE above)
    joinParts.push(
      sql`LEFT JOIN json_each(CASE WHEN ${sql.raw(`d${i}`)}.dim_type = 'array' THEN ${sql.raw(`d${i}`)}.dim_value ELSE NULL END) ${sql.raw(`je${i}`)}`,
    );
  }

  // Build GROUP BY
  const groupByParts: ReturnType<typeof sql>[] = [];
  if (hasEventNameDim) {
    groupByParts.push(sql.raw("e.event_name"));
  }
  groupByParts.push(
    ...realDims.map(
      (_, i) => sql.raw(`dim${i}`),
    ),
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

  // For scalar dims, json_each produces NULL — filter those out so scalars
  // still appear (the CASE handles it, but we also need to handle the case
  // where json_each produces no rows for scalar dims). We need: for array dims,
  // je{i}.value IS NOT NULL; for scalar dims, no constraint.
  // Actually, LEFT JOIN json_each(NULL) produces exactly 1 row with all NULLs,
  // which is correct — the CASE falls through to dim_value. No extra WHERE needed.

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
