-- Feed reader schema (owned system, July 2026) — powers /rss.
-- Apply locally:  npx wrangler d1 execute <your-db-name> --local  --file=db/schema.sql
-- Apply to prod:  npx wrangler d1 execute <your-db-name> --remote --file=db/schema.sql
-- (Database creation and bindings: see RSS-RUNBOOK.md.)

-- Subscribed feeds. One row per resolved feed URL.
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_url TEXT NOT NULL UNIQUE,          -- the resolved RSS/Atom/JSON feed URL
  site_url TEXT,                          -- the human homepage, for display/linking
  title TEXT NOT NULL DEFAULT '',         -- feed title (adopted from the feed; user may override)
  folder TEXT,                            -- optional grouping label
  -- Conditional-GET caching, so a poll that finds nothing new costs almost nothing.
  etag TEXT,
  last_modified TEXT,
  -- Poll bookkeeping (written by the feed-poller Worker).
  last_polled_at TEXT,                    -- datetime('now') of the last poll attempt
  last_status TEXT,                       -- 'ok' | 'not-modified' | 'error'
  last_error TEXT,                        -- last error detail; NULL when healthy
  error_count INTEGER NOT NULL DEFAULT 0, -- consecutive failures, for polling backoff
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Scrape-to-feed (August 2026). 'feed' polls feed_url as RSS/Atom/JSON;
  -- 'scrape' fetches it as HTML and applies scrape_rule. last_item_count is the
  -- trailing count a healthy scrape produced, which is what makes a rule that
  -- has silently stopped matching distinguishable from a quiet page.
  kind TEXT NOT NULL DEFAULT 'feed',      -- 'feed' | 'scrape'
  scrape_rule TEXT,                       -- JSON ScrapeRule; NULL for kind='feed'
  last_item_count INTEGER                 -- items the rule last extracted successfully
);

CREATE INDEX IF NOT EXISTS idx_feeds_poll ON feeds(last_polled_at);

-- Feed items (articles). Deduped within a feed by the feed-provided guid.
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,                     -- feed-provided id, else the link, else a content hash
  url TEXT,                               -- canonical article link
  title TEXT NOT NULL DEFAULT '',
  author TEXT,
  summary TEXT,                           -- description / excerpt (raw; stripped to text on render)
  content TEXT,                           -- full content:encoded when the feed carries it (raw)
  published_at TEXT,                      -- ISO 8601 when parseable, else NULL
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_read INTEGER NOT NULL DEFAULT 0,     -- 0 / 1
  is_starred INTEGER NOT NULL DEFAULT 0,  -- 0 / 1
  read_at TEXT,                           -- when it was marked read; display only, no delete keys off it
  UNIQUE (feed_id, guid)                  -- the dedup key: re-polling never duplicates
);

CREATE INDEX IF NOT EXISTS idx_items_feed    ON items(feed_id, published_at);
CREATE INDEX IF NOT EXISTS idx_items_unread  ON items(is_read, published_at);
CREATE INDEX IF NOT EXISTS idx_items_starred ON items(is_starred, published_at);

-- Full-text search over items (SQLite FTS5), external-content-linked to `items`
-- by rowid so the index stores no duplicate copy of the text it points at.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, summary, content,
  content='items', content_rowid='id',
  tokenize='porter unicode61'
);

-- Keep the FTS index in step with the items table.
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, summary, content)
  VALUES (new.id, new.title, new.summary, new.content);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary, content)
  VALUES ('delete', old.id, old.title, old.summary, old.content);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary, content)
  VALUES ('delete', old.id, old.title, old.summary, old.content);
  INSERT INTO items_fts(rowid, title, summary, content)
  VALUES (new.id, new.title, new.summary, new.content);
END;

-- The Shorts verdict for a YouTube video, keyed by VIDEO id and deliberately
-- NOT tied to an item row. Deleting a swept Short frees its (feed_id, guid)
-- dedup key, so the next poll re-inserts it; keyed by video, the verdict
-- survives that and a known Short is never fetched, probed or stored again.
CREATE TABLE IF NOT EXISTS youtube_video_class (
  video_id TEXT PRIMARY KEY,
  is_short INTEGER NOT NULL,              -- 1 = Short (excluded), 0 = long video
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per poll, so "looks healthy, delivers nothing" is answerable after
-- the fact instead of needing a live `wrangler tail`. Written by the poller;
-- read by the Reader panel on /studio.
CREATE TABLE IF NOT EXISTS poll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT (datetime('now')),
  trigger TEXT NOT NULL,                  -- 'cron' | 'manual'
  feeds INTEGER NOT NULL DEFAULT 0,       -- feeds attempted
  ok INTEGER NOT NULL DEFAULT 0,          -- fetched and parsed
  not_modified INTEGER NOT NULL DEFAULT 0,
  errored INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,    -- items inserted (raw D1 `changes`, FTS-inflated)
  shorts_swept INTEGER NOT NULL DEFAULT 0,
  subrequests INTEGER NOT NULL DEFAULT 0, -- counted, not estimated: the 1,000/invocation budget
  duration_ms INTEGER NOT NULL DEFAULT 0,
  note TEXT                               -- e.g. a fatal error that ended the run early
);

CREATE INDEX IF NOT EXISTS idx_poll_runs_time ON poll_runs(started_at DESC);
