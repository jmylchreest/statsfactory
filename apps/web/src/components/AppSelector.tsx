import { useState, useEffect } from "react";
import {
  fetchApps,
  getSelectedAppId,
  setSelectedAppId,
} from "./api-client";

type App = { id: string; name: string };

/**
 * Fetches the list of apps and lets the user pick one.
 * The selected app ID is stored in localStorage via setSelectedAppId().
 *
 * Shows inline when no app is selected, otherwise renders a compact
 * dropdown selector that can be changed at any time.
 */
export default function AppSelector({
  onAppSelected,
}: {
  onAppSelected: (appId: string) => void;
}) {
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    getSelectedAppId,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchApps()
      .then((result) => {
        if (cancelled) return;
        setApps(result);

        // Auto-select: if we have a stored ID that still exists, keep it.
        // Otherwise pick the first app.
        const stored = getSelectedAppId();
        const stillExists = result.some((a) => a.id === stored);
        if (stored && stillExists) {
          setSelectedId(stored);
          onAppSelected(stored);
        } else if (result.length > 0) {
          const first = result[0].id;
          setSelectedAppId(first);
          setSelectedId(first);
          onAppSelected(first);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load apps");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleChange(appId: string) {
    setSelectedAppId(appId);
    setSelectedId(appId);
    onAppSelected(appId);
  }

  if (loading) {
    return (
      <div className="text-sm text-gray-500">Loading apps...</div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div className="rounded-lg border border-yellow-800/50 bg-yellow-900/20 p-4 text-sm text-yellow-200">
        No apps found. Create an app first via the management API.
      </div>
    );
  }

  return (
    <label className="text-sm text-gray-400 flex items-center gap-2">
      App
      <select
        value={selectedId ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        className="rounded-md bg-gray-800 border border-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {apps.map((app) => (
          <option key={app.id} value={app.id}>
            {app.name}
          </option>
        ))}
      </select>
    </label>
  );
}
