import { useState, useEffect, useCallback, useRef } from "react";
import { queryApi, getSelectedAppId } from "./api-client";
import AppSelector from "./AppSelector";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Treemap,
  Cell,
} from "recharts";
import type {
  EventsQueryResponse,
  DimensionsQueryResponse,
  BreakdownQueryResponse,
  MatrixQueryResponse,
  MatrixRow,
  DimensionKey,
} from "./types";

// ── Helpers ─────────────────────────────────────────────────────────────────

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

type SortConfig = { column: string; direction: "asc" | "desc" };

const CHART_COLORS = [
  "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899",
  "#06b6d4", "#f97316", "#10b981", "#6366f1", "#f43e5e",
];

// ── FilterCombobox ──────────────────────────────────────────────────────────

function FilterCombobox({
  appId,
  eventName,
  dimKey,
  from,
  to,
  onSelect,
  onCancel,
}: {
  appId: string;
  eventName: string;
  dimKey: string;
  from: string;
  to: string;
  onSelect: (value: string) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<{ value: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await queryApi<BreakdownQueryResponse>(
          "/v1/query/breakdown",
          { app_id: appId, event_name: eventName, dim_key: dimKey, from, to, limit: "200" },
        );
        if (!cancelled) setValues(res.breakdown);
      } catch {
        if (!cancelled) setValues([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appId, eventName, dimKey, from, to]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onCancel();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onCancel]);

  const filtered = search
    ? values.filter((v) => v.value.toLowerCase().includes(search.toLowerCase()))
    : values;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onCancel();
    } else if (e.key === "Enter") {
      if (filtered.length === 1) {
        onSelect(filtered[0].value);
      } else if (search.trim()) {
        onSelect(search.trim());
      }
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`Search ${dimKey} values...`}
        className="w-full bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2.5 py-1.5 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
      />
      <div className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto rounded border border-gray-700 bg-gray-800 shadow-lg">
        {loading && (
          <div className="px-3 py-2 text-xs text-gray-500">Loading values...</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="px-3 py-2 text-xs text-gray-500">
            {search.trim() ? (
              <button
                onClick={() => onSelect(search.trim())}
                className="text-blue-400 hover:text-blue-300"
              >
                Use &ldquo;{search.trim()}&rdquo;
              </button>
            ) : (
              "No values found"
            )}
          </div>
        )}
        {!loading &&
          filtered.map((v) => (
            <button
              key={v.value}
              onClick={() => onSelect(v.value)}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors flex items-center justify-between"
            >
              <span className="font-mono text-gray-200 truncate">{v.value}</span>
              <span className="text-gray-500 tabular-nums shrink-0 ml-2">
                {v.count.toLocaleString()}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}

// ── Treemap custom content ──────────────────────────────────────────────────

function TreemapContent(props: {
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  value: number;
  index: number;
}) {
  const { x, y, width, height, name, value, index } = props;
  if (width < 4 || height < 4) return null;
  const fill = CHART_COLORS[index % CHART_COLORS.length];
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="#1f2937" strokeWidth={2} rx={4} opacity={0.85} />
      {width > 50 && height > 30 && (
        <>
          <text x={x + 6} y={y + 16} fill="#f3f4f6" fontSize={11} fontWeight={500}>
            {name.length > Math.floor(width / 7) ? name.slice(0, Math.floor(width / 7)) + "\u2026" : name}
          </text>
          <text x={x + 6} y={y + 30} fill="#9ca3af" fontSize={10}>
            {value.toLocaleString()}
          </text>
        </>
      )}
    </g>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

type ChartType = "bar" | "treemap";

export default function DimensionMatrix() {
  const [appId, setAppId] = useState<string | null>(getSelectedAppId());
  const [range, setRange] = useState(defaultRange);

  // Step 1: event list
  const [eventNames, setEventNames] = useState<string[]>([]);
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  // Step 2: available dimensions
  const [availableDims, setAvailableDims] = useState<DimensionKey[]>([]);
  const [selectedDims, setSelectedDims] = useState<string[]>([]);
  const [loadingDims, setLoadingDims] = useState(false);

  // Drag state for reordering selected dims
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  // Dimension picker sort order
  const [dimSort, setDimSort] = useState<"count-desc" | "count-asc" | "alpha-asc" | "alpha-desc">("count-desc");

  // Filters
  const [filters, setFilters] = useState<{ key: string; value: string }[]>([]);
  const [filterKey, setFilterKey] = useState("");
  const [showCombobox, setShowCombobox] = useState(false);

  // Step 3: matrix results
  const [matrix, setMatrix] = useState<MatrixRow[]>([]);
  const [loadingMatrix, setLoadingMatrix] = useState(false);
  const [sort, setSort] = useState<SortConfig>({ column: "count", direction: "desc" });

  // Chart
  const [chartType, setChartType] = useState<ChartType>("bar");

  const [error, setError] = useState<string | null>(null);

  const isoFrom = range.from + "T00:00:00Z";
  const isoTo = range.to + "T23:59:59Z";

  // ── Data fetching ───────────────────────────────────────────────────────

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
      if (names.length > 0 && selectedEvents.length === 0) {
        setSelectedEvents([names[0]]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoadingEvents(false);
    }
  }, [appId, isoFrom, isoTo]);

  const fetchDimensions = useCallback(async () => {
    if (!appId || selectedEvents.length === 0) return;
    setLoadingDims(true);
    setError(null);
    try {
      const res = await queryApi<DimensionsQueryResponse>(
        "/v1/query/dimensions",
        {
          app_id: appId,
          event_name: selectedEvents,
          from: isoFrom,
          to: isoTo,
        },
      );
      setAvailableDims(res.dimensions);
      setSelectedDims([]);
      setFilters([]);
      setMatrix([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoadingDims(false);
    }
  }, [appId, selectedEvents, isoFrom, isoTo]);

  // Always need at least 2 dimensions for cross-tabulation.
  // event_name counts as a dimension when selected.
  const minDims = 2;

  const fetchMatrix = useCallback(async () => {
    if (!appId || selectedEvents.length === 0 || selectedDims.length < minDims) {
      setMatrix([]);
      return;
    }
    setLoadingMatrix(true);
    setError(null);
    try {
      const params: Record<string, string | string[] | undefined> = {
        app_id: appId,
        event_name: selectedEvents.length === 1 ? selectedEvents[0] : selectedEvents,
        dimensions: selectedDims,
        from: isoFrom,
        to: isoTo,
      };
      if (filters.length > 0) {
        params.filter = filters.map((f) => `${f.key}:${f.value}`);
      }
      const res = await queryApi<MatrixQueryResponse>("/v1/query/matrix", params);
      setMatrix(res.matrix);
      setSort({ column: "count", direction: "desc" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoadingMatrix(false);
    }
  }, [appId, selectedEvents, selectedDims, minDims, filters, isoFrom, isoTo]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);
  useEffect(() => { fetchDimensions(); }, [fetchDimensions]);
  useEffect(() => { fetchMatrix(); }, [fetchMatrix]);

  // ── Handlers ────────────────────────────────────────────────────────────

  function toggleEvent(name: string) {
    setSelectedEvents((prev) =>
      prev.includes(name) ? prev.filter((e) => e !== name) : [...prev, name],
    );
  }

  function toggleDim(dimKey: string) {
    setSelectedDims((prev) =>
      prev.includes(dimKey) ? prev.filter((d) => d !== dimKey) : [...prev, dimKey],
    );
  }

  function addFilter(key: string, value: string) {
    if (!key || !value) return;
    if (filters.some((f) => f.key === key)) {
      setFilters((prev) => prev.map((f) => (f.key === key ? { key, value } : f)));
    } else {
      setFilters((prev) => [...prev, { key, value }]);
    }
    setFilterKey("");
    setShowCombobox(false);
  }

  function removeFilter(key: string) {
    setFilters((prev) => prev.filter((f) => f.key !== key));
  }

  // Dims available as filter targets: must be selected for cross-tab AND not already filtered
  const filterableDims = availableDims.filter(
    (d) => selectedDims.includes(d.dimKey) && !filters.some((f) => f.key === d.dimKey),
  );

  // When multiple events are selected, inject a virtual "event_name" dimension
  // so users can optionally group by event type (and drag it to control pivot order)
  const displayDims: DimensionKey[] = (() => {
    if (selectedEvents.length <= 1) return availableDims;
    const hasEventName = availableDims.some((d) => d.dimKey === "event_name");
    if (hasEventName) return availableDims;
    return [
      {
        dimKey: "event_name",
        distinctValues: selectedEvents.length,
        eventTypes: [...selectedEvents],
      },
      ...availableDims,
    ];
  })();

  // ── Drag reorder handlers ──────────────────────────────────────────────

  function handleDragStart(idx: number) {
    setDragIdx(idx);
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    setSelectedDims((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(idx, 0, moved);
      return next;
    });
    setDragIdx(idx);
  }

  function handleDragEnd() {
    setDragIdx(null);
  }

  // ── Sort ────────────────────────────────────────────────────────────────

  const sortedMatrix = [...matrix].sort((a, b) => {
    const aVal = a[sort.column];
    const bVal = b[sort.column];
    const aNum = typeof aVal === "number" ? aVal : String(aVal ?? "");
    const bNum = typeof bVal === "number" ? bVal : String(bVal ?? "");

    if (typeof aNum === "number" && typeof bNum === "number") {
      return sort.direction === "asc" ? aNum - bNum : bNum - aNum;
    }
    const cmp = String(aNum).localeCompare(String(bNum));
    return sort.direction === "asc" ? cmp : -cmp;
  });

  function handleSort(column: string) {
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "desc" },
    );
  }

  // Columns: selectedDims order is user-controlled (via drag reorder).
  // event_name is just another dimension when selected.
  const effectiveDims = selectedDims;
  const columns = [...effectiveDims, "count"];

  // ── Chart data ──────────────────────────────────────────────────────────

  const chartData = sortedMatrix.slice(0, 50).map((row) => ({
    name: effectiveDims.map((d) => String(row[d] ?? "")).join(" / "),
    count: Number(row.count),
  }));

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <AppSelector onAppSelected={(id) => setAppId(id)} />

      {/* Controls row */}
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
      </div>

      {/* Event selector chips */}
      {eventNames.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <h2 className="text-sm font-medium text-gray-300 mb-2">
            Select event{eventNames.length > 1 ? "s" : ""} to analyse
            {loadingEvents && (
              <span className="ml-2 text-gray-600 font-normal">loading...</span>
            )}
            {eventNames.length > 1 && (
              <span className="ml-2 text-xs font-normal">
                <button
                  onClick={() => setSelectedEvents([...eventNames])}
                  className="text-blue-400 hover:text-blue-300 transition-colors"
                >
                  all
                </button>
                <span className="text-gray-600 mx-1">/</span>
                <button
                  onClick={() => setSelectedEvents([])}
                  className="text-blue-400 hover:text-blue-300 transition-colors"
                >
                  none
                </button>
              </span>
            )}
          </h2>
          <div className="flex flex-wrap gap-2">
            {eventNames.map((name) => {
              const isSelected = selectedEvents.includes(name);
              return (
                <button
                  key={name}
                  onClick={() => toggleEvent(name)}
                  className={`rounded-full px-3 py-1 text-xs font-mono transition-colors ${
                    isSelected
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
                  }`}
                >
                  {name}
                </button>
              );
            })}
          </div>
          {selectedEvents.length === 0 && (
            <p className="text-xs text-yellow-500 mt-2">
              Select at least 1 event to continue.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loadingEvents && (
        <div className="text-sm text-gray-500">Loading events...</div>
      )}

      {!loadingEvents && eventNames.length === 0 && appId && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
          No events found for this time range.
        </div>
      )}

      {selectedEvents.length > 0 && (
        <div className="space-y-4">
          {/* ── Dimension selector chips ──────────────────────────────── */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium text-gray-300">
                Select dimensions to cross-tabulate
                {loadingDims && (
                  <span className="ml-2 text-gray-600 font-normal">loading...</span>
                )}
              </h2>
              {/* Sort controls */}
              <select
                value={dimSort}
                onChange={(e) => setDimSort(e.target.value as typeof dimSort)}
                className="rounded-md bg-gray-800 border border-gray-700 px-2 py-1 text-xs text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="count-desc">most events first</option>
                <option value="count-asc">fewest events first</option>
                <option value="alpha-asc">A → Z</option>
                <option value="alpha-desc">Z → A</option>
              </select>
            </div>
            {(() => {
              // Sort displayDims according to selected sort order
              const sortDims = (dims: DimensionKey[]) => {
                const sorted = [...dims];
                switch (dimSort) {
                  case "count-desc":
                    return sorted.sort((a, b) => b.distinctValues - a.distinctValues);
                  case "count-asc":
                    return sorted.sort((a, b) => a.distinctValues - b.distinctValues);
                  case "alpha-asc":
                    return sorted.sort((a, b) => a.dimKey.localeCompare(b.dimKey));
                  case "alpha-desc":
                    return sorted.sort((a, b) => b.dimKey.localeCompare(a.dimKey));
                  default:
                    return sorted;
                }
              };

              // Group dimensions by their event type(s)
              const groups = new Map<string, DimensionKey[]>();
              for (const dim of displayDims) {
                const key = dim.eventTypes.slice().sort().join(", ");
                const list = groups.get(key) ?? [];
                list.push(dim);
                groups.set(key, list);
              }
              // Sort groups: shared (multiple events) first, then alphabetically
              const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
                const aMulti = a.includes(",") ? 0 : 1;
                const bMulti = b.includes(",") ? 0 : 1;
                return aMulti - bMulti || a.localeCompare(b);
              });

              const renderChip = (dim: DimensionKey) => {
                const isSelected = selectedDims.includes(dim.dimKey);
                const isVirtual = dim.dimKey === "event_name";
                return (
                  <button
                    key={dim.dimKey}
                    onClick={() => toggleDim(dim.dimKey)}
                    className={`rounded-full px-3 py-1 text-xs font-mono transition-colors ${
                      isSelected
                        ? isVirtual
                          ? "bg-purple-600 text-white"
                          : "bg-blue-600 text-white"
                        : isVirtual
                          ? "bg-purple-900/40 text-purple-300 border border-purple-700/50 hover:bg-purple-800/40 hover:text-purple-200"
                          : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
                    }`}
                  >
                    {dim.dimKey}
                    <span className={`ml-1 font-sans ${isVirtual ? "text-purple-400" : "text-gray-500"}`}>
                      ({dim.distinctValues})
                    </span>
                  </button>
                );
              };

              // If only one event or one group, render flat (no group labels)
              if (sortedGroups.length <= 1) {
                return (
                  <div className="flex flex-wrap gap-2">
                    {sortDims(displayDims).map(renderChip)}
                  </div>
                );
              }

              return (
                <div className="space-y-3">
                  {sortedGroups.map(([groupLabel, dims]) => (
                    <div key={groupLabel}>
                      <p className="text-xs text-gray-500 mb-1.5 font-sans">
                        {groupLabel}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {sortDims(dims).map(renderChip)}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
            {selectedDims.length > 0 && selectedDims.length < minDims && (
              <p className="text-xs text-yellow-500 mt-2">
                Select at least {minDims} dimension{minDims > 1 ? "s" : ""} to generate the matrix.
              </p>
            )}

            {/* ── Pivot order strip (drag to reorder) ───────────────── */}
            {selectedDims.length >= 2 && (
              <div className="mt-3 pt-3 border-t border-gray-800">
                <p className="text-xs text-gray-500 mb-2 font-sans">
                  Pivot order <span className="text-gray-600">— drag to reorder</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  {selectedDims.map((dimKey, idx) => {
                    const isVirtual = dimKey === "event_name";
                    return (
                      <div
                        key={dimKey}
                        draggable
                        onDragStart={() => handleDragStart(idx)}
                        onDragOver={(e) => handleDragOver(e, idx)}
                        onDragEnd={handleDragEnd}
                        className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-mono cursor-grab active:cursor-grabbing select-none transition-colors ${
                          dragIdx === idx
                            ? "ring-1 ring-blue-400 opacity-60"
                            : ""
                        } ${
                          isVirtual
                            ? "bg-purple-600/30 text-purple-200 border border-purple-700/50"
                            : "bg-blue-600/30 text-blue-200 border border-blue-700/50"
                        }`}
                      >
                        <span className="text-gray-500 cursor-grab" title="Drag to reorder">
                          &#x2630;
                        </span>
                        <span className="text-gray-500 font-sans text-[10px] tabular-nums w-3 text-center">
                          {idx + 1}
                        </span>
                        {dimKey}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── Filters ──────────────────────────────────────────────── */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 className="text-sm font-medium text-gray-300 mb-2">
              Filters
              <span className="ml-2 text-gray-600 font-normal text-xs">
                narrow results before cross-tabulation
              </span>
            </h2>

            {/* Active filters */}
            {filters.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {filters.map((f) => (
                  <span
                    key={f.key}
                    className="inline-flex items-center gap-1.5 rounded-full bg-yellow-600/20 text-yellow-300 border border-yellow-800/50 px-3 py-1 text-xs font-mono"
                  >
                    {f.key}={f.value}
                    <button
                      onClick={() => removeFilter(f.key)}
                      className="hover:text-yellow-100 transition-colors"
                      aria-label={`Remove ${f.key} filter`}
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Add filter */}
            {filterableDims.length === 0 && filters.length === 0 && (
              <p className="text-xs text-gray-500">
                Select dimensions above to use them as filters.
              </p>
            )}

            {filterableDims.length > 0 && (
              <div className="flex items-start gap-2">
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    value={filterKey}
                    onChange={(e) => {
                      setFilterKey(e.target.value);
                      setShowCombobox(!!e.target.value);
                    }}
                    className="rounded-md bg-gray-800 border border-gray-700 px-2 py-1.5 text-xs text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">dimension...</option>
                    {filterableDims.map((dim) => (
                      <option key={dim.dimKey} value={dim.dimKey}>
                        {dim.dimKey} ({dim.distinctValues})
                      </option>
                    ))}
                  </select>
                  <span className="text-gray-600 text-xs">=</span>
                </div>

                {showCombobox && filterKey && appId && selectedEvents.length > 0 ? (
                  <div className="w-64">
                    <FilterCombobox
                      appId={appId}
                      eventName={selectedEvents[0]}
                      dimKey={filterKey}
                      from={isoFrom}
                      to={isoTo}
                      onSelect={(value) => addFilter(filterKey, value)}
                      onCancel={() => {
                        setFilterKey("");
                        setShowCombobox(false);
                      }}
                    />
                  </div>
                ) : (
                  <span className="text-xs text-gray-500 py-1.5">select a dimension</span>
                )}
              </div>
            )}
          </div>

          {/* ── Matrix results ────────────────────────────────────────── */}
          {loadingMatrix && (
            <div className="text-sm text-gray-500">Loading matrix...</div>
          )}

          {selectedDims.length >= minDims && !loadingMatrix && matrix.length === 0 && (() => {
            // Detect cross-event-type dimension selection:
            // If no single event type contains all selected dims, explain why results are empty.
            const selectedDimMetas = availableDims.filter((d) => selectedDims.includes(d.dimKey));
            const allEventTypes = new Set(selectedDimMetas.flatMap((d) => d.eventTypes));
            const sharedEventType = [...allEventTypes].some((et) =>
              selectedDimMetas.every((d) => d.eventTypes.includes(et)),
            );
            return (
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
                {!sharedEventType ? (
                  <>
                    <p className="mb-2">No results — the selected dimensions come from different event types.</p>
                    <p className="text-xs text-gray-600">
                      Cross-tabulation requires dimensions that co-occur on the same event.
                      Try selecting dimensions that belong to a common event type.
                    </p>
                  </>
                ) : (
                  "No results for this combination."
                )}
              </div>
            );
          })()}

          {sortedMatrix.length > 0 && (
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
              {/* Header row */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-sm font-medium text-gray-300">
                  Matrix: {effectiveDims.map((d) => (
                    <code key={d} className="text-blue-300 text-xs mx-0.5">{d}</code>
                  ))}
                  <span className="text-gray-500 ml-2 font-normal text-xs">
                    ({sortedMatrix.length} row{sortedMatrix.length !== 1 ? "s" : ""})
                  </span>
                </h2>

                {/* Chart type picker */}
                <div className="flex rounded-md bg-gray-800 p-0.5">
                  {([
                    ["bar", "Bar chart"],
                    ["treemap", "Treemap"],
                  ] as [ChartType, string][]).map(([type, label]) => (
                    <button
                      key={type}
                      onClick={() => setChartType(type)}
                      className={`px-2.5 py-0.5 text-xs rounded transition-colors ${
                        chartType === type
                          ? "bg-gray-700 text-gray-100"
                          : "text-gray-400 hover:text-gray-300"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Bar chart ──────────────────────────────────────────── */}
              {chartType === "bar" && chartData.length > 0 && (
                <div style={{ height: Math.max(300, chartData.length * 28 + 40) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                      <XAxis type="number" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={{ stroke: "#374151" }} tickLine={false} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={180}
                        tick={{ fill: "#d1d5db", fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: 8, fontSize: 12 }}
                        labelStyle={{ color: "#f3f4f6" }}
                        itemStyle={{ color: "#9ca3af" }}
                        cursor={{ fill: "rgba(55, 65, 81, 0.3)" }}
                      />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                        {chartData.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* ── Treemap ────────────────────────────────────────────── */}
              {chartType === "treemap" && chartData.length > 0 && (
                <div style={{ height: 400 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <Treemap
                      data={chartData}
                      dataKey="count"
                      nameKey="name"
                      isAnimationActive={false}
                      content={<TreemapContent x={0} y={0} width={0} height={0} name="" value={0} index={0} />}
                    />
                  </ResponsiveContainer>
                </div>
              )}

              {/* ── Table ──────────────────────────────────────────────── */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-left">
                      {columns.map((col) => (
                        <th
                          key={col}
                          onClick={() => handleSort(col)}
                          className={`pb-2 font-medium cursor-pointer hover:text-gray-200 transition-colors ${
                            col === "count" ? "text-right" : ""
                          } ${
                            sort.column === col ? "text-blue-400" : "text-gray-500"
                          }`}
                        >
                          {col === "count" ? "Count" : col}
                          {sort.column === col && (
                            <span className="ml-1">
                              {sort.direction === "asc" ? "\u2191" : "\u2193"}
                            </span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {sortedMatrix.map((row, i) => (
                      <tr key={i} className="text-gray-300 hover:bg-gray-800/30">
                        {columns.map((col) => (
                          <td
                            key={col}
                            className={`py-1.5 ${
                              col === "count"
                                ? "text-right tabular-nums"
                                : "font-mono text-xs"
                            }`}
                          >
                            {col === "count"
                              ? Number(row[col]).toLocaleString()
                              : String(row[col] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
