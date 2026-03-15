import { useState, useEffect, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { queryApi, getSelectedAppId } from "./api-client";
import AppSelector from "./AppSelector";
import type { EventsQueryResponse } from "./types";

/** Format ISO date as short label for chart axis. */
function formatBucket(bucket: string, granularity: string): string {
  if (granularity === "hour") {
    // "2026-03-14T10" → "Mar 14 10:00"
    const d = new Date(bucket + ":00:00Z");
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
  }
  // "2026-03-14" → "Mar 14"
  const d = new Date(bucket + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Compute default date range: last 7 days. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

type Granularity = "hour" | "day";

export default function Overview() {
  const [appId, setAppId] = useState<string | null>(getSelectedAppId());
  const [range, setRange] = useState(defaultRange);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [data, setData] = useState<EventsQueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!appId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await queryApi<EventsQueryResponse>("/v1/query/events", {
        app_id: appId,
        from: range.from + "T00:00:00Z",
        to: range.to + "T23:59:59Z",
        granularity,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [appId, range, granularity]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="space-y-6">
      <AppSelector onAppSelected={(id) => setAppId(id)} />

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-gray-400">
          From
          <input
            type="date"
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            className="ml-2 rounded-md bg-gray-800 border border-gray-700 px-2 py-1 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <label className="text-sm text-gray-400">
          To
          <input
            type="date"
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            className="ml-2 rounded-md bg-gray-800 border border-gray-700 px-2 py-1 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <select
          value={granularity}
          onChange={(e) => setGranularity(e.target.value as Granularity)}
          className="rounded-md bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="day">Daily</option>
          <option value="hour">Hourly</option>
        </select>
      </div>

      {/* Loading / error states */}
      {loading && (
        <div className="text-sm text-gray-500">Loading...</div>
      )}
      {error && (
        <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Time-series chart */}
      {data && data.time_series.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Event Count</h2>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={data.time_series.map((b) => ({
                label: formatBucket(b.bucket, granularity),
                count: b.count,
              }))}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="label"
                tick={{ fill: "#9CA3AF", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "#374151" }}
              />
              <YAxis
                tick={{ fill: "#9CA3AF", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1F2937",
                  border: "1px solid #374151",
                  borderRadius: "0.375rem",
                  fontSize: "0.75rem",
                }}
                labelStyle={{ color: "#D1D5DB" }}
                itemStyle={{ color: "#60A5FA" }}
                cursor={{ fill: "rgba(55, 65, 81, 0.3)" }}
              />
              <Bar dataKey="count" fill="#3B82F6" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {data && data.time_series.length === 0 && !loading && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
          No events found for this time range.
        </div>
      )}

      {/* Top events table */}
      {data && data.top_events.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Top Events</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-gray-500">
                <th className="pb-2 font-medium">Event</th>
                <th className="pb-2 font-medium text-right">Count</th>
                <th className="pb-2 font-medium text-right w-48">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {data.top_events.map((ev) => {
                const maxCount = data.top_events[0]?.count ?? 1;
                const pct = maxCount > 0 ? (ev.count / maxCount) * 100 : 0;
                return (
                  <tr key={ev.eventName} className="text-gray-300">
                    <td className="py-2 font-mono text-xs">{ev.eventName}</td>
                    <td className="py-2 text-right tabular-nums">
                      {ev.count.toLocaleString()}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-32 rounded-full bg-gray-800 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-blue-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
