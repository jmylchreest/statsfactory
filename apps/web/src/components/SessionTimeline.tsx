import { useState, useEffect, useCallback } from "react";
import { queryApi, getSelectedAppId } from "./api-client";
import AppSelector from "./AppSelector";
import type {
  SessionsQueryResponse,
  SessionSummary,
  SessionTimelineResponse,
  SessionTimelineEvent,
} from "./types";

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimestamp(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function durationBetween(first: string, last: string): string {
  const ms = new Date(last).getTime() - new Date(first).getTime();
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}

/** Event type color based on hash of event name */
function eventColor(name: string): string {
  const colors = [
    "text-blue-300",
    "text-green-300",
    "text-yellow-300",
    "text-purple-300",
    "text-pink-300",
    "text-cyan-300",
    "text-orange-300",
    "text-emerald-300",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

const LIMIT_PRESETS = [10, 25, 50, 100] as const;
const ALL_LIMIT = 1000; // backend MAX_LIMIT
const DEFAULT_SESSION_LIMIT = 25;

type TimeRange = "24h" | "7d" | "30d" | "all";
const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
  { value: "all", label: "All time" },
];

function timeRangeToDates(range: TimeRange): { from?: string; to?: string } {
  if (range === "all") return {};
  const now = new Date();
  const to = now.toISOString();
  const ms = { "24h": 86400_000, "7d": 604800_000, "30d": 2592000_000 }[range];
  const from = new Date(now.getTime() - ms).toISOString();
  return { from, to };
}

export default function SessionTimeline() {
  const [appId, setAppId] = useState<string | null>(getSelectedAppId());
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<SessionTimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [limit, setLimit] = useState(DEFAULT_SESSION_LIMIT);
  const [timeRange, setTimeRange] = useState<TimeRange>("7d");
  const [search, setSearch] = useState("");

  const fetchSessions = useCallback(async () => {
    if (!appId) return;
    setLoading(true);
    setError(null);
    try {
      const { from, to } = timeRangeToDates(timeRange);
      const params: Record<string, string> = {
        app_id: appId,
        limit: String(limit),
      };
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await queryApi<SessionsQueryResponse>("/v1/query/sessions", params);
      setSessions(res.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [appId, limit, timeRange]);

  const filteredSessions = search
    ? sessions.filter((s) =>
        s.session_id.toLowerCase().includes(search.toLowerCase()),
      )
    : sessions;

  const fetchTimeline = useCallback(
    async (sessionId: string) => {
      if (!appId) return;
      setTimelineLoading(true);
      setError(null);
      try {
        const res = await queryApi<SessionTimelineResponse>(
          `/v1/query/sessions/${encodeURIComponent(sessionId)}`,
          { app_id: appId },
        );
        setTimelineEvents(res.events);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setTimelineLoading(false);
      }
    },
    [appId],
  );

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (selectedSession) {
      fetchTimeline(selectedSession);
    } else {
      setTimelineEvents([]);
    }
  }, [selectedSession, fetchTimeline]);

  const handleAppSelected = useCallback((id: string) => {
    setAppId(id);
    setSelectedSession(null);
    setTimelineEvents([]);
  }, []);

  return (
    <div className="space-y-4">
      <AppSelector onAppSelected={handleAppSelected} />

      {error && (
        <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Use 5-col grid: 2 for list, 3 for timeline. When no session selected, list takes full width */}
      <div className={`grid grid-cols-1 gap-4 ${selectedSession ? "lg:grid-cols-5" : ""}`}>
        {/* Session list */}
        <div className={selectedSession ? "lg:col-span-2" : ""}>
          <div className="rounded-lg border border-gray-800 bg-gray-900">
            <div className="px-4 py-3 border-b border-gray-800 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-gray-300">Sessions</h3>
                {loading && (
                  <span className="text-xs text-gray-600">loading...</span>
                )}
                {!loading && sessions.length > 0 && (
                  <span className="text-xs text-gray-500">
                    {search && filteredSessions.length !== sessions.length
                      ? `${filteredSessions.length} of ${sessions.length}`
                      : sessions.length}{" "}
                    session{(search ? filteredSessions.length : sessions.length) !== 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {/* Search + filters */}
              <div className="space-y-1.5">
                {/* Session ID search */}
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by session ID..."
                  className="w-full bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2.5 py-1.5 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                />

                {/* Time range + limit row */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="flex rounded-md bg-gray-800 p-0.5">
                    {TIME_RANGES.map((r) => (
                      <button
                        key={r.value}
                        onClick={() => setTimeRange(r.value)}
                        className={`px-2 py-0.5 text-xs rounded transition-colors ${
                          timeRange === r.value
                            ? "bg-gray-700 text-gray-100"
                            : "text-gray-400 hover:text-gray-300"
                        }`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>

                  <span className="text-gray-700">|</span>

                  <div className="flex items-center gap-1">
                    <div className="flex rounded-md bg-gray-800 p-0.5">
                      {LIMIT_PRESETS.map((n) => (
                        <button
                          key={n}
                          onClick={() => setLimit(n)}
                          className={`px-1.5 py-0.5 text-xs rounded transition-colors tabular-nums ${
                            limit === n
                              ? "bg-gray-700 text-gray-100"
                              : "text-gray-400 hover:text-gray-300"
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                      <button
                        onClick={() => setLimit(ALL_LIMIT)}
                        className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
                          limit === ALL_LIMIT
                            ? "bg-gray-700 text-gray-100"
                            : "text-gray-400 hover:text-gray-300"
                        }`}
                      >
                        All
                      </button>
                    </div>
                    <input
                      type="number"
                      min={1}
                      max={ALL_LIMIT}
                      value={limit === ALL_LIMIT ? "" : limit}
                      placeholder="n"
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (!isNaN(v) && v >= 1) setLimit(Math.min(v, ALL_LIMIT));
                      }}
                      className="w-12 bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-1.5 py-0.5 text-center tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                </div>
              </div>
            </div>

            {filteredSessions.length === 0 && !loading && appId && (
              <div className="p-6 text-center text-sm text-gray-500">
                {search
                  ? `No sessions matching "${search}"`
                  : "No sessions found. Sessions appear when events include a session_id."}
              </div>
            )}

            {filteredSessions.length > 0 && (
              <div className="divide-y divide-gray-800/50 max-h-[600px] overflow-y-auto">
                {filteredSessions.map((s) => (
                  <button
                    key={s.session_id}
                    onClick={() =>
                      setSelectedSession(
                        selectedSession === s.session_id ? null : s.session_id,
                      )
                    }
                    className={`w-full text-left px-4 py-3 transition-colors ${
                      selectedSession === s.session_id
                        ? "bg-blue-900/20 border-l-2 border-blue-500"
                        : "hover:bg-gray-800/50 border-l-2 border-transparent"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-gray-300 truncate max-w-[160px]">
                        {s.session_id}
                      </span>
                      <span className="text-xs text-gray-500 tabular-nums shrink-0">
                        {timeAgo(s.last_event)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                      <span>
                        {s.event_count} event{s.event_count !== 1 ? "s" : ""}
                      </span>
                      <span className="text-gray-700">|</span>
                      <span>{durationBetween(s.first_event, s.last_event)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.event_types.slice(0, 4).map((t) => (
                        <span
                          key={t}
                          className="inline-block rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-400"
                        >
                          {t}
                        </span>
                      ))}
                      {s.event_types.length > 4 && (
                        <span className="text-xs text-gray-600">
                          +{s.event_types.length - 4}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Timeline view (right panel) — only rendered when a session is selected */}
        {selectedSession && (
        <div className="lg:col-span-3">
          {timelineLoading && (
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center text-sm text-gray-500">
              Loading timeline...
            </div>
          )}

          {!timelineLoading && timelineEvents.length > 0 && (
            <div className="rounded-lg border border-gray-800 bg-gray-900">
              <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-gray-300">
                    Timeline
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5 font-mono">
                    {selectedSession}
                  </p>
                </div>
                <span className="text-xs text-gray-500">
                  {timelineEvents.length} event
                  {timelineEvents.length !== 1 ? "s" : ""}
                  {timelineEvents.length >= 2 && (
                    <>
                      {" "}
                      &middot;{" "}
                      {durationBetween(
                        timelineEvents[0].timestamp,
                        timelineEvents[timelineEvents.length - 1].timestamp,
                      )}
                    </>
                  )}
                </span>
              </div>

              {/* Timeline */}
              <div className="relative px-4 py-3">
                {/* Vertical line — centered on the dots (px-4=16px + half of w-2.5=5px = 21px) */}
                {/* Starts at first dot center, ends at last dot center */}
                {timelineEvents.length > 1 && (
                  <div className="absolute left-[20.5px] top-[22px] bottom-[14px] w-px bg-gray-700" />
                )}

                <div className="space-y-0">
                  {(() => {
                    // Pre-compute batch info: group events by created_at
                    const batchCounters = new Map<string, { total: number; seen: number }>();
                    for (const ev of timelineEvents) {
                      const existing = batchCounters.get(ev.created_at);
                      if (existing) {
                        existing.total++;
                      } else {
                        batchCounters.set(ev.created_at, { total: 0, seen: 0 });
                        batchCounters.get(ev.created_at)!.total = 1;
                      }
                    }
                    // Only show batch labels when a batch has >1 event
                    const batchInfo = (ev: typeof timelineEvents[number]) => {
                      const b = batchCounters.get(ev.created_at)!;
                      if (b.total <= 1) return null;
                      b.seen++;
                      return { index: b.seen, total: b.total };
                    };

                    return timelineEvents.map((ev, idx) => {
                      const isExpanded = expandedEventId === ev.id;
                      const dimEntries = Object.entries(ev.dimensions);
                      const isFirst = idx === 0;
                      const timeDelta =
                        idx > 0
                          ? durationBetween(
                              timelineEvents[idx - 1].timestamp,
                              ev.timestamp,
                            )
                          : null;
                      const batch = batchInfo(ev);

                      return (
                        <div key={ev.id}>
                          <button
                            onClick={() =>
                              setExpandedEventId(isExpanded ? null : ev.id)
                            }
                            className="w-full text-left flex items-start gap-3 py-1.5 relative group"
                          >
                            {/* Dot on timeline */}
                            <div
                              className={`relative z-10 mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${
                                isFirst
                                  ? "bg-blue-500 ring-2 ring-blue-500/30"
                                  : "bg-gray-600 group-hover:bg-gray-400"
                              }`}
                            />

                            {/* Event details */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`font-mono text-xs font-medium ${eventColor(ev.event_name)}`}
                                >
                                  {ev.event_name}
                                </span>
                                <span className="text-xs text-gray-500 tabular-nums">
                                  {formatTimestamp(ev.timestamp)}
                                </span>
                                {dimEntries.length > 0 && (
                                  <span className="text-xs text-gray-600">
                                    {dimEntries.length} dim
                                    {dimEntries.length !== 1 ? "s" : ""}
                                  </span>
                                )}
                                {timeDelta !== null && (
                                  <span className="text-xs text-gray-600 font-mono tabular-nums">
                                    +{timeDelta}
                                  </span>
                                )}
                                {batch && (
                                  <span className="text-xs text-gray-600 font-mono tabular-nums">
                                    {batch.index}/{batch.total}
                                  </span>
                                )}
                                <svg
                                  className={`w-3 h-3 text-gray-600 transition-transform ml-auto ${
                                    isExpanded ? "rotate-180" : ""
                                  }`}
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 9l-7 7-7-7"
                                  />
                                </svg>
                              </div>
                            </div>
                          </button>

                        {/* Expanded dimensions */}
                        {isExpanded && dimEntries.length > 0 && (
                          <div className="ml-[22px] pl-3 pb-2 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1">
                            {dimEntries.map(([key, value]) => (
                              <div key={key} className="text-xs">
                                <span className="text-gray-500">{key}:</span>{" "}
                                <span className="text-gray-300 font-mono">
                                  {value}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {isExpanded && dimEntries.length === 0 && (
                          <p className="ml-[22px] pl-3 pb-2 text-xs text-gray-600">
                            No dimensions.
                          </p>
                        )}
                      </div>
                    );
                  });
                  })()}
                </div>
              </div>
            </div>
          )}

          {!timelineLoading &&
            timelineEvents.length === 0 && (
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center text-sm text-gray-500">
                No events found for this session.
              </div>
            )}
        </div>
        )}
      </div>
    </div>
  );
}
