// Example: Tinct-like telemetry integration with statsfactory.
//
// This demonstrates how a CLI tool like Tinct would use the statsfactory
// Go SDK to track generation events and per-plugin usage analytics.
//
// Usage:
//
//	export STATSFACTORY_URL=https://stats.example.com
//	export STATSFACTORY_KEY=sf_live_xxxx
//	go run .
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	statsfactory "github.com/jmylchreest/statsfactory/packages/sdk-go"
)

// Simulated app version — in a real app this comes from build-time ldflags.
const appVersion = "0.1.27"

func main() {
	serverURL := os.Getenv("STATSFACTORY_URL")
	if serverURL == "" {
		serverURL = "http://localhost:4321"
	}
	appKey := os.Getenv("STATSFACTORY_KEY")
	if appKey == "" {
		fmt.Fprintln(os.Stderr, "Set STATSFACTORY_KEY to your API key")
		os.Exit(1)
	}

	// Create the client — matches how Tinct would initialize telemetry.
	client := statsfactory.New(statsfactory.Config{
		ServerURL:     serverURL,
		AppKey:        appKey,
		ClientName:    "tinct",
		ClientVersion: appVersion,
		FlushInterval: 30 * time.Second,
	})
	defer client.Close()

	fmt.Printf("Session: %s\n", client.SessionID())

	// Track a "generate" event with configuration dimensions.
	// This replaces Tinct's current Aptabase track call for the generate command.
	client.Track("generate", statsfactory.Dims{
		"input.plugin":              "image",
		"input.ai":                  false,
		"generate.theme_type":       "dark",
		"generate.seed_mode":        "content",
		"generate.backend":          "kmeans",
		"generate.extract_ambience": true,
		"generate.dual_theme":       true,
		"generate.dry_run":          false,
	})

	// Track per-plugin events — one per output plugin used.
	// In Aptabase, Tinct had to emit N separate events AND comma-join plugin
	// names into the generate event. With statsfactory, each plugin_used event
	// carries its own structured dimensions, and the dimension matrix can
	// cross-tabulate plugin.name x plugin.version x plugin.status.
	plugins := []struct {
		name, version, status string
		external              bool
	}{
		{"kitty", "0.1.27", "ok", false},
		{"waybar", "0.2.1", "ok", false},
		{"alacritty", "0.1.5", "failed", true},
	}

	for _, p := range plugins {
		client.Track("plugin_used", statsfactory.Dims{
			"plugin.name":     p.name,
			"plugin.version":  p.version,
			"plugin.external": p.external,
			"plugin.status":   p.status,
		})
	}

	// Explicit flush before exit (Close also flushes, but this shows the API).
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Flush(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "Flush error: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Events sent successfully")
}
