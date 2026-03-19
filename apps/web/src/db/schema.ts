import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

// ── Apps ────────────────────────────────────────────────────────────────────

export const apps = sqliteTable("apps", {
  id: text("id").primaryKey(), // ULID
  name: text("name").notNull(),
  retentionDays: integer("retention_days").notNull().default(90),
  enabledDims: text("enabled_dims").notNull().default("[]"), // JSON array of enabled enriched dim keys
  createdAt: text("created_at").notNull(),
});

// ── App Keys ────────────────────────────────────────────────────────────────
// App keys identify which app/project events belong to.
// They are public keys embedded in client applications for ingest only.
// Dashboard/management auth is handled by Cloudflare Access (Zero Trust).

export const appKeys = sqliteTable("app_keys", {
  id: text("id").primaryKey(), // ULID
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  keyHash: text("key_hash").notNull(), // SHA-256 of the full key (for auth lookup)
  keyPrefix: text("key_prefix").notNull(), // first 8 chars (legacy, kept for compat)
  rawKey: text("raw_key"), // full key stored in plain text (not a secret — ingest-only identifier)
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
});

// ── Events ──────────────────────────────────────────────────────────────────

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(), // ULID (time-sortable)
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    eventName: text("event_name").notNull(),
    timestamp: text("timestamp").notNull(), // ISO 8601, client-provided
    sessionId: text("session_id"),
    distinctId: text("distinct_id"),
    createdAt: text("created_at").notNull(), // server receive time
  },
  (table) => [
    index("idx_events_app_time").on(table.appId, table.timestamp),
    index("idx_events_app_name_time").on(table.appId, table.eventName, table.timestamp),
    index("idx_events_session").on(table.appId, table.sessionId),
  ],
);

// ── Event Dimensions (EAV) ──────────────────────────────────────────────────

export const eventDimensions = sqliteTable(
  "event_dimensions",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    dimKey: text("dim_key").notNull(),
    dimValue: text("dim_value").notNull(),
    dimType: text("dim_type", {
      enum: ["string", "number", "boolean", "array"],
    })
      .notNull()
      .default("string"),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.dimKey] }),
    index("idx_dims_key_value").on(table.dimKey, table.dimValue),
    index("idx_dims_event").on(table.eventId),
  ],
);

