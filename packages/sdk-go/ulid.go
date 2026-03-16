package statsfactory

import (
	"crypto/rand"
	"time"
)

// Crockford base32 encoding alphabet.
const ulidEncoding = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// generateULID creates a ULID (26-char, time-sortable unique ID).
// Uses crypto/rand for the random component.
func generateULID() string {
	now := time.Now().UnixMilli()

	// Encode 48-bit timestamp as 10 Crockford base32 chars.
	var buf [26]byte
	for i := 9; i >= 0; i-- {
		buf[i] = ulidEncoding[now%32]
		now /= 32
	}

	// Encode 80 bits of randomness as 16 Crockford base32 chars.
	var rb [16]byte
	_, _ = rand.Read(rb[:])
	for i := 0; i < 16; i++ {
		buf[10+i] = ulidEncoding[rb[i]%32]
	}

	return string(buf[:])
}
