/**
 * Data retention logic.
 *
 * Deletes events and related dimensions that are older than each app's
 * configured retention_days.
 *
 * Called by the /v1/cron/retention endpoint (triggered by CF Cron Trigger
 * or manually for testing).
 */
import { lt, eq } from "drizzle-orm";
import { apps, events, eventDimensions } from "../../db/schema";
import type { Database } from "../../db/client";

export type RetentionResult = {
  appsProcessed: number;
  eventsDeleted: number;
  errors: string[];
};

/**
 * Run retention for all apps.
 *
 * For each app, compute the cutoff date (now - retention_days), then:
 *   1. Find events older than cutoff
 *   2. Delete their dimensions
 *   3. Delete the events
 */
export async function runRetention(db: Database): Promise<RetentionResult> {
  const result: RetentionResult = {
    appsProcessed: 0,
    eventsDeleted: 0,
    errors: [],
  };

  const allApps = await db.select().from(apps);

  for (const app of allApps) {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - app.retentionDays);
      const cutoffIso = cutoff.toISOString();

      // Find expired events for this app
      const expiredEvents = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.appId, app.id))
        // events.timestamp is ISO 8601 string — lexicographic comparison works
        .where(lt(events.timestamp, cutoffIso));

      if (expiredEvents.length > 0) {
        // Delete dimensions in batches
        const BATCH_SIZE = 500;
        for (let i = 0; i < expiredEvents.length; i += BATCH_SIZE) {
          const batch = expiredEvents.slice(i, i + BATCH_SIZE);
          for (const ev of batch) {
            await db
              .delete(eventDimensions)
              .where(eq(eventDimensions.eventId, ev.id));
          }
        }

        // Delete the events themselves
        for (const ev of expiredEvents) {
          await db.delete(events).where(eq(events.id, ev.id));
        }

        result.eventsDeleted += expiredEvents.length;
      }

      result.appsProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`App ${app.id} (${app.name}): ${msg}`);
    }
  }

  return result;
}
