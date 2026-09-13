-- Scrape-to-feed migration, 16 August 2026. Adds the three columns the feature
-- needs to an existing reader database.
--
-- reader-schema.sql carries the same columns for a FRESH database, and every
-- statement in it is CREATE TABLE IF NOT EXISTS, so re-applying the schema to a
-- live database adds nothing. This file is the path for the live one.
--
-- Apply locally:  npx wrangler d1 execute <your-db-name> --local  --file=db/migration-scrape.sql
-- Apply to prod:  npx wrangler d1 execute <your-db-name> --remote --file=db/migration-scrape.sql
--
-- Not idempotent: a second run fails on 'duplicate column name', which is the
-- intended signal that it has already been applied.

ALTER TABLE feeds ADD COLUMN kind TEXT NOT NULL DEFAULT 'feed';
ALTER TABLE feeds ADD COLUMN scrape_rule TEXT;
ALTER TABLE feeds ADD COLUMN last_item_count INTEGER;
