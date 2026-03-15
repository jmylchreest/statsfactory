/**
 * Dashboard API response types, matching the query route JSON shapes.
 */

export interface TimeSeriesBucket {
  bucket: string;
  count: number;
}

export interface TopEvent {
  eventName: string;
  count: number;
}

export interface EventsQueryResponse {
  time_series: TimeSeriesBucket[];
  top_events: TopEvent[];
  meta: {
    from: string;
    to: string;
    granularity: string;
    event_name: string | null;
    filters: { key: string; value: string }[];
  };
}

export interface DimensionKey {
  dimKey: string;
  distinctValues: number;
}

export interface DimensionsQueryResponse {
  dimensions: DimensionKey[];
  meta: {
    event_name: string | null;
    from: string | null;
    to: string | null;
  };
}

export interface BreakdownRow {
  value: string;
  count: number;
}

export interface BreakdownQueryResponse {
  breakdown: BreakdownRow[];
  meta: {
    event_name: string;
    dim_key: string;
    from: string;
    to: string;
    filters: { key: string; value: string }[];
    limit: number;
  };
}

export interface MatrixRow {
  [key: string]: string | number;
  count: number;
}

export interface MatrixQueryResponse {
  matrix: MatrixRow[];
  meta: {
    event_name: string;
    dimensions: string[];
    from: string;
    to: string;
    filters: { key: string; value: string }[];
    limit: number;
  };
}

export interface SessionSummary {
  session_id: string;
  event_count: number;
  first_event: string;
  last_event: string;
  event_types: string[];
}

export interface SessionsQueryResponse {
  sessions: SessionSummary[];
  meta: {
    from: string | null;
    to: string | null;
    limit: number;
  };
}

export interface SessionTimelineEvent {
  id: string;
  event_name: string;
  timestamp: string;
  dimensions: Record<string, string>;
}

export interface SessionTimelineResponse {
  session_id: string;
  events: SessionTimelineEvent[];
  meta: {
    event_count: number;
  };
}
