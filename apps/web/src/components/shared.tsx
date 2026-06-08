/**
 * Shared utilities and micro-components used across dashboard pages.
 */

import type { CSSProperties, ReactNode } from "react";

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

// ── Layout components ──────────────────────────────────────────────────────

/**
 * Consistent top-of-page filter bar used by all dashboard pages.
 * Children (AppSelector, DateRangePicker, selects) are laid out in a
 * horizontal flex row with a subtle card border.
 */
export function ControlBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2">
      {children}
    </div>
  );
}

/** Thin vertical separator between control groups inside a ControlBar. */
export function ControlDivider() {
  return <div className="w-px h-4 bg-gray-700 shrink-0" aria-hidden="true" />;
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

/** Inline loading indicator with spinner. */
export function LoadingText({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-500 py-1">
      <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      {label}
    </div>
  );
}

/** From/To date range picker. Renders two date inputs suitable for ControlBar. */
export function DateRangePicker({
  range,
  onChange,
}: {
  range: DateRange;
  onChange: (range: DateRange) => void;
}) {
  return (
    <>
      <label className="text-sm text-gray-400 flex items-center gap-1.5">
        From
        <input
          type="date"
          value={range.from}
          onChange={(e) => onChange({ ...range, from: e.target.value })}
          className="rounded-md bg-gray-800 border border-gray-700 px-2 py-1 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </label>
      <label className="text-sm text-gray-400 flex items-center gap-1.5">
        To
        <input
          type="date"
          value={range.to}
          onChange={(e) => onChange({ ...range, to: e.target.value })}
          className="rounded-md bg-gray-800 border border-gray-700 px-2 py-1 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
