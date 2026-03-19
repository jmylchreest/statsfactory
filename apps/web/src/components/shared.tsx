/**
 * Shared utilities and micro-components used across dashboard pages.
 */

import type { CSSProperties } from "react";

// ── Date range helpers ─────────────────────────────────────────────────────

export type DateRange = { from: string; to: string };

/** Default date range ending today. */
export function defaultRange(days = 30): DateRange {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

/** Convert a date range to ISO timestamps for API queries. */
export function toISORange(range: DateRange): { isoFrom: string; isoTo: string } {
  return {
    isoFrom: range.from + "T00:00:00Z",
    isoTo: range.to + "T23:59:59Z",
  };
}

// ── Error handling ─────────────────────────────────────────────────────────

/** Extract a human-readable message from an unknown caught error. */
export function extractError(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

// ── Micro-components ───────────────────────────────────────────────────────

/** Red error banner, consistent across all dashboard pages. */
export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
      {message}
    </div>
  );
}

/** Grey loading indicator text. */
export function LoadingText({ label = "Loading..." }: { label?: string }) {
  return <div className="text-sm text-gray-500">{label}</div>;
}

/** From/To date range picker used across Overview, EventExplorer, Matrix. */
export function DateRangePicker({
  range,
  onChange,
}: {
  range: DateRange;
  onChange: (range: DateRange) => void;
}) {
  return (
    <>
      <label className="text-sm text-gray-400">
        From
        <input
          type="date"
          value={range.from}
          onChange={(e) => onChange({ ...range, from: e.target.value })}
          className="ml-2 rounded-md bg-gray-800 border border-gray-700 px-2 py-1 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </label>
      <label className="text-sm text-gray-400">
        To
        <input
          type="date"
          value={range.to}
          onChange={(e) => onChange({ ...range, to: e.target.value })}
          className="ml-2 rounded-md bg-gray-800 border border-gray-700 px-2 py-1 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </label>
    </>
  );
}

// ── Recharts theme ─────────────────────────────────────────────────────────

/** Shared dark-theme Tooltip props for all Recharts charts. */
export const CHART_TOOLTIP_PROPS = {
  contentStyle: {
    backgroundColor: "#1f2937",
    border: "1px solid #374151",
    borderRadius: 8,
    fontSize: 12,
  } as CSSProperties,
  labelStyle: { color: "#f3f4f6" } as CSSProperties,
  itemStyle: { color: "#9ca3af" } as CSSProperties,
  cursor: { fill: "rgba(55, 65, 81, 0.3)" },
} as const;
