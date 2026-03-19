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
import {
  defaultRange,
  toISORange,
  extractError,
  ErrorBanner,
  LoadingText,
  DateRangePicker,
  CHART_TOOLTIP_PROPS,
} from "./shared";
import type {
  EventsQueryResponse,
  DimensionsQueryResponse,
  BreakdownQueryResponse,
  DimensionKey,
  BreakdownRow,
} from "./types";

export default function EventExplorer() {
  const [appId, setAppId] = useState<string | null>(getSelectedAppId());
  const [range, setRange] = useState(() => defaultRange(30));

  // Step 1: event list
  const [eventNames, setEventNames] = useState<string[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);

  // Step 2: dimensions for selected event
  const [dimensions, setDimensions] = useState<DimensionKey[]>([]);
  const [selectedDim, setSelectedDim] = useState<string | null>(null);
  const [loadingDims, setLoadingDims] = useState(false);

  // Step 3: breakdown for selected dimension
  const [breakdown, setBreakdown] = useState<BreakdownRow[]>([]);
  const [loadingBreakdown, setLoadingBreakdown] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const { isoFrom, isoTo } = toISORange(range);

  // Fetch event names (using the top events endpoint)
  const fetchEvents = useCallback(async () => {
    if (!appId) return;
    setLoadingEvents(true);
    setError(null);
    try {
      const res = await queryApi<EventsQueryResponse>("/v1/query/events", {
        app_id: appId,
        from: isoFrom,
        to: isoTo,
        granularity: "day",
      });
      const names = res.top_events.map((e) => e.eventName);
      setEventNames(names);
      // Auto-select first event if none selected
      if (names.length > 0 && !selectedEvent) {
        setSelectedEvent(names[0]);
      }
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoadingEvents(false);
    }
  }, [appId, isoFrom, isoTo]);

  // Fetch dimensions for selected event
  const fetchDimensions = useCallback(async () => {
    if (!appId || !selectedEvent) return;
    setLoadingDims(true);
    setError(null);
    try {
      const res = await queryApi<DimensionsQueryResponse>(
        "/v1/query/dimensions",
        {
          app_id: appId,
          event_name: selectedEvent,
          from: isoFrom,
          to: isoTo,
        },
      );
      setDimensions(res.dimensions);
      setSelectedDim(null);
      setBreakdown([]);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoadingDims(false);
    }
  }, [appId, selectedEvent, isoFrom, isoTo]);

  // Fetch breakdown for selected dimension
  const fetchBreakdown = useCallback(async () => {
    if (!appId || !selectedEvent || !selectedDim) return;
    setLoadingBreakdown(true);
    setError(null);
    try {
      const res = await queryApi<BreakdownQueryResponse>(
        "/v1/query/breakdown",
        {
          app_id: appId,
          event_name: selectedEvent,
          dim_key: selectedDim,
          from: isoFrom,
          to: isoTo,
        },
      );
      setBreakdown(res.breakdown);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoadingBreakdown(false);
    }
  }, [appId, selectedEvent, selectedDim, isoFrom, isoTo]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    fetchDimensions();
  }, [fetchDimensions]);

  useEffect(() => {
    fetchBreakdown();
  }, [fetchBreakdown]);

  return (
    <div className="space-y-6">
      <AppSelector onAppSelected={(id) => setAppId(id)} />

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <DateRangePicker range={range} onChange={setRange} />
        {eventNames.length > 0 && (
          <select
            value={selectedEvent ?? ""}
            onChange={(e) => setSelectedEvent(e.target.value)}
            className="rounded-md bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {eventNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      {loadingEvents && <LoadingText label="Loading events..." />}

      {!loadingEvents && eventNames.length === 0 && appId && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
          No events found for this time range.
        </div>
      )}

      {/* Two-column layout: dimensions list + breakdown */}
      {selectedEvent && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Dimension list */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 className="text-sm font-medium text-gray-300 mb-3">
              Dimensions
              {loadingDims && (
                <span className="ml-2 text-gray-600 font-normal">
                  loading...
                </span>
              )}
            </h2>
            {dimensions.length === 0 && !loadingDims && (
              <p className="text-xs text-gray-600">No dimensions found.</p>
            )}
            <ul className="space-y-0.5">
              {dimensions.map((dim) => (
                <li key={dim.dimKey}>
                  <button
                    onClick={() => setSelectedDim(dim.dimKey)}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
                      selectedDim === dim.dimKey
                        ? "bg-blue-600/20 text-blue-300"
                        : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                    }`}
                  >
                    <span className="font-mono text-xs">{dim.dimKey}</span>
                    <span className="text-gray-600 ml-1 text-xs">
                      ({dim.distinctValues})
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Breakdown view */}
          <div className="md:col-span-2 rounded-lg border border-gray-800 bg-gray-900 p-4">
            {!selectedDim && (
              <p className="text-sm text-gray-500">
                Select a dimension to see its breakdown.
              </p>
            )}

            {selectedDim && loadingBreakdown && (
              <div className="text-sm text-gray-500">Loading breakdown...</div>
            )}

            {selectedDim && !loadingBreakdown && breakdown.length === 0 && (
              <p className="text-sm text-gray-500">
                No values found for{" "}
                <code className="text-gray-400">{selectedDim}</code>.
              </p>
            )}

            {selectedDim && breakdown.length > 0 && (
              <>
                <h2 className="text-sm font-medium text-gray-300 mb-3">
                  <code className="text-blue-300 text-xs">{selectedDim}</code>{" "}
                  breakdown
                </h2>

                {/* Horizontal bar chart */}
                <ResponsiveContainer width="100%" height={Math.max(200, breakdown.length * 32)}>
                  <BarChart
                    data={breakdown.map((r) => ({
                      value: r.value.length > 30 ? r.value.slice(0, 27) + "..." : r.value,
                      count: r.count,
                    }))}
                    layout="vertical"
                    margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
                    <XAxis
                      type="number"
                      tick={{ fill: "#9CA3AF", fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: "#374151" }}
                      allowDecimals={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="value"
                      tick={{ fill: "#9CA3AF", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={140}
                    />
                    <Tooltip {...CHART_TOOLTIP_PROPS} />
                    <Bar dataKey="count" fill="#3B82F6" radius={[0, 2, 2, 0]} />
                  </BarChart>
                </ResponsiveContainer>

                {/* Table below the chart */}
                <table className="w-full text-sm mt-4">
                  <thead>
                    <tr className="border-b border-gray-800 text-left text-gray-500">
                      <th className="pb-2 font-medium">Value</th>
                      <th className="pb-2 font-medium text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {breakdown.map((row) => (
                      <tr key={row.value} className="text-gray-300">
                        <td className="py-1.5 font-mono text-xs">
                          {row.value}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {row.count.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
