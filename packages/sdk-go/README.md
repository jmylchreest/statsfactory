# statsfactory Go SDK

Go client for the statsfactory analytics API. Handles batching, background
flushing, structured User-Agent headers, and session ID generation.

## Install

```bash
go get github.com/jmylchreest/statsfactory/packages/sdk-go
```

## Usage

```go
package main

import (
    "context"
    statsfactory "github.com/jmylchreest/statsfactory/packages/sdk-go"
)

func main() {
    client := statsfactory.New(statsfactory.Config{
        ServerURL:     "https://stats.example.com",
        AppKey:        "sf_live_xxxx",
        ClientName:    "myapp",
        ClientVersion: "1.0.0",
    })
    defer client.Close()

    client.Track("page_view", statsfactory.Dims{
        "page.path": "/home",
        "theme":     "dark",
    })

    // Events are flushed automatically every 30s,
    // or on Close(). Force an immediate flush:
    client.Flush(context.Background())
}
```

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `ServerURL` | (required) | statsfactory API base URL |
| `AppKey` | (required) | App key (`sf_live_...`) |
| `ClientName` | (required) | Your app name (used in User-Agent) |
| `ClientVersion` | (required) | Your app version (used in User-Agent) |
| `FlushInterval` | 30s | Background flush interval |
| `HTTPClient` | `http.DefaultClient` | Custom HTTP client |
| `SessionID` | auto-generated | Override session ID |
| `OnError` | no-op | Callback for flush errors |

## Dimensions

Dimensions are `map[string]any` values. Up to **25 user-provided dimensions**
per event. The server may add up to 9 additional enriched dimensions (geo,
network, UA). Supported types: `string`, `int`, `float64`, `bool`. Use
dot-notation to group related dimensions:

```go
client.Track("plugin_used", statsfactory.Dims{
    "plugin.name":     "kitty",
    "plugin.version":  "0.1.27",
    "plugin.external": false,
    "plugin.status":   "ok",
})
```

## Advanced

### Event Key (event correlation)

Every event is automatically assigned an `event_key` (a ULID) that uniquely
identifies it within a batch. This is used server-side to merge multiple batch
items into a single logical event when they share the same `event_key` and
event name.

This is transparent to normal usage -- the SDK handles it automatically. It
enables future scenarios where an SDK needs to split a large dimension set
across multiple batch items for the same logical event.

### Override timestamp, session ID, or distinct ID per event

```go
client.TrackWithOptions("event_name", statsfactory.Dims{...}, statsfactory.TrackOptions{
    Timestamp:  time.Now().Add(-1 * time.Hour),
    SessionID:  "custom-session",
    DistinctID: "user-hash",
})
```

## Testing

```bash
go test ./...
```

## Example

See [contrib/examples/go/](../../contrib/examples/go/) for a complete example
simulating a CLI tool integration.
