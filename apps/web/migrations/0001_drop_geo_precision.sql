-- Drop the geo_precision column from apps table.
-- The enabledDims JSON array is now the sole gate for enrichment dimensions.
-- D1 uses SQLite >= 3.35.0, which supports ALTER TABLE DROP COLUMN natively.
-- NEVER use DROP TABLE on parent tables with ON DELETE CASCADE foreign keys.

ALTER TABLE `apps` DROP COLUMN `geo_precision`;
