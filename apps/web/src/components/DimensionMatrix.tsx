import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
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
import { dimColorHex } from "./dim-color";
import {
  defaultRange,
  toISORange,
  extractError,
  ErrorBanner,
  LoadingText,
  DateRangePicker,
  ControlBar,
  ControlDivider,
  CHART_TOOLTIP_PROPS,
} from "./shared";
import type {
  EventsQueryResponse,
  DimensionsQueryResponse,
  BreakdownQueryResponse,
  MatrixQueryResponse,
  MatrixTrendQueryResponse,
  MatrixTrendRow,
  MatrixRow,
  DimensionKey,
} from "./types";

const DonutClusterMap = lazy(() => import("./DonutClusterMap"));

type SortConfig = { column: string; direction: "asc" | "desc" };
type Aggregation = "count" | "sum" | "avg" | "min" | "max";
type ChartType = "bar" | "treemap" | "map";

const AGGREGATION_LABELS: Record<Aggregation, string> = {
  count: "Count", sum: "Sum", avg: "Avg", min: "Min", max: "Max",
};

const CHART_COLORS = [
  "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899",
  "#06b6d4", "#f97316", "#10b981", "#6366f1", "#f43e5e",
];

// ── Sparkline ───────────────────────────────────────────────────────────────

function Sparkline({ data }: { data: { count: number }[] }) {
  if (data.length < 2) return <span className="text-gray-600 text-xs">—</span>;
  const max = Math.max(...data.map((d) => d.count));
  const min = Math.min(...data.map((d) => d.count));
  const range = max - min || 1;
  const W = 80, H = 22, PAD = 2;
  const points = data
    .map((d, i) => {
      const x = PAD + (i / (data.length - 1)) * (W - 2 * PAD);
      const y = H - PAD - ((d.count - min) / range) * (H - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={W} height={H} className="overflow-visible">
      <polyline points={points} fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── TreemapContent ──────────────────────────────────────────────────────────

function TreemapContent(props: { x: number; y: number; width: number; height: number; name: string; value: number; index: number }) {
  const { x, y, width, height, name, value, index } = props;
  if (width < 4 || height < 4) return null;
  const fill = CHART_COLORS[index % CHART_COLORS.length];
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="#1f2937" strokeWidth={2} rx={4} opacity={0.85} />
      {width > 50 && height > 30 && (
        <>
          <text x={x + 6} y={y + 16} fill="#f3f4f6" fontSize={11} fontWeight={500}>
            {name.length > Math.floor(width / 7) ? name.slice(0, Math.floor(width / 7)) + "…" : name}
          </text>
          <text x={x + 6} y={y + 30} fill="#9ca3af" fontSize={10}>{value.toLocaleString()}</text>
        </>
      )}
    </g>
  );
}

// ── FilterCombobox ──────────────────────────────────────────────────────────

function FilterCombobox({
  appId, eventName, dimKey, from, to, onSelect, onCancel,
}: {
  appId: string; eventName: string; dimKey: string; from: string; to: string;
  onSelect: (value: string) => void; onCancel: () => void;
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
        const res = await queryApi<BreakdownQueryResponse>("/v1/query/breakdown", {
          app_id: appId, event_name: eventName, dim_key: dimKey, from, to, limit: "200",
        });
        if (!cancelled) setValues(res.breakdown);
      } catch {
        if (!cancelled) setValues([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appId, eventName, dimKey, from, to]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onCancel();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onCancel]);

  const filtered = search ? values.filter((v) => v.value.toLowerCase().includes(search.toLowerCase())) : values;

  return (
    <div ref={containerRef} className="relative w-56">
      <input
        ref={inputRef}
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter") {
            if (filtered.length === 1) onSelect(filtered[0].value);
            else if (search.trim()) onSelect(search.trim());
          }
        }}
        placeholder={`Search ${dimKey}…`}
        className="w-full bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2.5 py-1.5 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
      />
      <div className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto rounded border border-gray-700 bg-gray-800 shadow-lg">
        {loading && <div className="px-3 py-2 text-xs text-gray-500">Loading…</div>}
        {!loading && filtered.length === 0 && (
          <div className="px-3 py-2 text-xs text-gray-500">
            {search.trim()
              ? <button onClick={() => onSelect(search.trim())} className="text-blue-400 hover:text-blue-300">Use &ldquo;{search.trim()}&rdquo;</button>
              : "No values found"}
          </div>
        )}
        {!loading && filtered.map((v) => (
          <button key={v.value} onClick={() => onSelect(v.value)}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors flex items-center justify-between">
            <span className="font-mono text-gray-200 truncate">{v.value}</span>
            <span className="text-gray-500 tabular-nums shrink-0 ml-2">{v.count.toLocaleString()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── DimPicker ───────────────────────────────────────────────────────────────

function DimPicker({ available, onAdd }: { available: DimensionKey[]; onAdd: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = search
    ? available.filter((d) => d.dimKey.toLowerCase().includes(search.toLowerCase()))
    : available;

  if (available.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-full px-2.5 py-0.5 text-xs border border-dashed border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-400 transition-colors"
      >
        + Add
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 w-60 rounded-lg border border-gray-700 bg-gray-900 shadow-xl z-30">
          <div className="p-1.5 border-b border-gray-800">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
              placeholder="Search dimensions…"
              className="w-full bg-gray-800 text-xs text-gray-300 px-2.5 py-1 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-600"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <p className="px-3 py-2 text-xs text-gray-600">No dimensions found.</p>
            )}
            {filtered.map((d) => {
              const isVirtual = d.dimKey === "event_name";
              return (
                <button
                  key={d.dimKey}
                  onClick={() => { onAdd(d.dimKey); setOpen(false); setSearch(""); }}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono flex items-center justify-between hover:bg-gray-800 transition-colors ${
                    isVirtual ? "text-purple-300" : "text-gray-300"
                  }`}
                >
                  <span>{d.dimKey}</span>
                  <span className="text-gray-600 font-sans ml-2">{d.distinctValues}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function DimensionMatrix() {
  const [appId, setAppId] = useState<string | null>(getSelectedAppId());
  const [range, setRange] = useState(() => defaultRange(30));

  const [eventNames, setEventNames] = useState<string[]>([]);
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const [availableDims, setAvailableDims] = useState<DimensionKey[]>([]);
  const [selectedDims, setSelectedDims] = useState<string[]>([]);
  const [loadingDims, setLoadingDims] = useState(false);

  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const [filters, setFilters] = useState<{ key: string; value: string }[]>([]);
  const [filterKey, setFilterKey] = useState("");
  const [showCombobox, setShowCombobox] = useState(false);

  const [aggregation, setAggregation] = useState<Aggregation>("count");

  const [matrix, setMatrix] = useState<MatrixRow[]>([]);
  const [loadingMatrix, setLoadingMatrix] = useState(false);
  const [sort, setSort] = useState<SortConfig>({ column: "__agg", direction: "desc" });

  const [chartType, setChartType] = useState<ChartType>("bar");

  const [showSparklines, setShowSparklines] = useState(false);
  const [trendData, setTrendData] = useState<MatrixTrendRow[]>([]);
  const [loadingTrend, setLoadingTrend] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const { isoFrom, isoTo } = toISORange(range);

  const eventsVersion = useRef(0);
  const dimsVersion = useRef(0);
  const matrixVersion = useRef(0);
  const trendVersion = useRef(0);

  // ── Data fetching ───────────────────────────────────────────────────────

  const fetchEvents = useCallback(async () => {
    if (!appId) return;
    const version = ++eventsVersion.current;
    setLoadingEvents(true);
    setError(null);
    try {
      const res = await queryApi<EventsQueryResponse>("/v1/query/events", {
        app_id: appId, from: isoFrom, to: isoTo, granularity: "day",
      });
      if (version !== eventsVersion.current) return;
      const names = res.top_events.map((e) => e.eventName);
      setEventNames(names);
      if (names.length > 0 && selectedEvents.length === 0) setSelectedEvents([names[0]]);
    } catch (err) {
      if (version !== eventsVersion.current) return;
      setError(extractError(err));
    } finally {
      if (version === eventsVersion.current) setLoadingEvents(false);
    }
  }, [appId, isoFrom, isoTo]);

  const fetchDimensions = useCallback(async () => {
    if (!appId || selectedEvents.length === 0) return;
    const version = ++dimsVersion.current;
    setLoadingDims(true);
    setError(null);
    try {
      const res = await queryApi<DimensionsQueryResponse>("/v1/query/dimensions", {
        app_id: appId, event_name: selectedEvents, from: isoFrom, to: isoTo,
      });
      if (version !== dimsVersion.current) return;
      setAvailableDims(res.dimensions);
      setSelectedDims([]);
      setFilters([]);
      setMatrix([]);
    } catch (err) {
      if (version !== dimsVersion.current) return;
      setError(extractError(err));
    } finally {
      if (version === dimsVersion.current) setLoadingDims(false);
    }
  }, [appId, selectedEvents, isoFrom, isoTo]);

  const minDims = 2;

  const fetchMatrix = useCallback(async () => {
    if (!appId || selectedEvents.length === 0 || selectedDims.length < minDims) {
      setMatrix([]);
      setTrendData([]);
      return;
    }
    const version = ++matrixVersion.current;
    setLoadingMatrix(true);
    setError(null);
    try {
      const params: Record<string, string | string[] | undefined> = {
        app_id: appId,
        event_name: selectedEvents.length === 1 ? selectedEvents[0] : selectedEvents,
        dimensions: selectedDims,
        from: isoFrom,
        to: isoTo,
        aggregation,
      };
      if (filters.length > 0) params.filter = filters.map((f) => `${f.key}:eq:${f.value}`);
      const res = await queryApi<MatrixQueryResponse>("/v1/query/matrix", params);
      if (version !== matrixVersion.current) return;
      setMatrix(res.matrix);
      setTrendData([]);
      setSort({ column: "__agg", direction: "desc" });
    } catch (err) {
      if (version !== matrixVersion.current) return;
      setError(extractError(err));
    } finally {
      if (version === matrixVersion.current) setLoadingMatrix(false);
    }
  }, [appId, selectedEvents, selectedDims, minDims, filters, isoFrom, isoTo, aggregation]);

  const fetchTrend = useCallback(async () => {
    if (!appId || selectedEvents.length === 0 || selectedDims.length < minDims) return;
    const version = ++trendVersion.current;
    setLoadingTrend(true);
    try {
      const params: Record<string, string | string[] | undefined> = {
        app_id: appId,
        event_name: selectedEvents.length === 1 ? selectedEvents[0] : selectedEvents,
        dimensions: selectedDims,
        from: isoFrom,
        to: isoTo,
        granularity: "day",
        aggregation,
      };
      if (filters.length > 0) params.filter = filters.map((f) => `${f.key}:eq:${f.value}`);
      const res = await queryApi<MatrixTrendQueryResponse>("/v1/query/matrix-trend", params);
      if (version !== trendVersion.current) return;
      setTrendData(res.trend);
    } catch {
      if (version !== trendVersion.current) return;
      setTrendData([]);
    } finally {
      if (version === trendVersion.current) setLoadingTrend(false);
    }
  }, [appId, selectedEvents, selectedDims, minDims, filters, isoFrom, isoTo, aggregation]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);
  useEffect(() => { fetchDimensions(); }, [fetchDimensions]);
  useEffect(() => { fetchMatrix(); }, [fetchMatrix]);
  useEffect(() => {
    if (showSparklines && matrix.length > 0) fetchTrend();
  }, [showSparklines, fetchTrend, matrix.length]);

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
    setFilters((prev) =>
      prev.some((f) => f.key === key)
        ? prev.map((f) => (f.key === key ? { key, value } : f))
        : [...prev, { key, value }],
    );
    setFilterKey("");
    setShowCombobox(false);
  }

  function removeFilter(key: string) {
    setFilters((prev) => prev.filter((f) => f.key !== key));
  }

  // Virtual "event_name" dim when multiple events selected
  const displayDims: DimensionKey[] = (() => {
    if (selectedEvents.length <= 1) return availableDims;
    if (availableDims.some((d) => d.dimKey === "event_name")) return availableDims;
    return [
      { dimKey: "event_name", distinctValues: selectedEvents.length, eventTypes: [...selectedEvents] },
      ...availableDims,
    ];
  })();

  const unselectedDims = displayDims.filter((d) => !selectedDims.includes(d.dimKey));

  const filterableDims = availableDims.filter(
    (d) => selectedDims.includes(d.dimKey) && !filters.some((f) => f.key === d.dimKey),
  );

  // ── Drag reorder ─────────────────────────────────────────────────────────

  function handleDragStart(idx: number) { setDragIdx(idx); }
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
  function handleDragEnd() { setDragIdx(null); }

  // ── Sort ─────────────────────────────────────────────────────────────────

  const sortedMatrix = [...matrix].sort((a, b) => {
    const aVal = sort.column === "__agg" ? a.count : a[sort.column];
    const bVal = sort.column === "__agg" ? b.count : b[sort.column];
    const aN = typeof aVal === "number" ? aVal : String(aVal ?? "");
    const bN = typeof bVal === "number" ? bVal : String(bVal ?? "");
    if (typeof aN === "number" && typeof bN === "number")
      return sort.direction === "asc" ? aN - bN : bN - aN;
    const cmp = String(aN).localeCompare(String(bN));
    return sort.direction === "asc" ? cmp : -cmp;
  });

  function handleSort(column: string) {
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "desc" },
    );
  }

  const effectiveDims = selectedDims;
  const aggLabel = AGGREGATION_LABELS[aggregation];
  const columns = [...effectiveDims, "__agg", ...(showSparklines ? ["_sparkline"] : [])];

  const trendByKey = new Map<string, { bucket: string; count: number }[]>();
  for (const row of trendData) {
    const key = effectiveDims.map((d) => String(row[d] ?? "")).join("\x00");
    const list = trendByKey.get(key) ?? [];
    list.push({ bucket: row.bucket, count: row.count });
    trendByKey.set(key, list);
  }

  const chartData = sortedMatrix.slice(0, 50).map((row) => ({
    name: effectiveDims.map((d) => String(row[d] ?? "")).join(" / "),
    count: Number(row.count),
  }));

  const GEO_DIMS = ["geo.country", "geo.city", "geo.latitude", "geo.longitude"];
  const selectedGeoDims = selectedDims.filter((d) => GEO_DIMS.includes(d));
  const selectedNonGeoDims = selectedDims.filter((d) => !GEO_DIMS.includes(d));
  const mapAvailable = selectedGeoDims.length > 0 && selectedNonGeoDims.length > 0;
  const geoDimForMap = selectedGeoDims.includes("geo.latitude") ? "geo.latitude"
    : selectedGeoDims.includes("geo.city") ? "geo.city"
    : selectedGeoDims.includes("geo.country") ? "geo.country"
    : selectedGeoDims[0] ?? "";
  const lngDimForMap = selectedGeoDims.includes("geo.longitude") ? "geo.longitude" : undefined;
  const segmentDimForMap = selectedNonGeoDims[0] ?? "";

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* ── Top bar ── */}
      <ControlBar>
        <AppSelector onAppSelected={(id) => setAppId(id)} />
        <ControlDivider />
        <DateRangePicker range={range} onChange={setRange} />
      </ControlBar>

      {/* ── Compact query bar ── */}
      {appId && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 divide-y divide-gray-800/60">

          {/* Row 1: Events + Aggregate */}
          <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500 w-20 shrink-0">Events</span>
            <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
              {eventNames.map((name) => (
                <button
                  key={name}
                  onClick={() => toggleEvent(name)}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-mono transition-colors ${
                    selectedEvents.includes(name)
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
                  }`}
                >
                  {name}
                </button>
              ))}
              {loadingEvents && <LoadingText label="loading…" />}
              {!loadingEvents && eventNames.length === 0 && (
                <span className="text-xs text-gray-600">No events in this range.</span>
              )}
            </div>
            {/* Aggregate inline */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-xs text-gray-600">aggregate</span>
              <div className="flex rounded bg-gray-800 p-0.5">
                {(["count", "sum", "avg", "min", "max"] as Aggregation[]).map((agg) => (
                  <button
                    key={agg}
                    onClick={() => setAggregation(agg)}
                    className={`px-2 py-0.5 text-xs rounded transition-colors ${
                      aggregation === agg ? "bg-gray-700 text-gray-100" : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {AGGREGATION_LABELS[agg]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Row 2: Breakdown (only when events selected) */}
          {selectedEvents.length > 0 && (
            <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 w-20 shrink-0">Breakdown</span>
              <div className="flex flex-wrap gap-1.5 flex-1">
                {selectedDims.map((dimKey, idx) => {
                  const isVirtual = dimKey === "event_name";
                  return (
                    <div
                      key={dimKey}
                      draggable
                      onDragStart={() => handleDragStart(idx)}
                      onDragOver={(e) => handleDragOver(e, idx)}
                      onDragEnd={handleDragEnd}
                      className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-mono cursor-grab active:cursor-grabbing select-none transition-colors ${
                        dragIdx === idx ? "opacity-60 ring-1 ring-blue-400" : ""
                      } ${
                        isVirtual
                          ? "bg-purple-600/30 text-purple-200 border border-purple-700/50"
                          : "bg-blue-600/30 text-blue-200 border border-blue-700/50"
                      }`}
                    >
                      <span className="text-gray-500 text-[10px]">⠿</span>
                      {dimKey}
                      <button
                        onClick={() => toggleDim(dimKey)}
                        className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                <DimPicker available={unselectedDims} onAdd={(k) => toggleDim(k)} />
                {loadingDims && <LoadingText label="loading…" />}
              </div>
              {selectedDims.length === 1 && (
                <span className="text-xs text-yellow-600 shrink-0">need 2+</span>
              )}
            </div>
          )}

          {/* Row 3: Filters (when enough dims or filters already active) */}
          {selectedEvents.length > 0 && (selectedDims.length >= 2 || filters.length > 0) && (
            <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 w-20 shrink-0">Filters</span>
              <div className="flex flex-wrap items-center gap-1.5 flex-1">
                {filters.map((f) => (
                  <span
                    key={f.key}
                    className="inline-flex items-center gap-1 rounded-full bg-yellow-600/20 text-yellow-300 border border-yellow-800/50 px-2.5 py-0.5 text-xs font-mono"
                  >
                    {f.key}={f.value}
                    <button onClick={() => removeFilter(f.key)} className="opacity-60 hover:opacity-100 ml-0.5">×</button>
                  </span>
                ))}
                {filterableDims.length > 0 && !showCombobox && (
                  <select
                    value={filterKey}
                    onChange={(e) => {
                      setFilterKey(e.target.value);
                      setShowCombobox(!!e.target.value);
                    }}
                    className="rounded bg-gray-800 border border-dashed border-gray-700 px-2 py-0.5 text-xs text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">+ Filter</option>
                    {filterableDims.map((d) => (
                      <option key={d.dimKey} value={d.dimKey}>{d.dimKey}</option>
                    ))}
                  </select>
                )}
                {showCombobox && filterKey && appId && selectedEvents.length > 0 && (
                  <FilterCombobox
                    appId={appId}
                    eventName={selectedEvents[0]}
                    dimKey={filterKey}
                    from={isoFrom}
                    to={isoTo}
                    onSelect={(value) => addFilter(filterKey, value)}
                    onCancel={() => { setFilterKey(""); setShowCombobox(false); }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <ErrorBanner message={error} />}
      {loadingMatrix && <LoadingText label="Loading matrix…" />}

      {/* ── No results hint ── */}
      {selectedDims.length >= minDims && !loadingMatrix && matrix.length === 0 && (() => {
        const selectedDimMetas = availableDims.filter((d) => selectedDims.includes(d.dimKey));
        const allEventTypes = new Set(selectedDimMetas.flatMap((d) => d.eventTypes));
        const sharedEventType = [...allEventTypes].some((et) =>
          selectedDimMetas.every((d) => d.eventTypes.includes(et)),
        );
        return (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
            {!sharedEventType ? (
              <>
                <p className="mb-1">No results — selected dimensions come from different event types.</p>
                <p className="text-xs text-gray-600">Cross-tabulation requires dimensions that co-occur on the same event.</p>
              </>
            ) : "No results for this combination."}
          </div>
        );
      })()}

      {/* ── Matrix results ── */}
      {sortedMatrix.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-medium text-gray-300">
              {effectiveDims.map((d) => (
                <code key={d} className="text-blue-300 text-xs mx-0.5">{d}</code>
              ))}
              <span className="text-gray-500 ml-1 font-normal text-xs">
                ({sortedMatrix.length} row{sortedMatrix.length !== 1 ? "s" : ""})
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { const next = !showSparklines; setShowSparklines(next); }}
                title="Toggle trend sparklines"
                className={`px-2.5 py-0.5 text-xs rounded border transition-colors ${
                  showSparklines
                    ? "bg-blue-600/20 border-blue-700/50 text-blue-300"
                    : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-300"
                }`}
              >
                {loadingTrend ? "…" : "Trend"}
              </button>
              <div className="flex rounded-md bg-gray-800 p-0.5">
                {([
                  ["bar", "Bar"],
                  ["treemap", "Treemap"],
                  ...(mapAvailable ? [["map", "Map"] as [ChartType, string]] : []),
                ] as [ChartType, string][]).map(([type, label]) => (
                  <button
                    key={type}
                    onClick={() => setChartType(type)}
                    className={`px-2.5 py-0.5 text-xs rounded transition-colors ${
                      chartType === type ? "bg-gray-700 text-gray-100" : "text-gray-400 hover:text-gray-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {chartType === "bar" && chartData.length > 0 && (
            <div style={{ height: Math.max(300, chartData.length * 28 + 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                  <XAxis type="number" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={{ stroke: "#374151" }} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={180} tick={{ fill: "#d1d5db", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip {...CHART_TOOLTIP_PROPS} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {chartData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {chartType === "treemap" && chartData.length > 0 && (
            <div style={{ height: 400 }}>
              <ResponsiveContainer width="100%" height="100%">
                <Treemap data={chartData} dataKey="count" nameKey="name" isAnimationActive={false}
                  content={<TreemapContent x={0} y={0} width={0} height={0} name="" value={0} index={0} />}
                />
              </ResponsiveContainer>
            </div>
          )}

          {chartType === "map" && mapAvailable && (
            <Suspense fallback={
              <div style={{ height: 450 }} className="flex items-center justify-center rounded-lg bg-gray-800/50">
                <span className="text-sm text-gray-500">Loading map…</span>
              </div>
            }>
              <DonutClusterMap matrixData={sortedMatrix} geoDim={geoDimForMap} segmentDim={segmentDimForMap} lngDim={lngDimForMap} height={450} />
            </Suspense>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left">
                  {columns.map((col) => (
                    <th
                      key={col}
                      onClick={col !== "_sparkline" ? () => handleSort(col) : undefined}
                      className={`pb-2 font-medium transition-colors ${
                        col === "_sparkline" ? "text-gray-500 text-right" :
                        col === "__agg" ? "text-right cursor-pointer hover:text-gray-200" :
                        "cursor-pointer hover:text-gray-200"
                      } ${sort.column === col ? "text-blue-400" : "text-gray-500"}`}
                    >
                      {col === "_sparkline" ? "Trend" : col === "__agg" ? aggLabel : col}
                      {col !== "_sparkline" && sort.column === col && (
                        <span className="ml-1">{sort.direction === "asc" ? "↑" : "↓"}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {sortedMatrix.map((row, i) => (
                  <tr key={i} className="text-gray-300 hover:bg-gray-800/30">
                    {columns.map((col) => {
                      if (col === "_sparkline") {
                        const rowKey = effectiveDims.map((d) => String(row[d] ?? "")).join("\x00");
                        return (
                          <td key="_sparkline" className="py-1.5 text-right">
                            <Sparkline data={trendByKey.get(rowKey) ?? []} />
                          </td>
                        );
                      }
                      const val = col === "__agg"
                        ? Number(row.count).toLocaleString()
                        : String(row[col] ?? "");
                      const showPill = col !== "__agg" && col === segmentDimForMap && mapAvailable;
                      return (
                        <td key={col} className={`py-1.5 ${col === "__agg" ? "text-right tabular-nums" : "font-mono text-xs"}`}>
                          {showPill ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dimColorHex(String(row[col] ?? "")) }} />
                              {val}
                            </span>
                          ) : val}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
