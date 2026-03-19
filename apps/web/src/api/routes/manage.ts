import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { ulid } from "../lib/ulid";
import { generateApiKey } from "../lib/crypto";
import {
  CreateAppSchema,
  CreateAppResponseSchema,
  UpdateAppSchema,
  UpdateAppResponseSchema,
  DeleteAppResponseSchema,
  ListAppsResponseSchema,
  CreateKeySchema,
  CreateKeyResponseSchema,
  ListKeysResponseSchema,
  RevokeKeyResponseSchema,
  AppIdParamSchema,
  KeyIdParamSchema,
  ErrorResponseSchema,
} from "../lib/schemas";
import { apps, appKeys } from "../../db/schema";
import { DEFAULT_ENABLED_DIMS, invalidateAppConfig } from "../middleware/enrich";
import type { AppEnv } from "../index";

export const manageRouter = new OpenAPIHono<AppEnv>();

/** Parse the JSON-encoded enabled_dims column. Empty arrays fall back to defaults. */
function parseEnabledDims(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // fall through
  }
  return [...DEFAULT_ENABLED_DIMS];
}

// ── POST /v1/apps ───────────────────────────────────────────────────────────

const createAppRoute = createRoute({
  method: "post",
  path: "/apps",
  tags: ["Management"],
  summary: "Create a new app",
  description:
    "Create a new analytics application. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    body: {
      content: { "application/json": { schema: CreateAppSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CreateAppResponseSchema } },
      description: "App created.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid request body.",
    },
  },
});

manageRouter.openapi(createAppRoute, async (c) => {
  const body = c.req.valid("json");
  const db = c.get("db");
  const id = ulid();
  const now = new Date().toISOString();

  await db.insert(apps).values({
    id,
    name: body.name,
    retentionDays: body.retention_days ?? 90,
    enabledDims: JSON.stringify(body.enabled_dims ?? DEFAULT_ENABLED_DIMS),
    createdAt: now,
  });

  return c.json({ id, name: body.name }, 201);
});

// ── GET /v1/apps ────────────────────────────────────────────────────────────

const listAppsRoute = createRoute({
  method: "get",
  path: "/apps",
  tags: ["Management"],
  summary: "List all apps",
  description:
    "List all analytics applications. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: ListAppsResponseSchema } },
      description: "List of apps.",
    },
  },
});

manageRouter.openapi(listAppsRoute, async (c) => {
  const db = c.get("db");
  const allApps = await db.select().from(apps);
  return c.json({
    apps: allApps.map((a) => ({
      ...a,
      enabledDims: parseEnabledDims(a.enabledDims),
    })),
  });
});

// ── POST /v1/apps/:appId/keys ───────────────────────────────────────────────

const createKeyRoute = createRoute({
  method: "post",
  path: "/apps/{appId}/keys",
  tags: ["Management"],
  summary: "Create an app key",
  description:
    "Create an app key for event ingestion. The key is stored and can be retrieved later via the list endpoint. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    params: AppIdParamSchema,
    body: {
      content: { "application/json": { schema: CreateKeySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CreateKeyResponseSchema } },
      description: "Key created.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid request body.",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "App not found.",
    },
  },
});

manageRouter.openapi(createKeyRoute, async (c) => {
  const { appId } = c.req.valid("param");
  const db = c.get("db");

  // Verify app exists
  const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
  if (!app) {
    return c.json({ error: "App not found" }, 404);
  }

  const body = c.req.valid("json");
  const { rawKey, keyHash, keyPrefix } = await generateApiKey("live");
  const id = ulid();
  const now = new Date().toISOString();

  await db.insert(appKeys).values({
    id,
    appId,
    keyHash,
    keyPrefix,
    rawKey,
    name: body.name,
    createdAt: now,
  });

  return c.json(
    {
      id,
      key: rawKey,
      key_prefix: keyPrefix,
      name: body.name,
    },
    201,
  );
});

// ── GET /v1/apps/:appId/keys ────────────────────────────────────────────────

const listKeysRoute = createRoute({
  method: "get",
  path: "/apps/{appId}/keys",
  tags: ["Management"],
  summary: "List app keys",
  description:
    "List app keys for an app. Returns the full key for each (keys are public ingest identifiers, not secrets). Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    params: AppIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: ListKeysResponseSchema } },
      description: "List of app keys.",
    },
  },
});

manageRouter.openapi(listKeysRoute, async (c) => {
  const { appId } = c.req.valid("param");
  const db = c.get("db");

  const keys = await db
    .select({
      id: appKeys.id,
      keyPrefix: appKeys.keyPrefix,
      rawKey: appKeys.rawKey,
      name: appKeys.name,
      createdAt: appKeys.createdAt,
      revokedAt: appKeys.revokedAt,
    })
    .from(appKeys)
    .where(eq(appKeys.appId, appId));

  return c.json({ keys });
});

// ── PATCH /v1/apps/:appId ───────────────────────────────────────────────────

const updateAppRoute = createRoute({
  method: "patch",
  path: "/apps/{appId}",
  tags: ["Management"],
  summary: "Update an app",
  description:
    "Update app settings (name, retention, enabled dims). Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    params: AppIdParamSchema,
    body: {
      content: { "application/json": { schema: UpdateAppSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: UpdateAppResponseSchema } },
      description: "App updated.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid request body.",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "App not found.",
    },
  },
});

manageRouter.openapi(updateAppRoute, async (c) => {
  const { appId } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.get("db");

  const [existing] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
  if (!existing) {
    return c.json({ error: "App not found" }, 404);
  }

  // Build update object from provided fields only
  const updates: Partial<{ name: string; retentionDays: number; enabledDims: string }> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.retention_days !== undefined) updates.retentionDays = body.retention_days;
  if (body.enabled_dims !== undefined) updates.enabledDims = JSON.stringify(body.enabled_dims);

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  await db.update(apps).set(updates).where(eq(apps.id, appId));

  // Invalidate cached config so next ingest picks up changes immediately
  invalidateAppConfig(appId);

  // Return the updated app
  const [updated] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
  return c.json({
    id: updated.id,
    name: updated.name,
    retentionDays: updated.retentionDays,
    enabledDims: parseEnabledDims(updated.enabledDims),
  });
});

// ── DELETE /v1/apps/:appId ──────────────────────────────────────────────────

const deleteAppRoute = createRoute({
  method: "delete",
  path: "/apps/{appId}",
  tags: ["Management"],
  summary: "Delete an app",
  description:
    "Delete an app and all its data (events, dimensions, keys). This is irreversible. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    params: AppIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: DeleteAppResponseSchema } },
      description: "App deleted.",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "App not found.",
    },
  },
});

manageRouter.openapi(deleteAppRoute, async (c) => {
  const { appId } = c.req.valid("param");
  const db = c.get("db");

  const [existing] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
  if (!existing) {
    return c.json({ error: "App not found" }, 404);
  }

  // ON DELETE CASCADE handles events, dimensions, and keys automatically
  await db.delete(apps).where(eq(apps.id, appId));

  return c.json({ deleted: true });
});

// ── POST /v1/apps/:appId/keys/:keyId/revoke ─────────────────────────────────

const revokeKeyRoute = createRoute({
  method: "post",
  path: "/apps/{appId}/keys/{keyId}/revoke",
  tags: ["Management"],
  summary: "Revoke an app key",
  description:
    "Revoke an app key so it can no longer be used for ingestion. Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  request: {
    params: KeyIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: RevokeKeyResponseSchema } },
      description: "Key revoked.",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Key not found.",
    },
  },
});

manageRouter.openapi(revokeKeyRoute, async (c) => {
  const { appId, keyId } = c.req.valid("param");
  const db = c.get("db");

  const [key] = await db
    .select()
    .from(appKeys)
    .where(and(eq(appKeys.id, keyId), eq(appKeys.appId, appId)))
    .limit(1);

  if (!key) {
    return c.json({ error: "Key not found" }, 404);
  }

  if (key.revokedAt) {
    return c.json({ revoked: true }); // Already revoked, idempotent
  }

  await db
    .update(appKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(appKeys.id, keyId));

  return c.json({ revoked: true });
});
