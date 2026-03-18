/**
 * @statsfactory/sdk — TypeScript SDK for statsfactory anonymous event telemetry.
 *
 * Zero dependencies. Works in browsers, Node.js, Bun, Deno, and Cloudflare Workers.
 *
 * @example
 * ```ts
 * import { StatsFactory } from "@statsfactory/sdk";
 *
 * const sf = new StatsFactory({
 *   serverUrl: "https://stats.example.com",
 *   appKey: "sf_live_xxxx",
 * });
 *
 * sf.track("page_view", { "page.path": "/home", "output.plugins": ["kitty", "waybar"] });
 *
 * // Events flush automatically. On close:
 * sf.close();
 * ```
 *
 * @module
 */

export const VERSION = "0.1.0";

// ── Types ────────────────────────────────────────────────────────────────────

/** Scalar dimension value. */
export type DimScalar = string | number | boolean;

/** Dimension values: string, number, boolean, or array of scalars. */
export type Dims = Record<string, DimScalar | DimScalar[]>;

/** SDK configuration. */
export interface StatsFactoryConfig {
  /** statsfactory API base URL (required). No trailing slash. */
  serverUrl: string;

  /** App key for ingestion, e.g. `"sf_live_xxxx"` (required). */
  appKey: string;

  /**
   * Client application name (optional). Used in the User-Agent header
   * sent to the server for UA parsing.
   */
  clientName?: string;

  /** Client application version (optional). */
  clientVersion?: string;

  /**
   * Flush interval in milliseconds. Defaults to 30000 (30s).
   * Set to 0 to disable automatic flushing (manual flush only).
   */
  flushInterval?: number;

  /**
   * Override the session ID. By default, a random session ID is generated
   * per instance. In browsers, the ID is stored in `sessionStorage` so it
   * persists across page navigations within the same tab.
   */
  sessionId?: string;

  /**
   * Whether to use `navigator.sendBeacon` for the final flush on page
   * unload (browser only). Defaults to `true`.
   */
  useBeacon?: boolean;

  /**
   * Error callback invoked when a background flush fails.
   * Errors during explicit `flush()` calls are thrown/rejected instead.
   */
  onError?: (err: Error) => void;

  /**
   * Custom fetch implementation. Defaults to the global `fetch`.
   * Useful for testing or environments without global fetch.
   */
  fetch?: typeof fetch;
}

/** Per-event overrides for `trackWithOptions`. */
export interface TrackOptions {
  /** Override the event timestamp (ISO 8601 string or Date). */
  timestamp?: string | Date;

  /** Override the session ID for this event. */
  sessionId?: string;

  /** Set a distinct ID (user/install identity) for this event. */
  distinctId?: string;
}

// ── Internal types ───────────────────────────────────────────────────────────

interface Event {
  event: string;
  event_key?: string;
  timestamp?: string;
  session_id?: string;
  distinct_id?: string;
  dimensions?: Dims;
}

interface IngestResponse {
  accepted: number;
  errors: Array<{ index: number; message: string }>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_BATCH_SIZE = 25;
const DEFAULT_FLUSH_INTERVAL = 30_000;
const FLUSH_TIMEOUT = 10_000;
const SESSION_STORAGE_KEY = "statsfactory_session_id";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ULID_ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/**
 * Generate a ULID (26-char, time-sortable unique ID).
 * Uses crypto.getRandomValues where available, falls back to Math.random.
 */
function generateUlid(): string {
  let now = Date.now();
  let time = "";
  for (let i = 10; i > 0; i--) {
    const mod = now % 32;
    time = ULID_ENCODING[mod] + time;
    now = (now - mod) / 32;
  }

  let random = "";
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (let i = 0; i < 16; i++) {
      random += ULID_ENCODING[bytes[i] % 32];
    }
  } else {
    for (let i = 0; i < 16; i++) {
      random += ULID_ENCODING[Math.floor(Math.random() * 32)];
    }
  }

  return time + random;
}

/** Is this running in a browser environment? */
function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** Generate a random 32-char hex session ID. */
function generateSessionId(): string {
  // Use crypto.randomUUID if available (modern browsers, Node 19+, Bun, Deno)
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }

  // Fallback: crypto.getRandomValues
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Last resort: Math.random (not cryptographically secure, but functional)
  let id = "";
  for (let i = 0; i < 32; i++) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return id;
}

/**
 * Get or create a session ID. In browsers, persists in sessionStorage
 * so navigations within the same tab share a session.
 */
function getOrCreateSessionId(): string {
  if (isBrowser()) {
    try {
      const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (existing) return existing;
      const id = generateSessionId();
      sessionStorage.setItem(SESSION_STORAGE_KEY, id);
      return id;
    } catch {
      // sessionStorage may be unavailable (private browsing, iframes, etc.)
    }
  }
  return generateSessionId();
}

function buildUserAgent(cfg: StatsFactoryConfig): string {
  const parts = [`statsfactory-sdk-ts/${VERSION}`];
  if (cfg.clientName) {
    let client = cfg.clientName;
    if (cfg.clientVersion) client += "/" + cfg.clientVersion;
    parts.push(`(${client})`);
  }
  return parts.join(" ");
}

// ── SDK Client ───────────────────────────────────────────────────────────────

export class StatsFactory {
  private readonly config: Required<
    Pick<StatsFactoryConfig, "serverUrl" | "appKey">
  > &
    StatsFactoryConfig;
  private readonly sessionId: string;
  private readonly userAgent: string;
  private readonly fetchFn: typeof fetch;

  private queue: Event[] = [];
  private closed = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private unloadHandler: (() => void) | null = null;

  constructor(config: StatsFactoryConfig) {
    if (!config.serverUrl) throw new Error("StatsFactory: serverUrl is required");
    if (!config.appKey) throw new Error("StatsFactory: appKey is required");

    this.config = { ...config, serverUrl: config.serverUrl.replace(/\/+$/, "") };
    this.sessionId = config.sessionId ?? getOrCreateSessionId();
    this.userAgent = buildUserAgent(config);
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);

    // Start background flush timer.
    const interval = config.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    if (interval > 0) {
      this.flushTimer = setInterval(() => {
        this.flushBackground();
      }, interval);
    }

    // Register page unload handler (browser only).
    if (isBrowser() && config.useBeacon !== false) {
      this.unloadHandler = () => this.flushBeacon();
      window.addEventListener("visibilitychange", this.unloadHandler);
      window.addEventListener("pagehide", this.unloadHandler);
    }
  }

  /**
   * Enqueue an event with dimensions. Does not block on I/O.
   *
   * @param eventName - Lowercase alphanumeric + underscores, max 64 chars.
   * @param dims - Key-value dimension map.
   */
  track(eventName: string, dims?: Dims): void {
    this.trackWithOptions(eventName, dims, {});
  }

  /**
   * Enqueue an event with per-event overrides.
   *
   * @param eventName - Event name.
   * @param dims - Dimensions.
   * @param options - Per-event overrides (timestamp, sessionId, distinctId).
   */
  trackWithOptions(eventName: string, dims?: Dims, options?: TrackOptions): void {
    if (this.closed) return;

    const ev: Event = {
      event: eventName,
      event_key: generateUlid(),
    };

    if (options?.timestamp) {
      ev.timestamp =
        options.timestamp instanceof Date
          ? options.timestamp.toISOString()
          : options.timestamp;
    }

    ev.session_id = options?.sessionId ?? this.sessionId;

    if (options?.distinctId) {
      ev.distinct_id = options.distinctId;
    }

    if (dims && Object.keys(dims).length > 0) {
      ev.dimensions = { ...dims };
    }

    this.queue.push(ev);
  }

  /**
   * Flush all queued events to the server. Returns when complete.
   * Throws on network or server errors.
   */
  async flush(): Promise<void> {
    const batch = this.drain();
    if (batch.length === 0) return;
    await this.sendBatches(batch);
  }

  /**
   * Flush remaining events and stop the SDK. After close(), track() calls
   * are silently dropped. Returns when the final flush completes.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Stop timers and listeners.
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.unloadHandler && isBrowser()) {
      window.removeEventListener("visibilitychange", this.unloadHandler);
      window.removeEventListener("pagehide", this.unloadHandler);
      this.unloadHandler = null;
    }

    // Final flush.
    const batch = this.drain();
    if (batch.length > 0) {
      await this.sendBatches(batch);
    }
  }

  /** Returns the current session ID. */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Returns the number of events currently queued. */
  queueLength(): number {
    return this.queue.length;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private drain(): Event[] {
    const batch = this.queue;
    this.queue = [];
    return batch;
  }

  private async sendBatches(events: Event[]): Promise<void> {
    while (events.length > 0) {
      const chunk = events.splice(0, MAX_BATCH_SIZE);
      await this.sendChunk(chunk);
    }
  }

  private async sendChunk(events: Event[]): Promise<void> {
    const url = this.config.serverUrl + "/v1/events";
    const body = JSON.stringify({ events });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT);

    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.config.appKey,
          "User-Agent": this.userAgent,
        },
        body,
        signal: controller.signal,
        keepalive: true,
      });

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const data: IngestResponse = await res.json();
          if (data.errors?.length > 0) {
            msg = `HTTP ${res.status}: ${data.errors[0].message}`;
          }
        } catch {
          // ignore parse errors on error responses
        }
        throw new Error(`StatsFactory: server error: ${msg}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Background flush — errors go to onError callback, not thrown. */
  private flushBackground(): void {
    const batch = this.drain();
    if (batch.length === 0) return;

    this.sendBatches(batch).catch((err) => {
      if (this.config.onError) {
        this.config.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Flush via sendBeacon on page unload. Best-effort: no error handling,
   * limited to ~64KB payload. Falls back to nothing if sendBeacon is
   * unavailable or payload is too large.
   */
  private flushBeacon(): void {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      return; // Only flush when actually leaving the page.
    }

    const batch = this.drain();
    if (batch.length === 0) return;

    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // sendBeacon doesn't support custom headers, so we embed the key
      // in the URL as a query param and use a Blob with content-type.
      // However, statsfactory expects Authorization header. We'll send
      // chunks via fetch with keepalive instead, which works on unload
      // in modern browsers.
      const url = this.config.serverUrl + "/v1/events";

      // Split into batches of MAX_BATCH_SIZE.
      while (batch.length > 0) {
        const chunk = batch.splice(0, MAX_BATCH_SIZE);
        const body = JSON.stringify({ events: chunk });

        // Try fetch with keepalive first (supports headers).
        try {
          this.fetchFn(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + this.config.appKey,
              "User-Agent": this.userAgent,
            },
            body,
            keepalive: true,
          }).catch(() => {
            // Best-effort on unload, ignore errors.
          });
        } catch {
          // Synchronous errors from fetch on unload — ignore.
        }
      }
    }
  }
}
