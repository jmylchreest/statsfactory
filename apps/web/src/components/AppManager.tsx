import { useState, useEffect, useCallback } from "react";
import { queryApi, mutateApi, fetchApps, clearSelectedAppId } from "./api-client";

// ── Types ───────────────────────────────────────────────────────────────────

type App = {
  id: string;
  name: string;
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

type AppTab = "settings" | "keys" | "integration" | "danger";

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

// ── CopyKeyButton ────────────────────────────────────────────────────────────

function CopyKeyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })}
      className="ml-2 shrink-0 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ── CreateKeyForm ────────────────────────────────────────────────────────────

function CreateKeyForm({ appId, onCreated }: { appId: string; onCreated: (result: NewKeyResult) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await mutateApi<NewKeyResult>("POST", `/v1/apps/${appId}/keys`, { name: name.trim() });
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
        {busy ? "Creating…" : "Create Key"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}

// ── AppKeyManager ────────────────────────────────────────────────────────────

function AppKeyManager({
  appId, keys, loading, error, onRefresh,
}: {
  appId: string;
  keys: AppKey[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function handleRevoke(keyId: string) {
    setRevoking(keyId);
    setRevokeError(null);
    try {
      await mutateApi("POST", `/v1/apps/${appId}/keys/${keyId}/revoke`);
      onRefresh();
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : "Failed to revoke key");
    } finally {
      setRevoking(null);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading keys…</p>;

  return (
    <div className="space-y-3">
      {(error || revokeError) && <p className="text-xs text-red-400">{error ?? revokeError}</p>}
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
                    <code className="text-gray-400 text-xs select-all">{k.rawKey ?? `${k.keyPrefix}…`}</code>
                    {k.rawKey && <CopyKeyButton value={k.rawKey} />}
                  </span>
                </td>
                <td className="py-1.5 text-gray-400">{formatDate(k.createdAt)}</td>
                <td className="py-1.5">
                  {k.revokedAt
                    ? <span className="text-xs text-red-400">Revoked {formatDate(k.revokedAt)}</span>
                    : <span className="text-xs text-green-400">Active</span>}
                </td>
                <td className="py-1.5 text-right">
                  {!k.revokedAt && (
                    <button
                      type="button"
                      onClick={() => handleRevoke(k.id)}
                      disabled={revoking === k.id}
                      className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                    >
                      {revoking === k.id ? "Revoking…" : "Revoke"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CreateKeyForm appId={appId} onCreated={onRefresh} />
    </div>
  );
}

// ── Enriched dimension groups ────────────────────────────────────────────────

const ENRICHED_DIM_GROUPS = [
  {
    label: "Geo",
    dims: [
      { key: "geo.country", desc: "Country code (e.g. NZ, US)" },
      { key: "geo.continent", desc: "Continent code (e.g. OC, NA)" },
      { key: "geo.timezone", desc: "Timezone (e.g. Pacific/Auckland)" },
      { key: "geo.region", desc: "Region code (e.g. WLG)" },
      { key: "geo.city", desc: "City name (e.g. Wellington)" },
      { key: "geo.latitude", desc: "Latitude" },
      { key: "geo.longitude", desc: "Longitude" },
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
    dims: [{ key: "client.os", desc: "OS (from browser or SDK UA)" }],
  },
] as const;

// ── AppSettings ──────────────────────────────────────────────────────────────

function AppSettings({ app, onUpdated }: { app: App; onUpdated: (updated: App) => void }) {
  const [name, setName] = useState(app.name);
  const [retentionDays, setRetentionDays] = useState(String(app.retentionDays));
  const [enabledDims, setEnabledDims] = useState<Set<string>>(new Set(app.enabledDims));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const origEnabled = new Set(app.enabledDims);
  const dimsChanged = enabledDims.size !== origEnabled.size || [...enabledDims].some((d) => !origEnabled.has(d));
  const hasChanges = name !== app.name || retentionDays !== String(app.retentionDays) || dimsChanged;

  function toggleDim(key: string) {
    setEnabledDims((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const body: Record<string, unknown> = {};
    if (name !== app.name) body.name = name;
    if (retentionDays !== String(app.retentionDays)) body.retention_days = parseInt(retentionDays, 10);
    if (dimsChanged) body.enabled_dims = [...enabledDims];
    try {
      const res = await mutateApi<{ id: string; name: string; retentionDays: number; enabledDims: string[] }>(
        "PATCH", `/v1/apps/${app.id}`, body,
      );
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-gray-400">Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-400">Retention (days)</span>
          <input type="number" value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)}
            min={1} max={365}
            className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </label>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-400">Enrichment Dimensions</p>
          <span className="text-xs text-gray-500">{enabledDims.size} enabled · each adds 1 row/event</span>
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
          {busy ? "Saving…" : "Save Settings"}
        </button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}

// ── IntegrationSnippet ───────────────────────────────────────────────────────

function IntegrationSnippet({ keys }: { keys: AppKey[] }) {
  const [tab, setTab] = useState<"curl" | "fetch">("curl");
  const [copied, setCopied] = useState(false);

  const activeKey = keys.find((k) => !k.revokedAt);
  const keyValue = activeKey?.rawKey ?? (activeKey ? `${activeKey.keyPrefix}…` : "YOUR_API_KEY");
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "https://your-worker.workers.dev";

  if (!activeKey) {
    return <p className="text-xs text-gray-500">Create an API key in the Keys tab to see integration examples.</p>;
  }

  const curlSnippet = `curl -X POST ${baseUrl}/v1/events \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${keyValue}" \\
  -d '{
    "events": [{
      "event": "page_view",
      "dimensions": { "page.path": "/home" },
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
      dimensions: { "page.path": "/home" },
      session_id: "optional-session-id",
    }],
  }),
});`;

  const snippet = tab === "curl" ? curlSnippet : fetchSnippet;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex rounded-md bg-gray-800 p-0.5">
          {(["curl", "fetch"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-2.5 py-0.5 text-xs rounded transition-colors ${tab === t ? "bg-gray-700 text-gray-100" : "text-gray-400 hover:text-gray-300"}`}>
              {t}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => copyToClipboard(snippet).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}
          className="ml-auto text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="rounded-md bg-gray-950 border border-gray-800 p-3 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap">
        {snippet}
      </pre>
      <p className="text-xs text-gray-600">
        See <code className="text-gray-500">/v1/openapi.json</code> for the full API spec.
      </p>
    </div>
  );
}

// ── DangerZone ───────────────────────────────────────────────────────────────

function DangerZone({ app, onDeleted }: { app: App; onDeleted: (appId: string) => void }) {
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
    <div className="space-y-3">
      {!confirmDelete ? (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          className="rounded-md border border-red-700 px-3 py-1.5 text-sm text-red-400 hover:bg-red-900/30 transition-colors"
        >
          Delete App
        </button>
      ) : (
        <div className="rounded-md border border-red-900/50 bg-red-950/20 p-3 space-y-3">
          <p className="text-sm text-red-300">
            Permanently delete <strong>{app.name}</strong> and all its data. This cannot be undone.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
            >
              {deleting ? "Deleting…" : "Yes, Delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
          {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}
        </div>
      )}
      <p className="text-xs text-gray-600 font-mono">ID: {app.id}</p>
    </div>
  );
}

// ── AppCard ──────────────────────────────────────────────────────────────────

function AppCard({ app, onUpdated, onDeleted }: {
  app: App;
  onUpdated: (updated: App) => void;
  onDeleted: (appId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<AppTab>("settings");

  // Hoist keys fetch so both Keys and Integration tabs share one request
  const [keys, setKeys] = useState<AppKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    setKeysError(null);
    try {
      const res = await queryApi<{ keys: AppKey[] }>(`/v1/apps/${app.id}/keys`);
      setKeys(res.keys);
    } catch (err) {
      setKeysError(err instanceof Error ? err.message : "Failed to load keys");
    } finally {
      setKeysLoading(false);
    }
  }, [app.id]);

  useEffect(() => {
    if (expanded) loadKeys();
  }, [expanded, loadKeys]);

  const TABS: { id: AppTab; label: string; danger?: boolean }[] = [
    { id: "settings", label: "Settings" },
    { id: "keys", label: "Keys" },
    { id: "integration", label: "Integration" },
    { id: "danger", label: "Danger", danger: true },
  ];

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-800/40 transition-colors rounded-lg"
      >
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-sm font-medium text-gray-100">{app.name}</span>
          <span className="text-xs text-gray-600 font-mono hidden sm:inline">{app.id.slice(0, 10)}…</span>
          <span className="text-xs text-gray-500">{app.retentionDays}d · {formatDate(app.createdAt)}</span>
        </div>
        <span className="text-gray-600 text-xs ml-4 shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-800">
          {/* Tab bar */}
          <div className="flex border-b border-gray-800 px-4">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-xs transition-colors border-b-2 -mb-px ${
                  tab === t.id
                    ? t.danger
                      ? "border-red-500 text-red-400"
                      : "border-blue-500 text-blue-400"
                    : t.danger
                    ? "border-transparent text-gray-600 hover:text-red-400 ml-auto"
                    : "border-transparent text-gray-500 hover:text-gray-300"
                } ${t.danger && tab !== t.id ? "ml-auto" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="px-4 py-4">
            {tab === "settings" && (
              <AppSettings app={app} onUpdated={onUpdated} />
            )}
            {tab === "keys" && (
              <AppKeyManager
                appId={app.id}
                keys={keys}
                loading={keysLoading}
                error={keysError}
                onRefresh={loadKeys}
              />
            )}
            {tab === "integration" && (
              <IntegrationSnippet keys={keys} />
            )}
            {tab === "danger" && (
              <DangerZone app={app} onDeleted={onDeleted} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── AppManager (main) ────────────────────────────────────────────────────────

export default function AppManager() {
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRetention, setNewRetention] = useState("90");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setApps(await fetchApps());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load apps");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadApps(); }, [loadApps]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await mutateApi("POST", "/v1/apps", {
        name: newName.trim(),
        retention_days: parseInt(newRetention, 10),
      });
      setNewName("");
      setNewRetention("90");
      setShowCreate(false);
      await loadApps();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create app");
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center text-sm text-gray-500">
        Loading apps…
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
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">{apps.length} app{apps.length !== 1 ? "s" : ""}</p>
        <button
          type="button"
          onClick={() => setShowCreate(!showCreate)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          {showCreate ? "Cancel" : "New App"}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
          <h3 className="text-sm font-medium text-gray-200">Create App</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-xs text-gray-400">App Name</span>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="My App" autoFocus
                className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-gray-400">Retention (days)</span>
              <input type="number" value={newRetention} onChange={(e) => setNewRetention(e.target.value)}
                min={1} max={365}
                className="block w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={creating || !newName.trim()}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {creating ? "Creating…" : "Create"}
            </button>
            {createError && <span className="text-xs text-red-400">{createError}</span>}
          </div>
        </form>
      )}

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
              onUpdated={(updated) => setApps((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))}
              onDeleted={(appId) => { setApps((prev) => prev.filter((a) => a.id !== appId)); clearSelectedAppId(); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
