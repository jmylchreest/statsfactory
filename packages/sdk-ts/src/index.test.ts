import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatsFactory, VERSION } from "./index";
import type { Dims } from "./index";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Captured request from the mock fetch. */
interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: { events: Array<Record<string, unknown>> };
}

/**
 * Creates a mock fetch that captures requests and returns a configurable response.
 */
function mockFetch(status = 200, responseBody: unknown = { accepted: 1, errors: [] }) {
  const requests: CapturedRequest[] = [];

  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    requests.push({
      url: typeof url === "string" ? url : url.toString(),
      init: init ?? {},
      body: bodyText ? JSON.parse(bodyText) : {},
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });

  return { fn: fn as unknown as typeof fetch, requests };
}

/** Create an SDK instance with mock fetch and auto-flush disabled. */
function createClient(
  overrides?: Partial<ConstructorParameters<typeof StatsFactory>[0]>,
  fetchStatus = 200,
) {
  const mock = mockFetch(fetchStatus);
  const client = new StatsFactory({
    serverUrl: "https://stats.test",
    appKey: "sf_live_testkey",
    flushInterval: 0, // disable auto-flush for deterministic tests
    useBeacon: false,
    fetch: mock.fn,
    ...overrides,
  });
  return { client, mock };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("StatsFactory", () => {
  describe("constructor", () => {
    it("throws if serverUrl is missing", () => {
      expect(
        () => new StatsFactory({ serverUrl: "", appKey: "sf_live_x" }),
      ).toThrow("serverUrl is required");
    });

    it("throws if appKey is missing", () => {
      expect(
        () => new StatsFactory({ serverUrl: "https://x", appKey: "" }),
      ).toThrow("appKey is required");
    });

    it("accepts valid config", () => {
      const { client } = createClient();
      expect(client).toBeInstanceOf(StatsFactory);
      client.close();
    });
  });

  describe("track", () => {
    it("enqueues an event", () => {
      const { client } = createClient();
      client.track("page_view", { "page.path": "/home" });
      expect(client.queueLength()).toBe(1);
      client.close();
    });

    it("enqueues without dimensions", () => {
      const { client } = createClient();
      client.track("app_open");
      expect(client.queueLength()).toBe(1);
      client.close();
    });

    it("is silently dropped after close", async () => {
      const { client } = createClient();
      await client.close();
      client.track("should_be_dropped");
      expect(client.queueLength()).toBe(0);
    });

    it("supports all dimension value types", () => {
      const { client } = createClient();
      const dims: Dims = {
        "str.dim": "hello",
        "num.dim": 42,
        "bool.dim": true,
      };
      client.track("test_event", dims);
      expect(client.queueLength()).toBe(1);
      client.close();
    });
  });

  describe("trackWithOptions", () => {
    it("includes timestamp as ISO string", async () => {
      const { client, mock } = createClient();
      client.trackWithOptions("ev", {}, {
        timestamp: "2026-03-15T10:00:00Z",
      });
      await client.flush();

      expect(mock.requests).toHaveLength(1);
      const event = mock.requests[0].body.events[0];
      expect(event.timestamp).toBe("2026-03-15T10:00:00Z");
    });

    it("converts Date to ISO string", async () => {
      const { client, mock } = createClient();
      const date = new Date("2026-06-01T12:00:00Z");
      client.trackWithOptions("ev", {}, { timestamp: date });
      await client.flush();

      const event = mock.requests[0].body.events[0];
      expect(event.timestamp).toBe("2026-06-01T12:00:00.000Z");
    });

    it("overrides session ID per event", async () => {
      const { client, mock } = createClient();
      client.trackWithOptions("ev", {}, { sessionId: "custom-session" });
      await client.flush();

      const event = mock.requests[0].body.events[0];
      expect(event.session_id).toBe("custom-session");
    });

    it("includes distinct ID", async () => {
      const { client, mock } = createClient();
      client.trackWithOptions("ev", {}, { distinctId: "user-hash" });
      await client.flush();

      const event = mock.requests[0].body.events[0];
      expect(event.distinct_id).toBe("user-hash");
    });
  });

  describe("flush", () => {
    it("sends queued events via fetch", async () => {
      const { client, mock } = createClient();
      client.track("page_view", { "page.path": "/home" });
      await client.flush();

      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].url).toBe("https://stats.test/v1/events");
      expect(mock.requests[0].body.events).toHaveLength(1);
      expect(mock.requests[0].body.events[0].event).toBe("page_view");
      expect(mock.requests[0].body.events[0].dimensions).toEqual({
        "page.path": "/home",
      });
    });

    it("includes Authorization header", async () => {
      const { client, mock } = createClient();
      client.track("ev");
      await client.flush();

      const headers = mock.requests[0].init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sf_live_testkey");
    });

    it("includes User-Agent header", async () => {
      const { client, mock } = createClient({
        clientName: "myapp",
        clientVersion: "1.2.3",
      });
      client.track("ev");
      await client.flush();

      const headers = mock.requests[0].init.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(
        `statsfactory-sdk-ts/${VERSION} (myapp/1.2.3)`,
      );
    });

    it("User-Agent works without client version", async () => {
      const { client, mock } = createClient({ clientName: "myapp" });
      client.track("ev");
      await client.flush();

      const headers = mock.requests[0].init.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(
        `statsfactory-sdk-ts/${VERSION} (myapp)`,
      );
    });

    it("does nothing when queue is empty", async () => {
      const { client, mock } = createClient();
      await client.flush();
      expect(mock.requests).toHaveLength(0);
    });

    it("clears the queue after flush", async () => {
      const { client } = createClient();
      client.track("ev1");
      client.track("ev2");
      expect(client.queueLength()).toBe(2);
      await client.flush();
      expect(client.queueLength()).toBe(0);
    });

    it("throws on server error", async () => {
      const { client } = createClient(undefined, 400);
      client.track("ev");
      await expect(client.flush()).rejects.toThrow("server error: HTTP 400");
    });

    it("includes server error message from response", async () => {
      const mock = mockFetch(422, {
        accepted: 0,
        errors: [{ index: 0, message: 'Invalid event name "BAD"' }],
      });
      const client = new StatsFactory({
        serverUrl: "https://stats.test",
        appKey: "sf_live_x",
        flushInterval: 0,
        useBeacon: false,
        fetch: mock.fn,
      });
      client.track("ev");
      await expect(client.flush()).rejects.toThrow('Invalid event name "BAD"');
      await client.close();
    });
  });

  describe("batching", () => {
    it("splits into batches of 25", async () => {
      const { client, mock } = createClient();

      for (let i = 0; i < 60; i++) {
        client.track(`event_${i}`);
      }
      expect(client.queueLength()).toBe(60);

      await client.flush();

      // 60 events = 3 batches: 25 + 25 + 10
      expect(mock.requests).toHaveLength(3);
      expect(mock.requests[0].body.events).toHaveLength(25);
      expect(mock.requests[1].body.events).toHaveLength(25);
      expect(mock.requests[2].body.events).toHaveLength(10);
    });

    it("exactly 25 events sends one batch", async () => {
      const { client, mock } = createClient();

      for (let i = 0; i < 25; i++) {
        client.track(`event_${i}`);
      }
      await client.flush();

      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].body.events).toHaveLength(25);
    });
  });

  describe("session ID", () => {
    it("generates a session ID automatically", () => {
      const { client } = createClient();
      const sid = client.getSessionId();
      expect(sid).toBeTruthy();
      expect(typeof sid).toBe("string");
      expect(sid.length).toBeGreaterThanOrEqual(16);
      client.close();
    });

    it("uses provided session ID", () => {
      const { client } = createClient({ sessionId: "my-session-123" });
      expect(client.getSessionId()).toBe("my-session-123");
      client.close();
    });

    it("attaches session ID to events", async () => {
      const { client, mock } = createClient({ sessionId: "sess-abc" });
      client.track("ev");
      await client.flush();

      expect(mock.requests[0].body.events[0].session_id).toBe("sess-abc");
    });
  });

  describe("close", () => {
    it("flushes remaining events", async () => {
      const { client, mock } = createClient();
      client.track("ev1");
      client.track("ev2");
      await client.close();

      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].body.events).toHaveLength(2);
    });

    it("is idempotent", async () => {
      const { client, mock } = createClient();
      client.track("ev");
      await client.close();
      await client.close(); // should not throw or double-flush

      expect(mock.requests).toHaveLength(1);
    });
  });

  describe("auto flush", () => {
    it("flushes on interval", async () => {
      vi.useFakeTimers();
      const mock = mockFetch();
      const client = new StatsFactory({
        serverUrl: "https://stats.test",
        appKey: "sf_live_x",
        flushInterval: 5000,
        useBeacon: false,
        fetch: mock.fn,
      });

      client.track("ev");
      expect(mock.requests).toHaveLength(0);

      // Advance the timer and let all async work (microtasks + timers) settle.
      await vi.advanceTimersByTimeAsync(5000);

      expect(mock.requests.length).toBeGreaterThanOrEqual(1);

      vi.useRealTimers();
      await client.close();
    });
  });

  describe("onError callback", () => {
    it("calls onError on background flush failure", async () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const mock = mockFetch(500);
      const client = new StatsFactory({
        serverUrl: "https://stats.test",
        appKey: "sf_live_x",
        flushInterval: 1000,
        useBeacon: false,
        fetch: mock.fn,
        onError,
      });

      client.track("ev");

      // Advance the timer and let all async work (microtasks + timers) settle.
      await vi.advanceTimersByTimeAsync(1000);

      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);

      vi.useRealTimers();
      await client.close();
    });
  });

  describe("wire format", () => {
    it("matches the Go SDK wire format", async () => {
      const { client, mock } = createClient({ sessionId: "test-session" });
      client.trackWithOptions(
        "plugin_used",
        {
          "plugin.name": "kitty",
          "plugin.version": "0.1.27",
          "plugin.external": false,
          "plugin.status": "ok",
        },
        {
          timestamp: "2026-03-15T10:00:00Z",
          distinctId: "install-hash",
        },
      );
      await client.flush();

      const event = mock.requests[0].body.events[0];
      // Matches Go SDK's event struct JSON tags exactly.
      expect(event).toEqual({
        event: "plugin_used",
        timestamp: "2026-03-15T10:00:00Z",
        session_id: "test-session",
        distinct_id: "install-hash",
        dimensions: {
          "plugin.name": "kitty",
          "plugin.version": "0.1.27",
          "plugin.external": false,
          "plugin.status": "ok",
        },
      });
    });

    it("omits optional fields when not provided", async () => {
      const { client, mock } = createClient({ sessionId: "s" });
      client.track("simple_event");
      await client.flush();

      const event = mock.requests[0].body.events[0];
      expect(event.event).toBe("simple_event");
      expect(event.session_id).toBe("s");
      expect(event).not.toHaveProperty("timestamp");
      expect(event).not.toHaveProperty("distinct_id");
      expect(event).not.toHaveProperty("dimensions");
    });
  });
});
