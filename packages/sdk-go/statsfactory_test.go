package statsfactory

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"testing"
	"time"
)

// capturedRequest holds the data from a single request to the mock server.
type capturedRequest struct {
	Method    string
	Path      string
	UserAgent string
	AuthToken string
	Body      ingestRequest
}

// mockServer creates an httptest server that captures requests and returns 200.
func mockServer(t *testing.T) (*httptest.Server, *[]capturedRequest) {
	t.Helper()
	var mu sync.Mutex
	var captured []capturedRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body ingestRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("mock server: decode error: %v", err)
			w.WriteHeader(400)
			return
		}

		mu.Lock()
		captured = append(captured, capturedRequest{
			Method:    r.Method,
			Path:      r.URL.Path,
			UserAgent: r.Header.Get("User-Agent"),
			AuthToken: r.Header.Get("Authorization"),
			Body:      body,
		})
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ingestResponse{
			Accepted: len(body.Events),
		})
	}))

	t.Cleanup(srv.Close)
	return srv, &captured
}

func getCaptured(captured *[]capturedRequest) []capturedRequest {
	return *captured
}

func TestTrackQueuesEvents(t *testing.T) {
	srv, _ := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "test-key",
		FlushInterval: time.Hour, // don't auto-flush
	})
	defer c.Close()

	c.Track("event_one", Dims{"key": "value"})
	c.Track("event_two", nil)
	c.Track("event_three", Dims{"a": 1, "b": true})

	if got := c.QueueLen(); got != 3 {
		t.Fatalf("QueueLen = %d, want 3", got)
	}
}

func TestFlushSendsEvents(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "test-key-123",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	c.Track("hello", Dims{"greeting": "world"})
	c.Track("bye", nil)

	if err := c.Flush(context.Background()); err != nil {
		t.Fatalf("Flush error: %v", err)
	}

	if c.QueueLen() != 0 {
		t.Fatalf("QueueLen after flush = %d, want 0", c.QueueLen())
	}

	reqs := getCaptured(captured)
	if len(reqs) != 1 {
		t.Fatalf("got %d requests, want 1", len(reqs))
	}

	req := reqs[0]
	if req.Method != "POST" {
		t.Errorf("Method = %q, want POST", req.Method)
	}
	if req.Path != "/v1/events" {
		t.Errorf("Path = %q, want /v1/events", req.Path)
	}
	if req.AuthToken != "Bearer test-key-123" {
		t.Errorf("Auth = %q, want Bearer test-key-123", req.AuthToken)
	}
	if len(req.Body.Events) != 2 {
		t.Fatalf("events count = %d, want 2", len(req.Body.Events))
	}
	if req.Body.Events[0].Event != "hello" {
		t.Errorf("events[0].Event = %q, want hello", req.Body.Events[0].Event)
	}
	if req.Body.Events[1].Event != "bye" {
		t.Errorf("events[1].Event = %q, want bye", req.Body.Events[1].Event)
	}
}

func TestFlushBatchesByMaxSize(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	// Queue 30 events — should be sent in 2 batches (25 + 5).
	for i := range 30 {
		c.Track("event", Dims{"i": i})
	}

	if err := c.Flush(context.Background()); err != nil {
		t.Fatalf("Flush error: %v", err)
	}

	reqs := getCaptured(captured)
	if len(reqs) != 2 {
		t.Fatalf("got %d requests, want 2 (batch split)", len(reqs))
	}
	if len(reqs[0].Body.Events) != 25 {
		t.Errorf("batch 0 size = %d, want 25", len(reqs[0].Body.Events))
	}
	if len(reqs[1].Body.Events) != 5 {
		t.Errorf("batch 1 size = %d, want 5", len(reqs[1].Body.Events))
	}
}

func TestFlushEmptyQueueIsNoop(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	if err := c.Flush(context.Background()); err != nil {
		t.Fatalf("Flush error: %v", err)
	}

	if len(getCaptured(captured)) != 0 {
		t.Fatal("expected no requests for empty flush")
	}
}

func TestCloseFlushesRemainingEvents(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})

	c.Track("final_event", Dims{"last": true})
	c.Close()

	reqs := getCaptured(captured)
	if len(reqs) != 1 {
		t.Fatalf("got %d requests, want 1", len(reqs))
	}
	if reqs[0].Body.Events[0].Event != "final_event" {
		t.Errorf("event = %q, want final_event", reqs[0].Body.Events[0].Event)
	}
}

func TestCloseDropsSubsequentTracks(t *testing.T) {
	srv, _ := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})

	c.Close()
	c.Track("should_be_dropped", nil)

	if c.QueueLen() != 0 {
		t.Fatal("Track after Close should be dropped")
	}
}

func TestDoubleCloseIsIdempotent(t *testing.T) {
	srv, _ := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})

	if err := c.Close(); err != nil {
		t.Fatalf("first Close error: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("second Close error: %v", err)
	}
}

func TestUserAgentWithClient(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		ClientName:    "tinct",
		ClientVersion: "0.1.27",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	c.Track("test", nil)
	c.Flush(context.Background())

	reqs := getCaptured(captured)
	if len(reqs) != 1 {
		t.Fatalf("got %d requests, want 1", len(reqs))
	}

	want := "statsfactory-sdk-go/" + Version + " (tinct/0.1.27; " + runtime.GOOS + "; " + runtime.GOARCH + ")"
	if reqs[0].UserAgent != want {
		t.Errorf("User-Agent = %q, want %q", reqs[0].UserAgent, want)
	}
}

func TestUserAgentWithoutClient(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	c.Track("test", nil)
	c.Flush(context.Background())

	reqs := getCaptured(captured)
	want := "statsfactory-sdk-go/" + Version + " (" + runtime.GOOS + "; " + runtime.GOARCH + ")"
	if reqs[0].UserAgent != want {
		t.Errorf("User-Agent = %q, want %q", reqs[0].UserAgent, want)
	}
}

func TestUserAgentClientNameOnly(t *testing.T) {
	ua := buildUserAgent(Config{ClientName: "myapp"})
	want := "statsfactory-sdk-go/" + Version + " (myapp; " + runtime.GOOS + "; " + runtime.GOARCH + ")"
	if ua != want {
		t.Errorf("User-Agent = %q, want %q", ua, want)
	}
}

func TestSessionIDGenerated(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	sid := c.SessionID()
	if len(sid) != 32 {
		t.Fatalf("SessionID length = %d, want 32 (hex-encoded 16 bytes)", len(sid))
	}

	c.Track("test", nil)
	c.Flush(context.Background())

	reqs := getCaptured(captured)
	if reqs[0].Body.Events[0].SessionID != sid {
		t.Errorf("event session_id = %q, want %q", reqs[0].Body.Events[0].SessionID, sid)
	}
}

func TestSessionIDCustom(t *testing.T) {
	srv, _ := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		SessionID:     "custom-session-id",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	if c.SessionID() != "custom-session-id" {
		t.Errorf("SessionID = %q, want custom-session-id", c.SessionID())
	}
}

func TestSessionIDUniqueness(t *testing.T) {
	seen := make(map[string]bool)
	for range 100 {
		id := generateSessionID()
		if seen[id] {
			t.Fatalf("duplicate session ID: %s", id)
		}
		seen[id] = true
	}
}

func TestTrackWithOptions(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	ts := time.Date(2026, 3, 14, 10, 30, 0, 0, time.UTC)
	c.TrackWithOptions("custom", Dims{"key": "val"}, TrackOptions{
		Timestamp:  ts,
		SessionID:  "override-session",
		DistinctID: "user-123",
	})

	c.Flush(context.Background())

	reqs := getCaptured(captured)
	ev := reqs[0].Body.Events[0]

	if ev.Timestamp != "2026-03-14T10:30:00Z" {
		t.Errorf("Timestamp = %q, want 2026-03-14T10:30:00Z", ev.Timestamp)
	}
	if ev.SessionID != "override-session" {
		t.Errorf("SessionID = %q, want override-session", ev.SessionID)
	}
	if ev.DistinctID != "user-123" {
		t.Errorf("DistinctID = %q, want user-123", ev.DistinctID)
	}
}

func TestDimensionTypes(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	c.Track("typed", Dims{
		"string_dim": "hello",
		"int_dim":    42,
		"float_dim":  3.14,
		"bool_dim":   true,
		"bool_false": false,
	})

	c.Flush(context.Background())

	reqs := getCaptured(captured)
	dims := reqs[0].Body.Events[0].Dimensions

	// JSON round-trips through any, so verify types survived.
	if s, ok := dims["string_dim"].(string); !ok || s != "hello" {
		t.Errorf("string_dim = %v (%T), want hello", dims["string_dim"], dims["string_dim"])
	}
	// JSON numbers decode as float64.
	if n, ok := dims["int_dim"].(float64); !ok || n != 42 {
		t.Errorf("int_dim = %v (%T), want 42", dims["int_dim"], dims["int_dim"])
	}
	if f, ok := dims["float_dim"].(float64); !ok || f != 3.14 {
		t.Errorf("float_dim = %v (%T), want 3.14", dims["float_dim"], dims["float_dim"])
	}
	if b, ok := dims["bool_dim"].(bool); !ok || !b {
		t.Errorf("bool_dim = %v (%T), want true", dims["bool_dim"], dims["bool_dim"])
	}
	if b, ok := dims["bool_false"].(bool); !ok || b {
		t.Errorf("bool_false = %v (%T), want false", dims["bool_false"], dims["bool_false"])
	}
}

func TestServerErrorReturnsError(t *testing.T) {
	errSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		json.NewEncoder(w).Encode(ingestResponse{
			Accepted: 0,
			Errors: []struct {
				Index   int    `json:"index"`
				Message string `json:"message"`
			}{{Index: -1, Message: "Invalid API key"}},
		})
	}))
	defer errSrv.Close()

	c := New(Config{
		ServerURL:     errSrv.URL,
		AppKey:        "bad-key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	c.Track("test", nil)
	err := c.Flush(context.Background())
	if err == nil {
		t.Fatal("expected error on 401")
	}

	if got := err.Error(); got != "statsfactory: server error: HTTP 401: Invalid API key" {
		t.Errorf("error = %q", got)
	}
}

func TestFlushRespectsContextCancellation(t *testing.T) {
	// Server that blocks until the test is done.
	unblock := make(chan struct{})
	slowSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-unblock
		w.WriteHeader(200)
	}))
	defer slowSrv.Close()
	defer close(unblock) // unblock server goroutine on test exit

	c := New(Config{
		ServerURL:     slowSrv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	c.Track("test", nil)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	err := c.Flush(ctx)
	if err == nil {
		t.Fatal("expected error from cancelled context")
	}
}

func TestBackgroundWorkerFlushes(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: 50 * time.Millisecond, // fast flush for test
	})
	defer c.Close()

	c.Track("bg_event", Dims{"bg": true})

	// Wait for the background worker to fire.
	time.Sleep(200 * time.Millisecond)

	reqs := getCaptured(captured)
	if len(reqs) == 0 {
		t.Fatal("background worker did not flush events")
	}
	if reqs[0].Body.Events[0].Event != "bg_event" {
		t.Errorf("event = %q, want bg_event", reqs[0].Body.Events[0].Event)
	}
}

func TestConcurrentTracking(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	var wg sync.WaitGroup
	for i := range 100 {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			c.Track("concurrent", Dims{"n": n})
		}(i)
	}
	wg.Wait()

	if c.QueueLen() != 100 {
		t.Fatalf("QueueLen = %d, want 100", c.QueueLen())
	}

	c.Flush(context.Background())

	reqs := getCaptured(captured)
	total := 0
	for _, r := range reqs {
		total += len(r.Body.Events)
	}
	if total != 100 {
		t.Fatalf("total events sent = %d, want 100", total)
	}
}

func TestDimensionsAreCopied(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	dims := Dims{"key": "original"}
	c.Track("test", dims)

	// Mutate the original map after Track — should not affect queued event.
	dims["key"] = "mutated"
	dims["extra"] = "added"

	c.Flush(context.Background())

	reqs := getCaptured(captured)
	ev := reqs[0].Body.Events[0]
	if v, ok := ev.Dimensions["key"].(string); !ok || v != "original" {
		t.Errorf("dim key = %v, want original (dims were not copied)", ev.Dimensions["key"])
	}
	if _, ok := ev.Dimensions["extra"]; ok {
		t.Error("extra dim should not exist (dims were not copied)")
	}
}

func TestNilDimensionsOmitted(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	c.Track("no_dims", nil)
	c.Flush(context.Background())

	reqs := getCaptured(captured)
	ev := reqs[0].Body.Events[0]
	if ev.Dimensions != nil {
		t.Errorf("expected nil dimensions, got %v", ev.Dimensions)
	}
}

func TestArrayDimensionValues(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	c.Track("plugin_used", Dims{
		"plugin.name":    "kitty",
		"output.plugins": []string{"kitty", "waybar"},
		"scores":         []any{1, 2, 3},
		"mixed":          []any{"hello", 42, true},
	})

	c.Flush(context.Background())

	reqs := getCaptured(captured)
	dims := reqs[0].Body.Events[0].Dimensions

	// Scalar dim preserved
	if s, ok := dims["plugin.name"].(string); !ok || s != "kitty" {
		t.Errorf("plugin.name = %v (%T), want kitty", dims["plugin.name"], dims["plugin.name"])
	}

	// Array dims round-trip through JSON as []interface{}
	plugins, ok := dims["output.plugins"].([]interface{})
	if !ok {
		t.Fatalf("output.plugins = %v (%T), want []interface{}", dims["output.plugins"], dims["output.plugins"])
	}
	if len(plugins) != 2 {
		t.Fatalf("output.plugins length = %d, want 2", len(plugins))
	}
	if plugins[0] != "kitty" || plugins[1] != "waybar" {
		t.Errorf("output.plugins = %v, want [kitty waybar]", plugins)
	}

	scores, ok := dims["scores"].([]interface{})
	if !ok {
		t.Fatalf("scores = %v (%T), want []interface{}", dims["scores"], dims["scores"])
	}
	if len(scores) != 3 {
		t.Fatalf("scores length = %d, want 3", len(scores))
	}
	// JSON numbers decode as float64
	if scores[0] != float64(1) || scores[1] != float64(2) || scores[2] != float64(3) {
		t.Errorf("scores = %v, want [1 2 3]", scores)
	}

	mixed, ok := dims["mixed"].([]interface{})
	if !ok {
		t.Fatalf("mixed = %v (%T), want []interface{}", dims["mixed"], dims["mixed"])
	}
	if len(mixed) != 3 {
		t.Fatalf("mixed length = %d, want 3", len(mixed))
	}
	if mixed[0] != "hello" || mixed[1] != float64(42) || mixed[2] != true {
		t.Errorf("mixed = %v, want [hello 42 true]", mixed)
	}
}

func TestArrayDimensionsAreCopied(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	tags := []string{"kitty", "waybar"}
	dims := Dims{"tags": tags}
	c.Track("test", dims)

	// Mutate the original slice after Track — should not affect queued event.
	tags[0] = "mutated"

	c.Flush(context.Background())

	reqs := getCaptured(captured)
	ev := reqs[0].Body.Events[0]
	arr, ok := ev.Dimensions["tags"].([]interface{})
	if !ok {
		t.Fatalf("tags = %v (%T), want []interface{}", ev.Dimensions["tags"], ev.Dimensions["tags"])
	}
	if arr[0] != "kitty" {
		t.Errorf("tags[0] = %v, want kitty (slice was not deep-copied)", arr[0])
	}
	if arr[1] != "waybar" {
		t.Errorf("tags[1] = %v, want waybar", arr[1])
	}
}

func TestOnErrorCallback(t *testing.T) {
	errSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer errSrv.Close()

	var gotErr error
	var mu sync.Mutex

	c := New(Config{
		ServerURL:     errSrv.URL,
		AppKey:        "key",
		FlushInterval: 50 * time.Millisecond,
		OnError: func(err error) {
			mu.Lock()
			gotErr = err
			mu.Unlock()
		},
	})
	defer c.Close()

	c.Track("fail", nil)

	// Wait for background worker to attempt flush.
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if gotErr == nil {
		t.Fatal("OnError was not called")
	}
}

func TestEventKeyGenerated(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	c.Track("ev1", nil)
	c.Flush(context.Background())

	reqs := getCaptured(captured)
	ev := reqs[0].Body.Events[0]

	if ev.EventKey == "" {
		t.Fatal("expected event_key to be set, got empty")
	}
	if len(ev.EventKey) != 26 {
		t.Errorf("expected event_key length 26, got %d: %q", len(ev.EventKey), ev.EventKey)
	}
}

func TestEventKeyUnique(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	for i := 0; i < 10; i++ {
		c.Track("ev", nil)
	}
	c.Flush(context.Background())

	reqs := getCaptured(captured)
	seen := make(map[string]bool)
	for _, ev := range reqs[0].Body.Events {
		if seen[ev.EventKey] {
			t.Fatalf("duplicate event_key: %s", ev.EventKey)
		}
		seen[ev.EventKey] = true
	}
}

func TestEventKeyInWireFormat(t *testing.T) {
	srv, captured := mockServer(t)

	c := New(Config{
		ServerURL:     srv.URL,
		AppKey:        "key",
		FlushInterval: time.Hour,
	})
	defer c.Close()

	c.Track("test_event", Dims{"key": "val"})
	c.Flush(context.Background())

	// Verify the raw JSON contains "event_key"
	reqs := getCaptured(captured)
	ev := reqs[0].Body.Events[0]

	if ev.Event != "test_event" {
		t.Errorf("event name = %q, want %q", ev.Event, "test_event")
	}
	if ev.EventKey == "" {
		t.Fatal("event_key missing from wire format")
	}
}
