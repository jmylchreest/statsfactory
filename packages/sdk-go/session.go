package statsfactory

import (
	"crypto/rand"
	"encoding/hex"
)

// generateSessionID creates a random 16-byte hex-encoded session ID (32 chars).
func generateSessionID() string {
	b := make([]byte, 16)
	_, err := rand.Read(b)
	if err != nil {
		// Extremely unlikely; crypto/rand should always work.
		// Fall back to a zero session ID rather than panicking.
		return "0000000000000000"
	}
	return hex.EncodeToString(b)
}
