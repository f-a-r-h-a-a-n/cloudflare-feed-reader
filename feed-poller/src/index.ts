/**
 * feed-poller — scheduled RSS/Atom/JSON polling for the /rss reader.
 *
 * Cloudflare Pages cannot run on a schedule, so this companion Worker owns the
 * polling loop. It binds the SAME D1 database as the reader (READER_DB) and, on
 * its cron trigger, fetches every due feed with conditional GETs and upserts the
 * new items. A guarded fetch() handler runs the same loop on demand (local dev,
 * or a manual refresh); it refuses without the shared secret.
 *
 * Deploy and schedule: see ../README.md.
 */
import { fetchFeed, type FetchResult, type ParsedItem } from '../../functions/_shared/feed';
import { fetchScrape, parseRule } from '../../functions/_shared/scrape';
import { youtubeVideoId, YOUTUBE_FEED_MARKER } from '../../functions/_shared/youtube';

export interface Env {
  READER_DB: D1Database;
  /** Shared secret gating the on-demand fetch() trigger. Set in prod and .dev.vars. */
  POLL_TRIGGER_SECRET?: string;
  /** YouTube Data API v3 key. Required to exclude Shorts from channel feeds. */
  YOUTUBE_API_KEY?: string;
}

const MAX_ITEMS_PER_FEED = 200; // upper bound on what one poll will consider

const ERROR_BACKOFF_THRESHOLD = 5; // consecutive failures before a feed is slowed
const BACKOFF_MINUTES = 360; // a slowed feed is polled at most every 6 hours
const RETAIN_PER_FEED = 100; // keep only this many latest items per feed
const SCRAPE_DECAY_RATIO = 0.5; // a scrape yielding under half its trailing count is treated as broken
const SCRAPE_DECAY_FLOOR = 4; // ...but only where that count was big enough for the ratio to mean anything
/**
 * YouTube's Shorts surface accepts uploads of up to three minutes (raised from
 * 60 seconds in October 2024), so duration alone cannot answer 'is this a
 * Short': an ordinary two-minute landscape video sits under the ceiling and is
 * not one. This figure is a COST filter and not the test. Anything longer
 * cannot be a Short, so it never costs a probe; anything shorter is settled on
 * the Shorts surface itself. If YouTube raises the ceiling again, this is the
 * one number to change.
 *
 * Set ABOVE the three-minute ceiling deliberately. A verdict is never revisited,
 * so an id this filter declines to probe is settled for ever, and at exactly 180
 * the margin for a duration that reports a second long is nil. The slack costs
 * one probe for a video between 3:00 and 3:15; getting the boundary wrong costs
 * a permanent wrong verdict, which is this defect's whole history.
 */
const SHORTS_SURFACE_MAX_SECONDS = 195;
const REDIRECT_PROBE_CAP = 40; // surface-probe budget per FEED per poll (Worker subrequest safety)
/**
 * ...and per RUN. The per-feed cap alone never bounded a poll: with N YouTube
 * feeds it permits 40N probes, and a Worker invocation may make 1,000
 * subrequests in total. That was harmless while probing was the keyless
 * fallback and a keyed poll made none, and it stops being harmless the moment
 * the keyed path probes too, or a verdict table is cleared for a reclassify.
 * Unprobed ids stay unknown, so a run that hits this simply finishes the work on
 * the next poll.
 */
const REDIRECT_PROBE_BUDGET = 200;
const UA_BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** Parse an ISO-8601 duration (PT#H#M#S) to whole seconds. */
function durationToSeconds(iso: string): number {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

/**
 * Tallies for one poll, written to `poll_runs` at the end of the run so a later
 * question ("why did nothing arrive?", "did we run out of subrequests?") has an
 * answer on disk instead of needing a live `wrangler tail`.
 * `subrequests` counts outbound requests this Worker initiates; redirect hops
 * are not visible here, so treat it as a floor against the 1,000 budget.
 */
interface RunStats {
  feeds: number;
  ok: number;
  notModified: number;
  errored: number;
  inserted: number;
  shortsSwept: number;
  /**
   * Stored YouTube videos this run finished with no verdict, because the probe
   * budget ran out or a probe went unanswered. It reaches `poll_runs.note` and
   * the trigger's JSON because a reclassify now spans several polls: without it
   * the only question anyone actually asks ('is it progressing, or stuck?')
   * needs a live `wrangler tail` to answer.
   */
  unclassified: number;
  subrequests: number;
}

function newStats(): RunStats {
  return { feeds: 0, ok: 0, notModified: 0, errored: 0, inserted: 0, shortsSwept: 0, unclassified: 0, subrequests: 0 };
}

/**
 * A classification result. `checked` is the subset that actually got an answer,
 * and only those may be recorded as classified: both classifiers deliberately
 * treat a failure as 'not a Short' so a real video is never dropped, so marking
 * a failed probe as done would hide that Short permanently.
 */
interface Classification {
  shorts: Set<string>;
  checked: Set<string>;
}

/** One poll's remaining surface probes, shared across every feed in the run. */
interface ProbeBudget {
  left: number;
}

/**
 * What the Data API leg returns: the ids short enough to BE a Short, and every
 * id the API actually answered for. It narrows, it does not decide; the reason
 * is at `SHORTS_SURFACE_MAX_SECONDS`.
 */
interface ApiNarrowing {
  candidates: string[];
  checked: Set<string>;
}

/** Ids under the Shorts ceiling, by exact duration from the Data API (batched). */
async function shortCandidatesByApi(ids: string[], apiKey: string, stats: RunStats): Promise<ApiNarrowing> {
  const candidates: string[] = [];
  const checked = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${batch.join(',')}&key=${apiKey}`;
    try {
      stats.subrequests++;
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) {
        console.error(`[feed-poller] YouTube API HTTP ${r.status}`);
        continue; // whole batch stays unchecked, so a later poll retries it
      }
      const j = (await r.json()) as { items?: Array<{ id: string; contentDetails?: { duration?: string } }> };
      for (const v of j.items ?? []) {
        const s = durationToSeconds(v.contentDetails?.duration ?? '');
        if (s > 0 && s <= SHORTS_SURFACE_MAX_SECONDS) candidates.push(v.id);
      }
      // The batch was answered. An id the API omits is a video that no longer
      // exists, which is an answer too, so it counts as checked.
      for (const id of batch) checked.add(id);
    } catch (e) {
      console.error('[feed-poller] YouTube API error', e);
    }
  }
  return { candidates, checked };
}

/**
 * Asks the Shorts surface itself, which is the only thing that answers the
 * reader's actual question: a long video's /shorts/<id> URL 303s to /watch, a
 * Short's does not. A consent cookie skips the EU wall. Only ids proven Short
 * are returned, so a hiccup never drops a real video. Capped, and unreliable
 * under repeated requests, so with a key it runs only over what the API has
 * already narrowed to; without one it carries the whole classification.
 */
async function shortIdsByRedirect(ids: string[], stats: RunStats, budget: ProbeBudget): Promise<Classification> {
  const shorts = new Set<string>();
  const checked = new Set<string>();
  const wanted = ids.slice(0, REDIRECT_PROBE_CAP);
  for (const id of wanted) {
    if (budget.left <= 0) {
      console.warn(`[feed-poller] probe budget spent; ${wanted.length - wanted.indexOf(id)} id(s) left for the next poll`);
      break;
    }
    budget.left--;
    try {
      stats.subrequests++;
      const r = await fetch(`https://www.youtube.com/shorts/${id}`, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA_BROWSER, Cookie: 'SOCS=CAI' },
        signal: AbortSignal.timeout(8_000),
      });
      const loc = r.headers.get('location') ?? '';
      if (r.status >= 300 && r.status < 400 && loc.includes('/watch')) {
        checked.add(id); // long video, answered
        continue;
      }
      if (r.status === 200) {
        shorts.add(id); // stayed on /shorts → a Short
        checked.add(id);
        continue;
      }
      // Anything else (a rate-limit page, a consent wall) is not an answer;
      // leave it unchecked so a later poll asks again.
    } catch {
      /* unknown → treat as long; never drop on error, and never mark checked */
    }
  }
  return { shorts, checked };
}

/**
 * Confirmed Short ids. Keyed, the API rules out everything above the Shorts
 * ceiling in one batched call and the surface settles what is left; keyless,
 * the surface answers for everything.
 *
 * Duration was the whole test until 21 August 2026, with the cut-off at 60
 * seconds, which is the ceiling YouTube left behind in October 2024. Every
 * Short between 61 and 180 seconds was therefore recorded as a long video, and
 * because a verdict is keyed to the video id and never revisited, that verdict
 * was permanent.
 */
async function classifyShorts(ids: string[], env: Env, stats: RunStats, budget: ProbeBudget): Promise<Classification> {
  if (!ids.length) return { shorts: new Set(), checked: new Set() };
  if (!env.YOUTUBE_API_KEY) return shortIdsByRedirect(ids, stats, budget);

  const { candidates, checked } = await shortCandidatesByApi(ids, env.YOUTUBE_API_KEY, stats);
  if (!candidates.length) return { shorts: new Set(), checked };
  const probed = await shortIdsByRedirect(candidates, stats, budget);
  // A candidate the probe could not answer for is NOT settled: the API
  // established only that it is short ENOUGH to be a Short. Leaving it in
  // `checked` would harden 'unanswered' into 'not a Short' for ever, which is
  // the exact shape of the defect this path exists to stop.
  for (const id of candidates) if (!probed.checked.has(id)) checked.delete(id);
  return { shorts: probed.shorts, checked };
}

/** Load every Shorts verdict we hold. One read per poll, keyed by video id. */
async function loadVerdicts(env: Env): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const { results } = await env.READER_DB.prepare(
    'SELECT video_id, is_short FROM youtube_video_class',
  ).all<{ video_id: string; is_short: number }>();
  for (const row of results ?? []) m.set(row.video_id, row.is_short);
  return m;
}

/**
 * Classify any stored video we have no verdict for, then remove every item that
 * is a known Short. Verdicts are cached by video id, so this costs network only
 * for videos seen for the first time.
 */
async function sweepYouTubeShorts(env: Env, stats: RunStats, verdicts: Map<string, number>): Promise<void> {
  const feeds =
    (
      await env.READER_DB.prepare(`SELECT id, feed_url FROM feeds WHERE feed_url LIKE '%' || ? || '%'`)
        .bind(YOUTUBE_FEED_MARKER)
        .all<{ id: number; feed_url: string }>()
    ).results ?? [];
  if (feeds.length && !env.YOUTUBE_API_KEY) {
    console.warn('[feed-poller] no YOUTUBE_API_KEY; using best-effort keyless Shorts detection');
  }
  const budget: ProbeBudget = { left: REDIRECT_PROBE_BUDGET };
  for (const f of feeds) {
    try {
      const rows =
        (
          await env.READER_DB.prepare('SELECT id, url FROM items WHERE feed_id = ?')
            .bind(f.id)
            .all<{ id: number; url: string | null }>()
        ).results ?? [];
      const pairs = rows
        .map((row) => ({ itemId: row.id, vid: youtubeVideoId(row.url) }))
        .filter((x): x is { itemId: number; vid: string } => x.vid !== null);
      if (!pairs.length) continue;

      const unknown = [...new Set(pairs.map((x) => x.vid))].filter((v) => !verdicts.has(v));
      if (unknown.length) {
        const { shorts, checked } = await classifyShorts(unknown, env, stats, budget);
        // Only ids that actually got an answer are recorded; a failed probe is
        // left unknown so a later poll asks again rather than the failure
        // hardening into 'not a Short' for ever.
        const stmts = [...checked].map((vid) => {
          const isShort = shorts.has(vid) ? 1 : 0;
          verdicts.set(vid, isShort);
          return env.READER_DB.prepare(
            'INSERT OR REPLACE INTO youtube_video_class (video_id, is_short) VALUES (?, ?)',
          ).bind(vid, isShort);
        });
        if (stmts.length) await env.READER_DB.batch(stmts);
      }

      stats.unclassified += [...new Set(pairs.map((x) => x.vid))].filter((v) => !verdicts.has(v)).length;

      const shortIds = pairs.filter((x) => verdicts.get(x.vid) === 1).map((x) => x.itemId);
      if (shortIds.length) {
        await env.READER_DB.batch(shortIds.map((id) => env.READER_DB.prepare('DELETE FROM items WHERE id = ?').bind(id)));
        stats.shortsSwept += shortIds.length;
        console.log(`[feed-poller] swept ${shortIds.length} Shorts from ${f.feed_url}`);
      }
    } catch (err) {
      console.error(`[feed-poller] shorts sweep failed for feed ${f.id}:`, err);
    }
  }
}

/**
 * Retention sweep: cap each feed at RETAIN_PER_FEED, newest first. A star
 * exempts an item, so starring means keep.
 *
 * There is deliberately NO sweep of read items, and adding one back is the bug,
 * not the tidy-up. Deleting a read row frees its UNIQUE (feed_id, guid) dedup
 * key; the insert above is OR IGNORE and nothing records that a guid was ever
 * read, so the next poll answered 200 rather than 304 re-inserted the item with
 * is_read defaulting to 0. Marking something read therefore un-marked it a poll
 * or two later, which is the same retention-freed-key loop the Shorts filter and
 * the pre-insert slice already close, in its third and unguarded instance.
 *
 * The cap alone is a safe bound because it is the only delete left: an item
 * ranked past RETAIN_PER_FEED is older than everything the feed still serves, so
 * freeing its key cannot bring it back.
 */
async function cleanup(env: Env): Promise<void> {
  // The cap counts starred items in the window but never deletes them, so a feed
  // full of stars keeps them and simply retains fewer unstarred posts.
  await env.READER_DB.prepare(
    `DELETE FROM items WHERE is_starred = 0 AND id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY feed_id ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
         ) AS rn FROM items
       ) WHERE rn > ${RETAIN_PER_FEED}
     )`,
  ).run();
}

interface FeedRow {
  id: number;
  feed_url: string;
  title: string;
  etag: string | null;
  last_modified: string | null;
  error_count: number;
  last_polled_at: string | null;
  kind: string | null;
  scrape_rule: string | null;
  last_item_count: number | null;
}

const FEED_COLS =
  'id, feed_url, title, etag, last_modified, error_count, last_polled_at, kind, scrape_rule, last_item_count';

/**
 * Feeds to poll. A forced poll (the manual trigger) returns every feed, so a
 * transient outage that pushed feeds into backoff can always be recovered in one
 * refresh. The scheduled cron returns only healthy feeds plus unhealthy ones past
 * their backoff window, so it never hammers a genuinely dead feed.
 */
async function dueFeeds(env: Env, force: boolean): Promise<FeedRow[]> {
  if (force) {
    const { results } = await env.READER_DB.prepare(
      `SELECT ${FEED_COLS} FROM feeds ORDER BY last_polled_at IS NOT NULL, last_polled_at`,
    ).all<FeedRow>();
    return results ?? [];
  }
  const { results } = await env.READER_DB.prepare(
    `SELECT ${FEED_COLS} FROM feeds
      WHERE error_count < ? OR last_polled_at IS NULL OR last_polled_at < datetime('now', ?)
      ORDER BY last_polled_at IS NOT NULL, last_polled_at`,
  )
    .bind(ERROR_BACKOFF_THRESHOLD, `-${BACKOFF_MINUTES} minutes`)
    .all<FeedRow>();
  return results ?? [];
}

async function pollFeed(
  env: Env,
  feed: FeedRow,
  stats: RunStats,
  verdicts: Map<string, number>,
): Promise<number> {
  // A scrape feed is an ordinary row whose feed_url is a page rather than a
  // feed; fetchScrape returns the same FetchResult, so everything below is
  // shared. A row marked 'scrape' with no usable rule is an error, not a silent
  // fall back to feed parsing, which would report a green feed for a rule that
  // is gone.
  let r: FetchResult;
  if (feed.kind === 'scrape') {
    const rule = parseRule(feed.scrape_rule ?? '');
    if (!rule) {
      r = {
        status: 'error',
        etag: null,
        lastModified: null,
        feedTitle: null,
        siteUrl: null,
        items: [],
        error: 'Marked as a scrape but carries no usable rule; re-add the page from the Add form.',
      };
    } else {
      stats.subrequests++;
      r = await fetchScrape(feed.feed_url, rule, feed.etag, feed.last_modified);
    }
  } else {
    stats.subrequests++; // fetchFeed makes exactly one request (redirect hops excluded)
    r = await fetchFeed(feed.feed_url, feed.etag, feed.last_modified);
  }

  if (r.status === 'not-modified') {
    stats.notModified++;
    await env.READER_DB.prepare(
      `UPDATE feeds SET last_polled_at = datetime('now'), last_status = 'not-modified',
              last_error = NULL, error_count = 0 WHERE id = ?`,
    )
      .bind(feed.id)
      .run();
    return 0;
  }

  if (r.status === 'error') {
    stats.errored++;
    // Drop the cache validators with the error. fetchFeed already returns them
    // nulled; persisting that is what stops a feed whose body we rejected from
    // answering 304 on the next poll and reporting 'not-modified', i.e. healthy,
    // without a body ever being looked at again.
    await env.READER_DB.prepare(
      `UPDATE feeds SET etag = NULL, last_modified = NULL,
              last_polled_at = datetime('now'), last_status = 'error',
              last_error = ?, error_count = error_count + 1 WHERE id = ?`,
    )
      .bind(r.error ?? 'unknown error', feed.id)
      .run();
    return 0;
  }

  stats.ok++;
  // status === 'ok': upsert items, then refresh the feed's cache/metadata.
  // Shorts are removed in a separate per-poll sweep (sweepYouTubeShorts), so it
  // catches dormant channels too, not only feeds that returned new content.
  let inserted = 0;
  // Drop videos already judged to be Shorts. Sweeping a Short deletes the row
  // that its (feed_id, guid) dedup key lived on, so without this filter the very
  // next poll re-inserts it and the sweep deletes it again, for ever.
  //
  // Then keep only as many as retention will keep, newest first. Storing more
  // than RETAIN_PER_FEED is the same re-insert loop in a different place: the
  // cap trims the overflow, the trim frees those dedup keys, and the next poll
  // re-inserts them. Eight feeds were churning ~1,400 row writes a poll that
  // way, each one amplified again by the FTS triggers. Sorting before the slice
  // keeps this correct for a feed that serves oldest-first.
  const nonShorts = r.items
    .filter((it) => {
      const vid = youtubeVideoId(it.url);
      return !(vid && verdicts.get(vid) === 1);
    })
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  const items = nonShorts.slice(0, Math.min(MAX_ITEMS_PER_FEED, RETAIN_PER_FEED));

  if (items.length) {
    // Oldest first, so rowid ascends with recency. `items` is newest-first and a
    // D1 batch runs in order, so inserting it as it stands gives the NEWEST item
    // the LOWEST id. Both places that break a tie do it on `id DESC` (the list
    // query in functions/rss/index.ts and the retention rank below), and ties
    // are not rare: `fetched_at` has second granularity, so every item of a
    // scraped page ties, as does any feed publishing several posts under one
    // date. Inserted the other way round, the top of the page would sort last
    // and be the first thing retention trimmed.
    const stmts = [...items].reverse().map((it) =>
      env.READER_DB.prepare(
        `INSERT OR IGNORE INTO items (feed_id, guid, url, title, author, summary, content, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(feed.id, it.guid, it.url, it.title, it.author, it.summary, it.content, it.publishedAt),
    );
    const res = await env.READER_DB.batch(stmts);
    inserted = res.reduce((n, x) => n + (x.meta?.changes ?? 0), 0);
  }

  // Partial decay. A scrape that stops matching entirely is already an error
  // inside fetchScrape; this catches the commoner half, where a redesign leaves
  // the container selector matching a fraction of the list and the feed looks
  // healthy while quietly losing most of its articles. The trailing count is
  // deliberately NOT updated on a decayed poll: re-baselining to the smaller
  // figure is how a gradual decay escapes a threshold it never crosses twice.
  const scraped = feed.kind === 'scrape';
  const decayed =
    scraped &&
    feed.last_item_count != null &&
    feed.last_item_count >= SCRAPE_DECAY_FLOOR &&
    r.items.length < feed.last_item_count * SCRAPE_DECAY_RATIO;
  if (decayed) {
    stats.ok--;
    stats.errored++;
  }
  const status = decayed ? 'error' : 'ok';
  const error = decayed
    ? `The scrape rule now matches ${r.items.length} of the ${feed.last_item_count} items it last found; check the page's markup.`
    : null;

  await env.READER_DB.prepare(
    `UPDATE feeds SET etag = ?, last_modified = ?, last_polled_at = datetime('now'),
            last_status = ?, last_error = ?,
            error_count = CASE WHEN ? = 'error' THEN error_count + 1 ELSE 0 END,
            title = CASE WHEN (title IS NULL OR title = '') AND ? <> '' THEN ? ELSE title END,
            site_url = COALESCE(site_url, ?),
            last_item_count = COALESCE(?, last_item_count)
       WHERE id = ?`,
  )
    .bind(
      // A decayed poll drops its validators for the same reason a rejected body
      // does: keeping them lets the next poll answer 304 and report healthy
      // without the page being read again.
      decayed ? null : r.etag,
      decayed ? null : r.lastModified,
      status,
      error,
      status,
      r.feedTitle ?? '',
      r.feedTitle ?? '',
      r.siteUrl,
      scraped && !decayed ? r.items.length : null,
      feed.id,
    )
    .run();
  return inserted;
}

/** Write one `poll_runs` row. Never throws: a failed record must not fail a poll. */
async function recordRun(
  env: Env,
  trigger: string,
  startedAt: string,
  startedMs: number,
  stats: RunStats,
  note: string | null,
): Promise<void> {
  try {
    await env.READER_DB.prepare(
      `INSERT INTO poll_runs (started_at, trigger, feeds, ok, not_modified, errored,
                              inserted, shorts_swept, subrequests, duration_ms, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        startedAt,
        trigger,
        stats.feeds,
        stats.ok,
        stats.notModified,
        stats.errored,
        stats.inserted,
        stats.shortsSwept,
        stats.subrequests,
        Date.now() - startedMs,
        note,
      )
      .run();
  } catch (err) {
    console.error('[feed-poller] could not record the run:', err);
  }
}

async function pollAll(env: Env, force = false, trigger = 'cron'): Promise<RunStats> {
  const stats = newStats();
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let note: string | null = null;
  try {
    const feeds = await dueFeeds(env, force);
    stats.feeds = feeds.length;
    // One read for the whole run: the insert filter and the sweep share it.
    const verdicts = await loadVerdicts(env);
    // Sequential: personal-scale feed counts are small, and this stays well under
    // the Worker subrequest/CPU limits without needing concurrency management.
    for (const feed of feeds) {
      try {
        stats.inserted += await pollFeed(env, feed, stats, verdicts);
      } catch (err) {
        console.error(`[feed-poller] feed ${feed.id} (${feed.feed_url}) failed:`, err);
      }
    }
    await sweepYouTubeShorts(env, stats, verdicts);
    if (stats.unclassified) {
      note = `${stats.unclassified} YouTube video(s) still unclassified, carried to the next poll`;
    }
    await cleanup(env);
  } catch (err) {
    // A throw here (an exhausted subrequest budget during the sweep, a D1
    // failure in cleanup) used to surface only as a non-200 with no record of
    // how far the poll got. Keep the partial tallies and say what ended it.
    note = `run ended early: ${String(err)}`;
    console.error('[feed-poller]', note);
    await recordRun(env, trigger, startedAt, startedMs, stats, note);
    throw err;
  }
  // Seal the poll_runs row, and with it duration_ms and finished_at. A lost or
  // inflated row would misreport a poll whose items had already landed, and the
  // status probe keys off this row.
  await recordRun(env, trigger, startedAt, startedMs, stats, note);
  return stats;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      pollAll(env, false, 'cron').then((r) =>
        console.log(
          `[feed-poller] polled ${r.feeds} feeds, ${r.inserted} new items, ${r.subrequests} subrequests`,
        ),
      ),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // Fail closed: an unconfigured secret means the on-demand trigger is off.
    if (!env.POLL_TRIGGER_SECRET) {
      return new Response('feed-poller: POLL_TRIGGER_SECRET is not configured.\n', { status: 503 });
    }
    const url = new URL(request.url);
    const given = url.searchParams.get('secret') ?? request.headers.get('X-Poll-Secret');
    if (given !== env.POLL_TRIGGER_SECRET) return new Response('forbidden\n', { status: 403 });

    // A manual trigger forces every feed, so stuck/backed-off feeds recover.
    const r = await pollAll(env, true, 'manual');
    // `ok` is the endpoint's success flag and must stay boolean; RunStats has an
    // `ok` tally of its own, so rename it out of the way rather than let the
    // spread overwrite the flag.
    const { ok: fetched, ...rest } = r;
    return Response.json({ ok: true, fetched, ...rest });
  },
};
