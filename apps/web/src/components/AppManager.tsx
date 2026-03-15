import { useState, useEffect, useCallback } from "react";
import { queryApi, mutateApi, fetchApps, clearSelectedAppId } from "./api-client";

// ── Types ───────────────────────────────────────────────────────────────────

type App = {
  id: string;
  name: string;
  geoPrecision: string;
  retentionDays: number;
  enabledDims: string[];
  createdAt: string;
};

type AppKey = {
  id: string;
  keyPrefix: string;
  rawKey: string | null;
  name: string;
  createdAt: string;
  revokedAt: string | null;
};

type NewKeyResult = {
  id: string;
  key: string;
  key_prefix: string;
  name: string;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Copy text to clipboard, returns a promise. */
function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

// ── Sub-components ──────────────────────────────────────────────────────────

/** Inline copy button for an API key. */
function CopyKeyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="ml-2 shrink-0 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

/** Form to create a new API key for an app. */
function CreateKeyForm({
  appId,
  onCreated,
}: {
  appId: string;
  onCreated: (result: NewKeyResult) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await mutateApi<NewKeyResult>("POST", `/v1/apps/${appId}/keys`, {
        name: name.trim(),
      });
      onCreated(res);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <label className="flex-1 space-y-1">
        <span className="text-xs text-gray-400">New key name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Production Key"
          className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </label>
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? "Creating..." : "Create Key"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}

/** Key list for a single app: shows keys, revoke buttons, and create form. */
function AppKeyManager({ appId }: { appId: string }) {
  const [keys, setKeys] = useState<AppKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await queryApi<{ keys: AppKey[] }>(`/v1/apps/${appId}/keys`);
      setKeys(res.keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  async function handleRevoke(keyId: string) {
    setRevoking(keyId);
    try {
      await mutateApi("POST", `/v1/apps/${appId}/keys/${keyId}/revoke`);
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key");
    } finally {
      setRevoking(null);
    }
  }

  function handleKeyCreated(_result: NewKeyResult) {
    loadKeys();
  }

  if (loading) {
    return <p className="text-sm text-gray-500">Loading keys...</p>;
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      {keys.length === 0 ? (
        <p className="text-sm text-gray-500">No keys yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
              <th className="pb-1.5 font-medium">Name</th>
              <th className="pb-1.5 font-medium">Key</th>
              <th className="pb-1.5 font-medium">Created</th>
              <th className="pb-1.5 font-medium">Status</th>
              <th className="pb-1.5 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {keys.map((k) => (
              <tr key={k.id}>
                <td className="py-1.5 text-gray-200">{k.name}</td>
                <td className="py-1.5">
                  <span className="inline-flex items-center">
                    <code className="text-gray-400 text-xs select-all">
                      {k.rawKey ?? `${k.keyPrefix}...`}
                    </code>
                    {k.rawKey && <CopyKeyButton value={k.rawKey} />}
                  </span>
                </td>
                <td className="py-1.5 text-gray-400">{formatDate(k.createdAt)}</td>
                <td className="py-1.5">
                  {k.revokedAt ? (
                    <span className="text-xs text-red-400">Revoked {formatDate(k.revokedAt)}</span>
                  ) : (
                    <span className="text-xs text-green-400">Active</span>
                  )}
                </td>
                <td className="py-1.5 text-right">
                  {!k.revokedAt && (
                    <button
                      type="button"
                      onClick={() => handleRevoke(k.id)}
                      disabled={revoking === k.id}
                      className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                    >
                      {revoking === k.id ? "Revoking..." : "Revoke"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateKeyForm appId={appId} onCreated={handleKeyCreated} />
    </div>
  );
}

/**
 * All enriched dimensions that can be toggled on/off per app.
 * Grouped by category for the UI. Every dim the system can produce is listed.
 */
const ENRICHED_DIM_GROUPS = [
  {
    label: "Geo",
    dims: [
      { key: "geo.country", desc: "Country code (e.g. NZ, US)" },
      { key: "geo.continent", desc: "Continent code (e.g. OC, NA)" },
      { key: "geo.timezone", desc: "Timezone (e.g. Pacific/Auckland)" },
      { key: "geo.region", desc: "Region code (city mode only)" },
      { key: "geo.city", desc: "City name (city mode only)" },
      { key: "geo.latitude", desc: "Latitude (city mode only)" },
      { key: "geo.longitude", desc: "Longitude (city mode only)" },
    ],
  },
  {
    label: "Network",
    dims: [
      { key: "net.asn", desc: "AS number" },
      { key: "net.as_org", desc: "AS organization" },
      { key: "net.colo", desc: "Cloudflare colo (e.g. SYD)" },
      { key: "net.tls_version", desc: "TLS version (e.g. TLSv1.3)" },
      { key: "net.http_protocol", desc: "HTTP protocol (e.g. HTTP/2)" },
    ],
  },
  {
    label: "Browser",
    dims: [
      { key: "client.browser", desc: "Browser name (e.g. Chrome)" },
      { key: "client.browser_version", desc: "Browser major version" },
      { key: "client.device_type", desc: "Device type (desktop/mobile/tablet)" },
    ],
  },
  {
    label: "SDK",
    dims: [
      { key: "sdk.name", desc: "SDK name (e.g. statsfactory-sdk-go)" },
      { key: "sdk.version", desc: "SDK version" },
      { key: "client.name", desc: "Client app name" },
      { key: "client.version", desc: "Client app version" },
      { key: "client.arch", desc: "Client architecture (e.g. amd64)" },
    ],
  },
  {
    label: "Shared",
    dims: [
      { key: "client.os", desc: "OS (from browser or SDK UA)" },
    ],
  },
] as const;

/** Inline settings editor for a single app (PATCH). */
function AppSettings({
  app,
  onUpdated,
}: {
  app: App;
  onUpdated: (updated: App) => void;
}) {
  const [name, setName] = useState(app.name);
  const [geoPrecision, setGeoPrecision] = useState(app.geoPrecision);
  const [retentionDays, setRetentionDays] = useState(String(app.retentionDays));
  const [enabledDims, setEnabledDims] = useState<Set<string>>(new Set(app.enabledDims));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Detect whether any field has changed from the original
  const origEnabled = new Set(app.enabledDims);
  const dimsChanged =
    enabledDims.size !== origEnabled.size ||
    [...enabledDims].some((d) => !origEnabled.has(d));

  const hasChanges =
    name !== app.name ||
    geoPrecision !== app.geoPrecision ||
    retentionDays !== String(app.retentionDays) ||
    dimsChanged;

  const enabledCount = enabledDims.size;

  function toggleDim(key: string) {
    setEnabledDims((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    setSaved(false);

    const body: Record<string, unknown> = {};
    if (name !== app.name) body.name = name;
    if (geoPrecision !== app.geoPrecision) body.geo_precision = geoPrecision;
    if (retentionDays !== String(app.retentionDays)) {
      body.retention_days = parseInt(retentionDays, 10);
    }
    if (dimsChanged) body.enabled_dims = [...enabledDims];

    try {
      const res = await mutateApi<{
        id: string;
        name: string;
        geoPrecision: string;
        retentionDays: number;
        enabledDims: string[];
      }>("PATCH", `/v1/apps/${app.id}`, body);
      onUpdated({ ...app, ...res });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-gray-400">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-400">Geo Precision</span>
          <select
            value={geoPrecision}
            onChange={(e) => setGeoPrecision(e.target.value)}
            className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="country">Country</option>
            <option value="city">City</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-400">Retention (days)</span>
          <input
            type="number"
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
            min={1}
            max={365}
            className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
      </div>

      {/* Enrichment dimension toggles */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-gray-400">Enrichment Dimensions</p>
            <p className="text-xs text-gray-600 mt-0.5">
              Toggle which server-side dimensions are stored per event.
            </p>
          </div>
          <span className="shrink-0 text-xs text-gray-500 tabular-nums">
            {enabledCount} enabled
          </span>
        </div>

        {/* Cost banner */}
        <div className="rounded-md border border-amber-800/40 bg-amber-950/20 px-3 py-2">
          <p className="text-xs text-amber-400/90">
            The more dimensions you enable, the more rows are written per event, consuming free tier usage quicker.
          </p>
        </div>

        {ENRICHED_DIM_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500 w-16 shrink-0">{group.label}</span>
            {group.dims.map((dim) => {
              const isEnabled = enabledDims.has(dim.key);
              return (
                <button
                  key={dim.key}
                  type="button"
                  onClick={() => toggleDim(dim.key)}
                  title={`${dim.desc} — click to ${isEnabled ? "disable" : "enable"}`}
                  className={`rounded px-2 py-0.5 text-xs transition-colors border ${
                    isEnabled
                      ? "bg-green-900/30 border-green-700/50 text-green-400"
                      : "bg-gray-800 border-gray-700 text-gray-500"
                  }`}
                >
                  {dim.key.replace(/^(geo|net|client|sdk)\./, "")}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !hasChanges}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? "Saving..." : "Save Settings"}
        </button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}

/** Shows a cURL / fetch integration example with the first active API key. */
function IntegrationSnippet({ appId }: { appId: string }) {
  const [keys, setKeys] = useState<AppKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await queryApi<{ keys: AppKey[] }>(`/v1/apps/${appId}/keys`);
        if (!cancelled) setKeys(res.keys);
      } catch {
        // ignore — keys section handles errors
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appId]);

  const activeKey = keys.find((k) => !k.revokedAt);
  const keyPlaceholder = activeKey?.rawKey ?? activeKey?.keyPrefix ? `${activeKey.keyPrefix}...` : "YOUR_API_KEY";
  const keyValue = activeKey?.rawKey ?? keyPlaceholder;
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "https://your-worker.workers.dev";

  const curlSnippet = `curl -X POST ${baseUrl}/v1/events \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${keyValue}" \\
  -d '{
    "events": [{
      "event": "page_view",
      "dimensions": {
        "page.path": "/home",
        "page.title": "Home"
      },
      "session_id": "optional-session-id"
    }]
  }'`;

  const fetchSnippet = `await fetch("${baseUrl}/v1/events", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer ${keyValue}",
  },
  body: JSON.stringify({
    events: [{
      event: "page_view",
      dimensions: {
        "page.path": "/home",
        "page.title": "Home",
      },
      session_id: "optional-session-id",
    }],
  }),
});`;

  const [tab, setTab] = useState<"curl" | "fetch">("curl");
  const snippet = tab === "curl" ? curlSnippet : fetchSnippet;

  function handleCopy() {
    copyToClipboard(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (loading) return null;
  if (!activeKey) {
    return (
      <p className="text-xs text-gray-500">
        Create an API key above to see integration examples.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex rounded-md bg-gray-800 p-0.5">
          {(["curl", "fetch"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-0.5 text-xs rounded transition-colors ${
                tab === t
                  ? "bg-gray-700 text-gray-100"
                  : "text-gray-400 hover:text-gray-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="ml-auto text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="rounded-md bg-gray-950 border border-gray-800 p-3 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap">
        {snippet}
      </pre>
      <p className="text-xs text-gray-600">
        The API key determines which app events are routed to — no app ID needed in the payload.
        See <code className="text-gray-500">/v1/openapi.json</code> for the full API spec.
      </p>
    </div>
  );
}

/** A single expandable app card with settings, keys, and delete. */
function AppCard({
  app,
  onUpdated,
  onDeleted,
}: {
  app: App;
  onUpdated: (updated: App) => void;
  onDeleted: (appId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await mutateApi("DELETE", `/v1/apps/${app.id}`);
      onDeleted(app.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete");
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-800/40 transition-colors rounded-lg"
      >
        <div>
          <span className="text-sm font-medium text-gray-100">{app.name}</span>
          <span className="ml-3 text-xs text-gray-500">
            {app.geoPrecision} &middot; {app.retentionDays}d retention &middot;{" "}
            {formatDate(app.createdAt)}
          </span>
        </div>
        <span className="text-gray-500 text-xs">{expanded ? "▲" : "▼"}</span>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-4 space-y-5">
          {/* Settings */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Settings
            </h3>
            <AppSettings app={app} onUpdated={onUpdated} />
          </section>

          {/* Keys */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              API Keys
            </h3>
            <AppKeyManager appId={app.id} />
          </section>

          {/* Integration */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Integration
            </h3>
            <IntegrationSnippet appId={app.id} />
          </section>

          {/* Danger zone */}
          <section className="rounded-md border border-red-900/50 bg-red-950/20 p-3 space-y-2">
            <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider">
              Danger Zone
            </h3>
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-md border border-red-700 px-3 py-1.5 text-sm text-red-400 hover:bg-red-900/30 transition-colors"
              >
                Delete App
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <p className="text-sm text-red-300">
                  This will permanently delete <strong>{app.name}</strong> and all
                  its data. Are you sure?
                </p>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="shrink-0 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
                >
                  {deleting ? "Deleting..." : "Yes, Delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
            {deleteError && (
              <p className="text-xs text-red-400">{deleteError}</p>
            )}
          </section>

          {/* ID for reference */}
          <p className="text-xs text-gray-600">
            ID: <code className="text-gray-500">{app.id}</code>
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function AppManager() {
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newGeo, setNewGeo] = useState("country");
  const [newRetention, setNewRetention] = useState("90");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchApps();
      setApps(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load apps");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await mutateApi("POST", "/v1/apps", {
        name: newName.trim(),
        geo_precision: newGeo,
        retention_days: parseInt(newRetention, 10),
      });
      setNewName("");
      setNewGeo("country");
      setNewRetention("90");
      setShowCreate(false);
      await loadApps();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create app");
    } finally {
      setCreating(false);
    }
  }

  function handleAppUpdated(updated: App) {
    setApps((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }

  function handleAppDeleted(appId: string) {
    setApps((prev) => prev.filter((a) => a.id !== appId));
    // If the deleted app was the selected one, clear the selection
    clearSelectedAppId();
  }

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center text-sm text-gray-500">
        Loading apps...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + create button */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          {apps.length} app{apps.length !== 1 ? "s" : ""}
        </p>
        <button
          type="button"
          onClick={() => setShowCreate(!showCreate)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          {showCreate ? "Cancel" : "New App"}
        </button>
      </div>

      {/* Create app form */}
      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3"
        >
          <h3 className="text-sm font-medium text-gray-200">Create App</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="text-xs text-gray-400">App Name</span>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="My App"
                className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">Geo Precision</span>
              <select
                value={newGeo}
                onChange={(e) => setNewGeo(e.target.value)}
                className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="country">Country</option>
                <option value="city">City</option>
                <option value="none">None</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">Retention (days)</span>
              <input
                type="number"
                value={newRetention}
                onChange={(e) => setNewRetention(e.target.value)}
                min={1}
                max={365}
                className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? "Creating..." : "Create"}
            </button>
            {createError && (
              <span className="text-xs text-red-400">{createError}</span>
            )}
          </div>
        </form>
      )}

      {/* App list */}
      {apps.length === 0 ? (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center text-sm text-gray-500">
          No apps yet. Click "New App" to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              onUpdated={handleAppUpdated}
              onDeleted={handleAppDeleted}
            />
          ))}
        </div>
      )}
    </div>
  );
}
