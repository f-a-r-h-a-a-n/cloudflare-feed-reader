/**
 * Behaviour check for functions/_shared/feed.ts. There is no test runner in this
 * repo, so this is a harness rather than an invented suite: it bundles the real
 * module and drives it with a stubbed global fetch.
 *
 * Usage: node scripts/verify/verify-feed.mjs <repo-root> <tmp-dir>
 */
import { pathToFileURL } from 'node:url';

const REPO = process.argv[2];
const { build } = await import(pathToFileURL(`${REPO}/node_modules/esbuild/lib/main.js`).href);
const out = `${process.argv[3]}/feed-verify-bundle.mjs`;
await build({
  entryPoints: [`${REPO}/functions/_shared/feed.ts`],
  bundle: true, format: 'esm', platform: 'node', absWorkingDir: REPO, outfile: out, logLevel: 'error',
});
const { fetchFeed, discoverFeed } = await import(pathToFileURL(out).href);

// The default user-agent is deployment-specific, so the assertion below reads it
// from the shipped constant rather than hard-coding a domain. Changing
// DEFAULT_UA must not turn this suite red.
const cfgOut = `${process.argv[3]}/feed-verify-config.mjs`;
await build({
  entryPoints: [`${REPO}/functions/_shared/config.ts`],
  bundle: true, format: 'esm', platform: 'node', absWorkingDir: REPO, outfile: cfgOut, logLevel: 'error',
});
const { DEFAULT_UA } = await import(pathToFileURL(cfgOut).href);

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title>One</title><link>https://e.com/1</link><guid>1</guid></item></channel></rss>`;
const CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><div id="challenge-running">Checking your browser</div></body></html>`;
const BROKEN = `<?xml version="1.0"?><rss><channel><item><title>unclosed`;

function stub(responses) {
  let i = 0;
  globalThis.fetch = async (url) => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(r.body ?? null, {
      status: r.status ?? 200,
      headers: { 'content-type': r.ct ?? 'text/html', ...(r.headers ?? {}) },
    });
  };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}  ${detail ?? ''}`); }
}

console.log('fetchFeed:');

stub([{ body: RSS, ct: 'application/rss+xml', headers: { etag: 'W/"a"' } }]);
let r = await fetchFeed('https://e.com/f', null, null);
check('a real feed is ok with items', r.status === 'ok' && r.items.length === 1, JSON.stringify(r.status));
check('a real feed keeps its etag', r.etag === 'W/"a"', String(r.etag));

stub([{ body: CHALLENGE, ct: 'text/html; charset=utf-8', headers: { etag: 'W/"b"' } }]);
r = await fetchFeed('https://e.com/f', 'W/"old"', 'Mon, 01 Jan 2020 00:00:00 GMT');
check('a 200 challenge page is an error', r.status === 'error', `${r.status} ${r.error ?? ''}`);
check('  ... says it was not a feed', /was not a feed/.test(r.error ?? ''), r.error);
check('  ... drops the stored etag', r.etag === null, String(r.etag));
check('  ... drops the stored last-modified', r.lastModified === null, String(r.lastModified));

stub([{ body: '﻿' + RSS, ct: 'text/html' }]);
r = await fetchFeed('https://e.com/f', null, null);
check('a BOM-prefixed feed still parses', r.status === 'ok' && r.items.length === 1, `${r.status} ${r.error ?? ''}`);

stub([{ status: 304 }]);
r = await fetchFeed('https://e.com/f', 'W/"old"', null);
check('a 304 is still not-modified', r.status === 'not-modified', r.status);
check('  ... and keeps its validators', r.etag === 'W/"old"', String(r.etag));

// Truncated XML: fast-xml-parser is lenient and still recovers the item it
// could read, so the feed stays ok and the reader gets the content. That is the
// wanted behaviour, and the reason the fix gates on 'is this a feed at all'
// rather than on the item count, which a genuinely quiet feed also fails.
stub([{ body: BROKEN, ct: 'application/rss+xml' }]);
r = await fetchFeed('https://e.com/f', 'W/"old"', null);
check('truncated XML still yields what parsed', r.status === 'ok' && r.items.length === 1,
  `${r.status} items=${r.items?.length}`);

// A body that genuinely breaks the parser is still caught.
stub([{ body: '<?xml version="1.0"?><rss><![CDATA[', ct: 'application/rss+xml' }]);
r = await fetchFeed('https://e.com/f', 'W/"old"', null);
check('unparseable XML is an error', r.status === 'error' && /Parse error/.test(r.error ?? ''), `${r.status} ${r.error ?? ''}`);
check('  ... and drops its validators', r.etag === null, String(r.etag));

stub([{ status: 403, body: 'no' }]);
r = await fetchFeed('https://e.com/f', null, null);
check('a 403 is still an error', r.status === 'error' && /HTTP 403/.test(r.error ?? ''), r.error);

console.log('discoverFeed entity decoding:');
const PAGE = `<html><head><link rel="alternate" type="application/rss+xml"
  href="https://e.com/index.php?format=feed&amp;type=rss"></head><body>hi</body></html>`;
stub([
  { body: PAGE, ct: 'text/html' },
  { body: RSS, ct: 'application/rss+xml' },
]);
const d = await discoverFeed('https://e.com/');
check('an &amp; in the href is decoded', d.feedUrl === 'https://e.com/index.php?format=feed&type=rss', d.feedUrl);

console.log('item identity:');

// Google Trends ships no <guid> and gives every item a <link> identical to the
// channel's own link (verified 24 August 2026), so a link-based fallback
// collapses every item to one identity and the archive keeps one row for ever.
const SELF_LINK = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<link>https://e.com/f</link>
<item><title>One</title><link>https://e.com/f</link><pubDate>Mon, 24 Aug 2026 06:40:00 -0700</pubDate></item>
<item><title>Two</title><link>https://e.com/f</link><pubDate>Mon, 24 Aug 2026 06:40:00 -0700</pubDate></item>
</channel></rss>`;
stub([{ body: SELF_LINK, ct: 'application/rss+xml' }]);
r = await fetchFeed('https://e.com/f', null, null);
check('items whose link is the channel link get distinct guids',
  r.items.length === 2 && r.items[0].guid !== r.items[1].guid,
  JSON.stringify(r.items?.map((i) => i.guid)));

// Trends buckets every item's pubDate to the snapshot's own generation time:
// fetches thirty minutes apart returned 06:40 then 07:10 (measured 24 August
// 2026). Keying the fallback on the full timestamp would mint a new id on
// nearly every poll, so the same topic on the same day must hash the same.
const SNAP = (hhmm) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<link>https://e.com/f</link>
<item><title>same topic</title><link>https://e.com/f</link><pubDate>Mon, 24 Aug 2026 ${hhmm}:00 -0700</pubDate></item>
</channel></rss>`;
stub([{ body: SNAP('06:40'), ct: 'application/rss+xml' }]);
const snapA = await fetchFeed('https://e.com/f', null, null);
stub([{ body: SNAP('07:10'), ct: 'application/rss+xml' }]);
const snapB = await fetchFeed('https://e.com/f', null, null);
check('a re-timestamped item keeps one identity within the day',
  snapA.items[0].guid === snapB.items[0].guid,
  `${snapA.items?.[0]?.guid} vs ${snapB.items?.[0]?.guid}`);

// The same topic on a LATER day is a fresh signal and must not merge.
stub([{ body: SNAP('06:40').replace('24 Aug', '25 Aug'), ct: 'application/rss+xml' }]);
const snapC = await fetchFeed('https://e.com/f', null, null);
check('the same title on a later day is a distinct item',
  snapA.items[0].guid !== snapC.items[0].guid,
  `${snapA.items?.[0]?.guid} vs ${snapC.items?.[0]?.guid}`);

// The channel-link guard must hold for Atom and RDF too, not only RSS.
const ATOM_SELF = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>
<link rel="alternate" href="https://e.com/f"/>
<entry><title>One</title><link rel="alternate" href="https://e.com/f"/><updated>2026-08-24T06:40:00Z</updated></entry>
<entry><title>Two</title><link rel="alternate" href="https://e.com/f"/><updated>2026-08-24T06:40:00Z</updated></entry>
</feed>`;
stub([{ body: ATOM_SELF, ct: 'application/atom+xml' }]);
r = await fetchFeed('https://e.com/f', null, null);
check('Atom entries linking to the feed itself get distinct guids',
  r.items.length === 2 && r.items[0].guid !== r.items[1].guid,
  JSON.stringify(r.items?.map((i) => i.guid)));

console.log('per-feed request headers:');

// METI rejects our feed user-agent with 403 and Eurostat rejects our Accept
// list with 406, both verified 24 August 2026, so a roster feed may override
// either without changing what every other feed sends.
let seen = null;
globalThis.fetch = async (_url, init) => {
  seen = init?.headers ?? null;
  return new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
};
await fetchFeed('https://e.com/f', null, null, { userAgent: 'UA-X', accept: '*/*' });
check('a per-feed user-agent overrides the default', seen?.['User-Agent'] === 'UA-X', JSON.stringify(seen));
check('a per-feed accept overrides the default', seen?.Accept === '*/*', JSON.stringify(seen));
seen = null;
await fetchFeed('https://e.com/f', null, null);
check('no override keeps the shared default user-agent',
  seen?.['User-Agent'] === DEFAULT_UA, JSON.stringify(seen));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
