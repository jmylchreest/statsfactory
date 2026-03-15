#!/usr/bin/env bun
/**
 * Minimal HTTP libSQL server for local development.
 *
 * Wraps a local SQLite file with the Hrana-over-HTTP protocol that
 * @libsql/client/web expects. Supports Hrana v2 features including
 * store_sql, batch with conditions, and SQL text caching.
 *
 * Usage:
 *   bun run scripts/dev-db.ts [--port 8080] [--db local.db]
 */

import { createClient } from "@libsql/client";

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const dbIdx = args.indexOf("--db");
const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 8080;
const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : "local.db";

const client = createClient({ url: `file:${dbPath}` });

// ── Hrana types ────────────────────────────────────────────

type HranaValue = { type: string; value?: unknown };

interface HranaStmt {
  sql?: string;
  sql_id?: number;
  args?: HranaValue[];
  named_args?: Array<{ name: string; value: HranaValue }>;
  want_rows?: boolean;
}

interface HranaCondition {
  type: string;
  step?: number;
  cond?: HranaCondition;
  conds?: HranaCondition[];
}

interface HranaBatchStep {
  stmt: HranaStmt;
  condition?: HranaCondition;
}

interface HranaRequest {
  type: string;
  stmt?: HranaStmt;
  batch?: { steps: HranaBatchStep[] };
  sql_id?: number;
  sql?: string;
}

// ── Value conversion ───────────────────────────────────────

function hranaValueToJS(a: HranaValue): unknown {
  if (a.type === "null") return null;
  if (a.type === "integer") return Number(a.value);
  if (a.type === "float") return Number(a.value);
  return a.value;
}

function jsValueToHrana(val: unknown): HranaValue {
  if (val === null || val === undefined) return { type: "null" };
  if (typeof val === "number") {
    return Number.isInteger(val)
      ? { type: "integer", value: String(val) }
      : { type: "float", value: val };
  }
  if (typeof val === "bigint") return { type: "integer", value: String(val) };
  if (typeof val === "string") return { type: "text", value: val };
  if (val instanceof ArrayBuffer || val instanceof Uint8Array) {
    return { type: "blob", base64: Buffer.from(val).toString("base64") };
  }
  return { type: "text", value: String(val) };
}

// ── Statement execution ────────────────────────────────────

function resolveSQL(stmt: HranaStmt, sqlCache: Map<number, string>): string {
  if (stmt.sql !== undefined) return stmt.sql;
  if (stmt.sql_id !== undefined) {
    const cached = sqlCache.get(stmt.sql_id);
    if (cached !== undefined) return cached;
    throw new Error(`SQL text not found for sql_id ${stmt.sql_id}`);
  }
  throw new Error("Statement has neither sql nor sql_id");
}

async function executeStmt(stmt: HranaStmt, sqlCache: Map<number, string>) {
  const sql = resolveSQL(stmt, sqlCache);

  if (stmt.named_args && stmt.named_args.length > 0) {
    const obj: Record<string, unknown> = {};
    for (const na of stmt.named_args) {
      obj[na.name] = hranaValueToJS(na.value);
    }
    return client.execute({ sql, args: obj });
  }

  const positional = (stmt.args || []).map(hranaValueToJS);
  return client.execute({ sql, args: positional as any[] });
}

function formatResult(result: any) {
  return {
    cols: result.columns.map((name: string) => ({
      name,
      decltype: null,
    })),
    rows: result.rows.map((row: any) =>
      result.columns.map((col: string) => jsValueToHrana(row[col])),
    ),
    affected_row_count: result.rowsAffected,
    last_insert_rowid: result.lastInsertRowid
      ? String(result.lastInsertRowid)
      : null,
    replication_index: null,
  };
}

// ── Batch condition evaluation ─────────────────────────────

type StepOutcome = "ok" | "error" | "skipped";

function evaluateCondition(
  cond: HranaCondition,
  outcomes: StepOutcome[],
): boolean {
  switch (cond.type) {
    case "ok":
      return outcomes[cond.step!] === "ok";
    case "error":
      return outcomes[cond.step!] === "error";
    case "not":
      return !evaluateCondition(cond.cond!, outcomes);
    case "and":
      return (cond.conds || []).every((c) => evaluateCondition(c, outcomes));
    case "or":
      return (cond.conds || []).some((c) => evaluateCondition(c, outcomes));
    default:
      return true;
  }
}

// ── Pipeline handler ───────────────────────────────────────

async function handlePipeline(
  body: { baton?: string | null; requests: HranaRequest[] },
  sqlCache: Map<number, string>,
) {
  const results: unknown[] = [];

  for (const request of body.requests) {
    switch (request.type) {
      case "store_sql": {
        if (request.sql_id !== undefined && request.sql !== undefined) {
          sqlCache.set(request.sql_id, request.sql);
        }
        results.push({ type: "ok", response: { type: "store_sql" } });
        break;
      }

      case "execute": {
        if (!request.stmt) {
          results.push({
            type: "error",
            error: {
              message: "Missing stmt in execute request",
              code: "UNKNOWN",
            },
          });
          break;
        }
        try {
          const result = await executeStmt(request.stmt, sqlCache);
          results.push({
            type: "ok",
            response: { type: "execute", result: formatResult(result) },
          });
        } catch (err: any) {
          results.push({
            type: "error",
            error: { message: err.message, code: "UNKNOWN" },
          });
        }
        break;
      }

      case "batch": {
        if (!request.batch) {
          results.push({
            type: "error",
            error: {
              message: "Missing batch in batch request",
              code: "UNKNOWN",
            },
          });
          break;
        }

        const steps = request.batch.steps;
        // step_results[i] = null (skipped) or StmtResult object
        const stepResults: (unknown | null)[] = new Array(steps.length).fill(
          null,
        );
        // step_errors[i] = null (no error) or Error object
        const stepErrors: (unknown | null)[] = new Array(steps.length).fill(
          null,
        );
        const outcomes: StepOutcome[] = new Array(steps.length).fill(
          "skipped",
        );

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];

          if (step.condition) {
            if (!evaluateCondition(step.condition, outcomes)) {
              outcomes[i] = "skipped";
              continue;
            }
          }

          try {
            const result = await executeStmt(step.stmt, sqlCache);
            // Hrana v2 batch step_results are raw StmtResult objects (not wrapped)
            stepResults[i] = formatResult(result);
            outcomes[i] = "ok";
          } catch (err: any) {
            // Hrana v2 batch step_errors are Error objects
            stepErrors[i] = { message: err.message, code: "UNKNOWN" };
            outcomes[i] = "error";
          }
        }

        results.push({
          type: "ok",
          response: {
            type: "batch",
            result: {
              step_results: stepResults,
              step_errors: stepErrors,
            },
          },
        });
        break;
      }

      case "close": {
        results.push({ type: "ok", response: { type: "close" } });
        break;
      }

      default: {
        results.push({ type: "ok", response: { type: request.type } });
      }
    }
  }

  return { baton: null, results };
}

// ── HTTP server ────────────────────────────────────────────

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // Hrana v2 + v3 pipeline endpoints
    if (
      (url.pathname === "/v3/pipeline" || url.pathname === "/v2/pipeline") &&
      req.method === "POST"
    ) {
      try {
        const body = (await req.json()) as {
          baton?: string | null;
          requests: HranaRequest[];
        };
        const sqlCache = new Map<number, string>();
        const response = await handlePipeline(body, sqlCache);
        return Response.json(response);
      } catch (err: any) {
        console.error("Pipeline error:", err.message);
        return Response.json(
          {
            results: [
              {
                type: "error",
                error: { message: err.message, code: "UNKNOWN" },
              },
            ],
          },
          { status: 200 },
        );
      }
    }

    // Version endpoint for client handshake
    if (url.pathname === "/v2" || url.pathname === "/") {
      return Response.json({ version: "local-dev" });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Local libSQL server running on http://localhost:${port}`);
console.log(`Database: ${dbPath}`);
console.log(`Press Ctrl+C to stop.`);
