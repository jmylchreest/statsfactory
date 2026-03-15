// Package statsfactory provides a Go SDK for the statsfactory analytics platform.
//
// It handles batching, background flushing, structured User-Agent headers, and
// session ID generation. Events are queued locally and sent in batches to the
// statsfactory ingestion API.
//
// Basic usage:
//
//	client := statsfactory.New(statsfactory.Config{
//	    ServerURL:     "https://stats.example.com",
//	    AppKey:        "sf_live_xxxx",
//	    ClientName:    "myapp",
//	    ClientVersion: "1.0.0",
//	})
//	defer client.Close()
//
//	client.Track("page_view", statsfactory.Dims{
//	    "page.path": "/home",
//	})
package statsfactory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"sync"
	"time"
)

// Version is the SDK version included in the User-Agent header.
const Version = "0.1.0"

// maxBatchSize is the maximum number of events per API request.
const maxBatchSize = 25

// defaultFlushInterval is the default time between background flushes.
const defaultFlushInterval = 30 * time.Second

// Dims is a map of dimension key-value pairs attached to an event.
// Values can be string, int, float64, or bool.
type Dims map[string]any

// Config configures a statsfactory Client.
type Config struct {
	// ServerURL is the base URL of the statsfactory server (e.g. "https://stats.example.com").
	// Required.
	ServerURL string

	// AppKey is the API key for authentication (sent as Bearer token).
	// Required.
	AppKey string

	// ClientName is the name of the application using this SDK (e.g. "tinct").
	// Used in the User-Agent header.
	ClientName string

	// ClientVersion is the version of the application (e.g. "0.1.27").
	// Used in the User-Agent header.
	ClientVersion string

	// FlushInterval is the time between automatic background flushes.
	// Defaults to 30 seconds.
	FlushInterval time.Duration

	// HTTPClient is an optional custom HTTP client. If nil, http.DefaultClient is used.
	HTTPClient *http.Client

	// SessionID is an optional pre-set session ID. If empty, one is generated
	// automatically using crypto/rand.
	SessionID string

	// OnError is called when a flush fails. If nil, errors are silently discarded.
	OnError func(err error)
}

// event is a single event queued for sending.
type event struct {
	Event      string         `json:"event"`
	Timestamp  string         `json:"timestamp,omitempty"`
	SessionID  string         `json:"session_id,omitempty"`
	DistinctID string         `json:"distinct_id,omitempty"`
	Dimensions map[string]any `json:"dimensions,omitempty"`
}

// ingestRequest is the JSON body sent to POST /v1/events.
type ingestRequest struct {
	Events []event `json:"events"`
}

// ingestResponse is the JSON body returned from POST /v1/events.
type ingestResponse struct {
	Accepted int `json:"accepted"`
	Errors   []struct {
		Index   int    `json:"index"`
		Message string `json:"message"`
	} `json:"errors"`
}

// Client is a statsfactory analytics client that batches and flushes events.
type Client struct {
	cfg       Config
	userAgent string
	sessionID string

	mu     sync.Mutex
	queue  []event
	closed bool

	httpClient *http.Client

	// Background worker
	stopCh chan struct{}
	doneCh chan struct{}
}

// New creates a new statsfactory Client and starts the background flush worker.
func New(cfg Config) *Client {
	if cfg.FlushInterval <= 0 {
		cfg.FlushInterval = defaultFlushInterval
	}

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	sessionID := cfg.SessionID
	if sessionID == "" {
		sessionID = generateSessionID()
	}

	c := &Client{
		cfg:        cfg,
		userAgent:  buildUserAgent(cfg),
		sessionID:  sessionID,
		queue:      make([]event, 0, maxBatchSize),
		httpClient: httpClient,
		stopCh:     make(chan struct{}),
		doneCh:     make(chan struct{}),
	}

	go c.backgroundWorker()

	return c
}

// Track enqueues an event with the given name and dimensions.
// Track is safe for concurrent use. It does not block on network I/O.
func (c *Client) Track(eventName string, dims Dims) {
	c.TrackWithOptions(eventName, dims, TrackOptions{})
}

// TrackOptions provides optional per-event overrides.
type TrackOptions struct {
	// Timestamp overrides the event timestamp. If zero, the server assigns one.
	Timestamp time.Time

	// SessionID overrides the client-level session ID for this event.
	SessionID string

	// DistinctID is an optional identity for the event.
	DistinctID string
}

// TrackWithOptions enqueues an event with additional options.
func (c *Client) TrackWithOptions(eventName string, dims Dims, opts TrackOptions) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return
	}

	ev := event{
		Event: eventName,
	}

	if !opts.Timestamp.IsZero() {
		ev.Timestamp = opts.Timestamp.UTC().Format(time.RFC3339)
	}

	sid := c.sessionID
	if opts.SessionID != "" {
		sid = opts.SessionID
	}
	ev.SessionID = sid

	if opts.DistinctID != "" {
		ev.DistinctID = opts.DistinctID
	}

	if len(dims) > 0 {
		ev.Dimensions = make(map[string]any, len(dims))
		for k, v := range dims {
			ev.Dimensions[k] = v
		}
	}

	c.queue = append(c.queue, ev)
}

// Flush sends all queued events to the server. It blocks until complete or
// the context is cancelled.
func (c *Client) Flush(ctx context.Context) error {
	c.mu.Lock()
	batch := c.drainLocked()
	c.mu.Unlock()

	return c.sendBatches(ctx, batch)
}

// Close flushes any remaining events and stops the background worker.
// After Close returns, Track calls are silently dropped.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	batch := c.drainLocked()
	c.mu.Unlock()

	// Stop the background worker.
	close(c.stopCh)
	<-c.doneCh

	// Final flush with a generous timeout.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.sendBatches(ctx, batch)
}

// SessionID returns the current session ID.
func (c *Client) SessionID() string {
	return c.sessionID
}

// QueueLen returns the number of events currently queued (useful for testing).
func (c *Client) QueueLen() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.queue)
}

// --- internal ---

// drainLocked moves all queued events out and returns them. Must be called with mu held.
func (c *Client) drainLocked() []event {
	if len(c.queue) == 0 {
		return nil
	}
	batch := c.queue
	c.queue = make([]event, 0, maxBatchSize)
	return batch
}

// sendBatches sends events in chunks of maxBatchSize.
func (c *Client) sendBatches(ctx context.Context, events []event) error {
	for len(events) > 0 {
		n := maxBatchSize
		if n > len(events) {
			n = len(events)
		}
		chunk := events[:n]
		events = events[n:]

		if err := c.sendChunk(ctx, chunk); err != nil {
			return err
		}
	}
	return nil
}

// sendChunk sends a single batch of events to the server.
func (c *Client) sendChunk(ctx context.Context, events []event) error {
	body, err := json.Marshal(ingestRequest{Events: events})
	if err != nil {
		return fmt.Errorf("statsfactory: marshal error: %w", err)
	}

	url := c.cfg.ServerURL + "/v1/events"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("statsfactory: request error: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.cfg.AppKey)
	req.Header.Set("User-Agent", c.userAgent)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("statsfactory: send error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		var ir ingestResponse
		_ = json.NewDecoder(resp.Body).Decode(&ir)
		msg := fmt.Sprintf("HTTP %d", resp.StatusCode)
		if len(ir.Errors) > 0 {
			msg = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, ir.Errors[0].Message)
		}
		return fmt.Errorf("statsfactory: server error: %s", msg)
	}

	return nil
}

// backgroundWorker periodically flushes the event queue.
func (c *Client) backgroundWorker() {
	defer close(c.doneCh)

	ticker := time.NewTicker(c.cfg.FlushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			c.mu.Lock()
			batch := c.drainLocked()
			c.mu.Unlock()

			if len(batch) > 0 {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := c.sendBatches(ctx, batch)
				cancel()

				if err != nil && c.cfg.OnError != nil {
					c.cfg.OnError(err)
				}
			}

		case <-c.stopCh:
			return
		}
	}
}

// buildUserAgent constructs the structured User-Agent header.
// Format: statsfactory-sdk-go/0.1.0 (clientName/clientVersion; os; arch)
func buildUserAgent(cfg Config) string {
	clientPart := ""
	if cfg.ClientName != "" {
		clientPart = cfg.ClientName
		if cfg.ClientVersion != "" {
			clientPart += "/" + cfg.ClientVersion
		}
	}

	if clientPart != "" {
		return fmt.Sprintf("statsfactory-sdk-go/%s (%s; %s; %s)",
			Version, clientPart, runtime.GOOS, runtime.GOARCH)
	}

	return fmt.Sprintf("statsfactory-sdk-go/%s (%s; %s)",
		Version, runtime.GOOS, runtime.GOARCH)
}
