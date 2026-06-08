-- Backfill events.value from the legacy 'count' dimension, then remove those rows.
-- Events that already have a value are left untouched.
UPDATE events
SET value = (
    SELECT CAST(d.dim_value AS REAL)
    FROM event_dimensions d
    WHERE d.event_id = events.id AND d.dim_key = 'count'
)
WHERE value IS NULL
AND EXISTS (
    SELECT 1 FROM event_dimensions d
    WHERE d.event_id = events.id AND d.dim_key = 'count'
);

DELETE FROM event_dimensions WHERE dim_key = 'count';
