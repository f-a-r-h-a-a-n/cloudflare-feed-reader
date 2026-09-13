/**
 * Functional smoke test for the feed-poller. Bundling proved nothing: it happily
 * shipped a `cleanup is not defined` ReferenceError to production, because the
 * repo has no TypeScript installed and esbuild does not resolve free identifiers.
 * This drives the real Worker handler end to end against a fake D1 and a stubbed
 * fetch, so every statement on the poll path actually executes.
 */
import { pathToFileURL } from 'node:url';

const REPO = process.argv[2];
const TMP = process.argv[3];
const { build } = await import(pathToFileURL(`${REPO}/node_modules/esbuild/lib/main.js`).href);
const out = `${TMP}/poller-verify-bundle.mjs`;
await build({
  entryPoints: [`${REPO}/feed-poller/src/index.ts`],
  bundle: true, format: 'esm', platform: 'node', absWorkingDir: REPO, outfile: out, logLevel: 'error',
});

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
<item><title>Post</title><link>https://e.com/p1</link><guid>p1</guid></item></channel></rss>`;
const YT = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>Chan</title>
<entry><id>yt:video:AAAAAAAAAAA</id><title>Long</title>
  <link href="https://www.youtube.com/watch?v=AAAAAAAAAAA"/></entry>
<entry><id>yt:video:BBBBBBBBBBB</id><title>Short</title>
  <link href="https://www.youtube.com/watch?v=BBBBBBBBBBB"/></entry>
<entry><id>yt:video:CCCCCCCCCCC</id><title>Unanswered</title>
  <link href="https://www.youtube.com/watch?v=CCCCCCCCCCC"/></entry></feed>`;

const sql = [];        // every statement the poller issues
const calls = [];      // the same, with their bound values (insert order, status writes)
const fetched = [];    // every URL it requests

/** A page with no feed, in the shape the scrape rule below is written for. */
const PAGE = `<html><head><title>Page</title></head><body><main>
  <div class="card"><h3><a href="/one">One</a></h3></div>
  <div class="card"><h3><a href="/two">Two</a></h3></div>
  <div class="card"><h3><a href="/three">Three</a></h3></div>
</main></body></html>`;
const SCRAPE_RULE = '{"item":".card","title":"h3","link":"a"}';

/** Pages of a given size, for the decay threshold's boundary cases. */
const cards = (n) =>
  `<html><head><title>P</title></head><body><main>${Array.from(
    { length: n },
    (_, i) => `<div class="card"><h3><a href="/a${i}">Item number ${i}</a></h3></div>`,
  ).join('')}</main></body></html>`;

function fakeDb(overrides = {}) {
  const rowsFor = (q, binds) => {
    if (/FROM youtube_video_class/i.test(q)) return [];                       // no verdicts yet
    if (overrides.ytFeeds && /FROM feeds WHERE feed_url LIKE/i.test(q)) return overrides.ytFeeds;
    if (overrides.ytItems && /FROM items WHERE feed_id/i.test(q)) return overrides.ytItems(binds[0]);
    if (/FROM feeds WHERE feed_url LIKE/i.test(q)) return [{ id: 2, feed_url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx' }];
    if (/FROM feeds/i.test(q)) return [
      { id: 1, feed_url: 'https://e.com/rss', title: 'Blog', etag: null, last_modified: null, error_count: 0, last_polled_at: null, kind: 'feed', scrape_rule: null, last_item_count: null },
      { id: 2, feed_url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx', title: 'Chan', etag: null, last_modified: null, error_count: 0, last_polled_at: null, kind: 'feed', scrape_rule: null, last_item_count: null },
      // A healthy scrape, a scrape whose rule has decayed (10 items last time,
      // three now), and one whose stored rule is unusable.
      { id: 3, feed_url: 'https://page.example/list', title: 'Page', etag: null, last_modified: null, error_count: 0, last_polled_at: null, kind: 'scrape', scrape_rule: SCRAPE_RULE, last_item_count: null },
      { id: 4, feed_url: 'https://decayed.example/list', title: 'Decayed', etag: null, last_modified: null, error_count: 0, last_polled_at: null, kind: 'scrape', scrape_rule: SCRAPE_RULE, last_item_count: 10 },
      { id: 5, feed_url: 'https://broken.example/list', title: 'Broken', etag: null, last_modified: null, error_count: 0, last_polled_at: null, kind: 'scrape', scrape_rule: '{oops', last_item_count: null },
      // The threshold's two boundaries: exactly half of the trailing count is
      // NOT decay, and a trailing count below the floor cannot trigger it.
      { id: 6, feed_url: 'https://half.example/list', title: 'Half', etag: null, last_modified: null, error_count: 0, last_polled_at: null, kind: 'scrape', scrape_rule: SCRAPE_RULE, last_item_count: 10 },
      { id: 7, feed_url: 'https://floor.example/list', title: 'Floor', etag: null, last_modified: null, error_count: 0, last_polled_at: null, kind: 'scrape', scrape_rule: SCRAPE_RULE, last_item_count: 3 },
    ];
    if (/FROM items WHERE feed_id/i.test(q)) return [
      { id: 10, url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' },
      { id: 11, url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB' },
      { id: 12, url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC' },
    ];
    return [];
  };
  const stmt = (q) => {
    let binds = [];
    const self = {
      bind: (...a) => { binds = a; return self; },
      run: async () => { sql.push(q.trim().split('\n')[0].trim()); calls.push({ q, binds }); return { meta: { changes: 1 } }; },
      all: async () => { sql.push(q.trim().split('\n')[0].trim()); return { results: rowsFor(q, binds) }; },
      first: async () => { sql.push(q.trim().split('\n')[0].trim()); return rowsFor(q, binds)[0] ?? null; },
    };
    return self;
  };
  return {
    prepare: stmt,
    batch: async (stmts) => { for (const s of stmts) await s.run(); return stmts.map(() => ({ meta: { changes: 1 } })); },
  };
}

/**
 * Durations as the Data API reports them: a 12-minute video, a 108-second Short
 * (over the 60s cut-off this classifier used until 21 August 2026, under
 * YouTube's real 3-minute Shorts ceiling), and a 150-second video the surface
 * refuses to answer for.
 */
const API_DURATIONS = { AAAAAAAAAAA: 'PT12M3S', BBBBBBBBBBB: 'PT1M48S', CCCCCCCCCCC: 'PT2M30S' };

const seenHeaders = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  fetched.push(u);
  seenHeaders.push(init?.headers ?? null);
  if (u.includes('googleapis.com/youtube/v3/videos')) {
    const ids = new URL(u).searchParams.get('id').split(',');
    // Anything not named is a 60-second video, i.e. a candidate, which is what
    // lets the budget block below drive the KEYED path as well as the keyless one.
    const items = ids.map((id) => ({ id, contentDetails: { duration: API_DURATIONS[id] ?? 'PT1M0S' } }));
    return new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/feeds/videos.xml')) return new Response(YT, { headers: { 'content-type': 'application/atom+xml' } });
  if (u.includes('/shorts/BBBBBBBBBBB')) return new Response(null, { status: 200 });                        // a Short
  if (u.includes('/shorts/CCCCCCCCCCC')) return new Response(null, { status: 429 });                        // no answer
  if (u.includes('/shorts/')) return new Response(null, { status: 303, headers: { location: '/watch?v=x' } }); // long
  if (u.startsWith('https://half.example/')) return new Response(cards(5), { headers: { 'content-type': 'text/html' } });
  if (u.startsWith('https://floor.example/')) return new Response(cards(1), { headers: { 'content-type': 'text/html' } });
  if (u.startsWith('https://page.example/') || u.startsWith('https://decayed.example/')) {
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return new Response(RSS, { headers: { 'content-type': 'application/rss+xml' } });
};

const mod = await import(pathToFileURL(out).href);
const env = { READER_DB: fakeDb(), POLL_TRIGGER_SECRET: 's3cret' };

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}  ${detail ?? ''}`); }
};

console.log('poller fetch handler:');
let res = await mod.default.fetch(new Request('https://p.dev/'), env);
check('no secret is refused', res.status === 403, String(res.status));

res = await mod.default.fetch(new Request('https://p.dev/?secret=s3cret'), env);
const body = await res.json();
check('a real poll returns 200', res.status === 200, `${res.status} ${JSON.stringify(body)}`);
check('ok stays a boolean success flag', body.ok === true, JSON.stringify(body.ok));
check('feeds are counted', body.feeds === 7, JSON.stringify(body));
check('fetched carries the ok tally', typeof body.fetched === 'number', JSON.stringify(body));
check('subrequests are counted', body.subrequests > 0, String(body.subrequests));

const joined = sql.join(' | ');
// A read item must survive the poll, and both limbs of the loop that used to
// undo it are guarded here. Deleting a read row frees its (feed_id, guid) dedup
// key, and the poll that next answered 200 re-inserted the item with is_read
// back at 0, so marking something read silently came undone (29 August 2026).
// The deletes are enumerated against a whitelist rather than grepped for the old
// wording, because a sweep re-introduced under any other phrasing is the same
// defect and a negative regex would wave it through.
const itemDeletes = calls.map((c) => c.q).filter((q) => /DELETE\s+FROM\s+items\b/i.test(q));
const allowedDelete = (q) =>
  /DELETE FROM items WHERE is_starred = 0 AND id IN/.test(q) || // the per-feed cap
  /DELETE FROM items WHERE id = \?/.test(q);                    // the Shorts sweep
check('nothing is deleted for having been read', itemDeletes.every(allowedDelete),
  itemDeletes.filter((q) => !allowedDelete(q)).join(' !! '));
// The other door to the same symptom: OR REPLACE would reset is_read to 0 on a
// surviving row every poll, with no delete anywhere to notice.
check('items are inserted OR IGNORE, never OR REPLACE',
  /INSERT OR IGNORE INTO items/.test(joined) && !/INSERT OR REPLACE INTO items\b/.test(joined),
  'the item insert can overwrite read state');
check('retention exempts stars (per-feed cap)', /DELETE FROM items WHERE is_starred = 0 AND id IN/.test(joined), 'cap has no is_starred guard');
check('a poll_runs row is written', /INSERT INTO poll_runs/.test(joined), 'no poll_runs insert');
check('a Shorts verdict is recorded', /INSERT OR REPLACE INTO youtube_video_class/.test(joined), 'no verdict written');
check('the Short is deleted', /DELETE FROM items WHERE id = \?/.test(joined), 'no item delete');
check('every stored video was probed once', fetched.filter((u) => u.includes('/shorts/')).length === 3,
  String(fetched.filter((u) => u.includes('/shorts/')).length));
check('a probe that did not answer records no verdict',
  !calls.some((c) => /INSERT OR REPLACE INTO youtube_video_class/.test(c.q) && c.binds[0] === 'CCCCCCCCCCC'),
  'CCCCCCCCCCC was recorded on a 429');

console.log('scrape feeds:');
const feedUpdate = (id) => calls.find((c) => /UPDATE feeds SET etag/.test(c.q) && c.binds[c.binds.length - 1] === id);
const inserts = (id) => calls.filter((c) => /INSERT OR IGNORE INTO items/.test(c.q) && c.binds[0] === id).map((c) => c.binds[1]);

check('the scrape page was fetched', fetched.includes('https://page.example/list'), fetched.join(' '));
check('a scraped page yields items', inserts(3).length === 3, JSON.stringify(inserts(3)));
check('items insert oldest first, so rowid ascends with recency',
  JSON.stringify(inserts(3)) === JSON.stringify(['https://page.example/three', 'https://page.example/two', 'https://page.example/one']),
  JSON.stringify(inserts(3)));
check('a healthy scrape is ok', feedUpdate(3)?.binds[2] === 'ok', JSON.stringify(feedUpdate(3)?.binds));
check('  ... and records its item count', feedUpdate(3)?.binds[8] === 3, JSON.stringify(feedUpdate(3)?.binds));
check('an ordinary feed records no item count', feedUpdate(1)?.binds[8] === null, JSON.stringify(feedUpdate(1)?.binds));

check('a decayed rule is an error, not a quiet feed', feedUpdate(4)?.binds[2] === 'error', JSON.stringify(feedUpdate(4)?.binds));
check('  ... and says what it now matches', /3 of the 10/.test(String(feedUpdate(4)?.binds[3])), String(feedUpdate(4)?.binds[3]));
check('  ... and drops its validators', feedUpdate(4)?.binds[0] === null, String(feedUpdate(4)?.binds[0]));
check('  ... and does NOT re-baseline the count', feedUpdate(4)?.binds[8] === null, String(feedUpdate(4)?.binds[8]));
check('  ... while still keeping the items it did find', inserts(4).length === 3, JSON.stringify(inserts(4)));

// Boundaries of the authored threshold, both directions of the comparison.
check('exactly half the trailing count is NOT decay', feedUpdate(6)?.binds[2] === 'ok', JSON.stringify(feedUpdate(6)?.binds));
check('  ... and it re-baselines to the smaller figure', feedUpdate(6)?.binds[8] === 5, JSON.stringify(feedUpdate(6)?.binds));
check('a trailing count under the floor cannot trigger decay', feedUpdate(7)?.binds[2] === 'ok', JSON.stringify(feedUpdate(7)?.binds));

const brokenUpdate = calls.find((c) => /last_status = 'error'/.test(c.q) && c.binds[1] === 5);
check('an unusable rule errors without fetching', !fetched.some((u) => u.includes('broken.example')), fetched.join(' '));
check('  ... and says the rule is the problem', /no usable rule/.test(String(brokenUpdate?.binds[0])), String(brokenUpdate?.binds[0]));

console.log('shorts with the Data API keyed (the production path):');
sql.length = 0; calls.length = 0; fetched.length = 0;
await mod.default.fetch(new Request('https://p.dev/?secret=s3cret'), { ...env, YOUTUBE_API_KEY: 'AIzaTEST' });

const verdicts = calls
  .filter((c) => /INSERT OR REPLACE INTO youtube_video_class/.test(c.q))
  .map((c) => c.binds.join('='));
const probes = fetched.filter((u) => u.includes('/shorts/')).map((u) => u.split('/shorts/')[1]);
const apiCalls = fetched.filter((u) => u.includes('googleapis.com'));

check('the API is asked once, batched', apiCalls.length === 1, JSON.stringify(apiCalls.length));
check('a video over the Shorts ceiling costs no probe, while the others do',
  probes.length === 2 && !probes.includes('AAAAAAAAAAA'), JSON.stringify(probes));
check('  ... and is settled as a long video', verdicts.includes('AAAAAAAAAAA=0'), JSON.stringify(verdicts));
// The defect this pair exists to catch: 108 seconds is over the old 60-second
// cut-off, so duration alone called it a long video and the verdict was final.
check('a 108-second video is NOT settled on duration alone', probes.includes('BBBBBBBBBBB'), JSON.stringify(probes));
check('  ... and the surface makes it a Short', verdicts.includes('BBBBBBBBBBB=1'), JSON.stringify(verdicts));
check('  ... and its item is deleted', calls.some((c) => /DELETE FROM items WHERE id = \?/.test(c.q) && c.binds[0] === 11),
  JSON.stringify(calls.filter((c) => /DELETE FROM items WHERE id = \?/.test(c.q)).map((c) => c.binds)));
check('an unanswered candidate stays unknown for the next poll',
  probes.includes('CCCCCCCCCCC') && !verdicts.some((v) => v.startsWith('CCCCCCCCCCC')), JSON.stringify(verdicts));

// The per-feed cap is not a bound on a POLL: with six YouTube feeds it permits
// 240 probes, and a Worker gets 1,000 subrequests for everything it does. Six
// feeds of forty stored videos each is that shape. Run on BOTH paths: the keyed
// one is the reason the budget was added, since it never probed before, and
// testing only the keyless path would leave that claim uncovered.
const manyFeeds = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, feed_url: `https://www.youtube.com/feeds/videos.xml?channel_id=UC${i}` }));
const manyItems = (feedId) =>
  Array.from({ length: 40 }, (_, i) => ({
    id: feedId * 1000 + i,
    url: `https://www.youtube.com/watch?v=${`V${feedId}${String(i).padStart(2, '0')}`.padEnd(11, 'x')}`,
  }));

for (const [label, keyed] of [['keyless', false], ['keyed', true]]) {
  console.log(`the run-level probe budget, ${label}:`);
  sql.length = 0; calls.length = 0; fetched.length = 0;
  const bigEnv = { READER_DB: fakeDb({ ytFeeds: manyFeeds, ytItems: manyItems }), POLL_TRIGGER_SECRET: 's3cret' };
  if (keyed) bigEnv.YOUTUBE_API_KEY = 'AIzaTEST';
  const bigBody = await (await mod.default.fetch(new Request('https://p.dev/?secret=s3cret'), bigEnv)).json();
  const bigProbes = fetched.filter((u) => u.includes('/shorts/')).length;
  const bigVerdicts = calls.filter((c) => /INSERT OR REPLACE INTO youtube_video_class/.test(c.q)).length;
  check('a poll cannot spend more than its probe budget', bigProbes === 200, String(bigProbes));
  check('  ... and the ids it skipped are left unrecorded, for the next poll', bigVerdicts === 200, String(bigVerdicts));
  check('  ... and how many it left says so on disk, not only in a log',
    bigBody.unclassified === 40 && /40 YouTube video\(s\) still unclassified/.test(String(calls.find((c) => /INSERT INTO poll_runs/.test(c.q))?.binds.at(-1))),
    `${bigBody.unclassified} / ${String(calls.find((c) => /INSERT INTO poll_runs/.test(c.q))?.binds.at(-1))}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
