/**
 * Behaviour check for the scrape-to-feed extractor (`functions/_shared/scrape.ts`),
 * which builds a feed for a page that publishes none. Same shape as the other
 * harnesses: bundle the real module, drive it with a stubbed global fetch.
 *
 * The fixtures are adversarial on purpose. A hand-rolled tag scanner is the one
 * place this repo does not get to lean on a battle-tested parser, so the cases
 * that break such scanners (a script body containing a close tag, a comment
 * containing markup, an attribute value containing '>', containers nested inside
 * containers) are checks, not afterthoughts.
 */
import { pathToFileURL } from 'node:url';

const REPO = process.argv[2];
const TMP = process.argv[3];
const { build } = await import(pathToFileURL(`${REPO}/node_modules/esbuild/lib/main.js`).href);
const out = `${TMP}/scrape-verify-bundle.mjs`;
await build({
  entryPoints: [`${REPO}/functions/_shared/scrape.ts`],
  bundle: true, format: 'esm', platform: 'node', absWorkingDir: REPO, outfile: out, logLevel: 'error',
});
const { extractItems, suggestRules, parseRule, fetchScrape } = await import(pathToFileURL(out).href);

const BASE = 'https://news.example/analysis';

/** A list page in the shape most sites without a feed actually publish. */
const PAGE = `<!DOCTYPE html><html><head><title>Analysis &amp; Comment</title>
<script>var tpl = "<div class='card'></div>"; if (a < b && c > d) { go(); }</script>
<style>.card > h3 { color: red }</style></head>
<body>
<nav class="nav"><a href="/">Home</a><a href="/about">About</a></nav>
<!-- <div class="card"><h3><a href="/ghost">Commented out</a></h3></div> -->
<main>
  <div class="card" data-tip="a > b">
    <h3><a href="/posts/one">First &amp; foremost</a></h3>
    <time datetime="2026-08-01T09:00:00Z">1 August</time>
    <p class="dek">An <em>opening</em> piece&nbsp;about method.</p>
  </div>
  <div class="card">
    <h3><a href="/posts/two">Second piece&#8217;s title</a></h3>
    <time datetime="2026-07-30">30 July</time>
    <p class="dek">Another one.</p>
  </div>
  <div class="card">
    <h3><a href="https://elsewhere.example/three">Third, offsite</a></h3>
    <p class="dek">Syndicated.</p>
  </div>
  <div class="card"><h3>Fourth, no link</h3><p class="dek">Should be skipped.</p></div>
</main>
<footer><a href="/privacy">Privacy</a></footer></body></html>`;

const RULE = { item: '.card', title: 'h3', link: 'a', date: 'time', summary: '.dek' };

/** Containers inside containers: the outer match must win, and win once. */
const NESTED = `<html><body><ul class="list">
  <li class="row"><a href="/a">A</a><ul class="list"><li class="row"><a href="/a1">A1</a></li></ul></li>
  <li class="row"><a href="/b">B</a></li>
</ul></body></html>`;

const NO_LIST = `<html><head><title>About</title></head><body><h1>About us</h1>
<p>We are a company. <a href="/contact">Contact</a> us.</p></body></html>`;

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}  ${detail ?? ''}`); }
};

console.log('extractItems:');
const items = extractItems(PAGE, BASE, RULE);
check('extracts one item per linked container', items.length === 3, `got ${items.length}`);
check('keeps document order', items.map((i) => i.title).join('|').startsWith('First'), items.map((i) => i.title).join('|'));
check('resolves a relative link', items[0]?.url === 'https://news.example/posts/one', String(items[0]?.url));
check('keeps an absolute link', items[2]?.url === 'https://elsewhere.example/three', String(items[2]?.url));
check('guid is the resolved url', items[0]?.guid === items[0]?.url, `${items[0]?.guid} vs ${items[0]?.url}`);
check('decodes named entities in a title', items[0]?.title === 'First & foremost', JSON.stringify(items[0]?.title));
check('decodes numeric entities in a title', items[1]?.title === 'Second piece’s title', JSON.stringify(items[1]?.title));
check('strips inline tags from a summary', items[0]?.summary === 'An opening piece about method.', JSON.stringify(items[0]?.summary));
check('reads a date from datetime=', items[0]?.publishedAt === '2026-08-01T09:00:00.000Z', String(items[0]?.publishedAt));
check('a date-only value still parses', (items[1]?.publishedAt ?? '').startsWith('2026-07-30'), String(items[1]?.publishedAt));
check('a container with no date has none', items[2]?.publishedAt === null, String(items[2]?.publishedAt));
check('skips a container with no link', !items.some((i) => /Fourth/.test(i.title)), items.map((i) => i.title).join('|'));
check('ignores markup inside a script body', !items.some((i) => /Commented|tpl/.test(i.title ?? '')), items.map((i) => i.title).join('|'));
check('ignores a commented-out container', !items.some((i) => /Ghost|Commented/i.test(`${i.title} ${i.url}`)), items.map((i) => i.url).join('|'));
check('an attribute containing > does not break the scan', items[0]?.title === 'First & foremost', JSON.stringify(items[0]?.title));
check('nav and footer links are not items', !items.some((i) => /\/privacy|\/about$/.test(i.url ?? '')), items.map((i) => i.url).join('|'));

const nested = extractItems(NESTED, BASE, { item: '.row', link: 'a' });
check('a nested container is counted once, outermost', nested.length === 2, `got ${nested.length}: ${nested.map((i) => i.url).join(',')}`);
check('  ... and takes the outer link', nested[0]?.url === 'https://news.example/a', String(nested[0]?.url));

const noSel = extractItems(PAGE, BASE, { item: '.card' });
check('title falls back to the heading with no title selector', noSel[0]?.title === 'First & foremost', JSON.stringify(noSel[0]?.title));
check('link falls back to the headline anchor', noSel[0]?.url === 'https://news.example/posts/one', String(noSel[0]?.url));

// Caught by a live probe on 16 August 2026: taking the block's FIRST anchor gave
// '128' pointing at /login on a link aggregator and an empty title pointing at /vote on
// news.ycombinator.com, because both open their rows with interactive chrome.
const VOTED = `<html><body><ol class="stories">
  <li class="story"><a href="/vote?id=1" class="up">128</a>
    <span class="link"><a href="https://elsewhere.example/a-properly-long-headline">A properly long headline about something</a></span>
    <a href="/s/1/comments">24 comments</a></li>
  <li class="story"><a href="/vote?id=2" class="up">7</a>
    <span class="link"><a href="https://elsewhere.example/another-real-story">Another real story with a full title</a></span>
    <a href="/s/2/comments">3 comments</a></li>
</ol></body></html>`;
const voted = extractItems(VOTED, BASE, { item: '.story' });
check('the headline wins over an upvote link', voted[0]?.url === 'https://elsewhere.example/a-properly-long-headline', String(voted[0]?.url));
check('  ... and the title is the headline, not the score', voted[0]?.title === 'A properly long headline about something', JSON.stringify(voted[0]?.title));

// C-8 finding on this change set: largest-linked-text alone picks the WRONG
// anchor whenever the headline is shorter than the row's own chrome, and the
// guid is the url, so the item's identity moves with it.
const SHORT_VS_CHROME = `<html><body><ol class="stories">
  <li class="story"><h2><a href="/p/go-124">Go 1.24</a></h2><a href="/s/1/comments">124 comments</a></li>
  <li class="story"><h2><a href="/p/rust">Rust 2.0</a></h2><a href="/s/2/comments">301 comments</a></li>
  <li class="story"><h2><a href="/p/zig">Zig</a></h2><a href="/s/3/comments">88 comments here</a></li>
</ol></body></html>`;
const shortRows = extractItems(SHORT_VS_CHROME, BASE, { item: '.story' });
check('a headline shorter than the comments link still wins', shortRows[0]?.url === 'https://news.example/p/go-124', String(shortRows[0]?.url));
check('  ... for every row, not just the first',
  shortRows.map((i) => i.url).join(',') === 'https://news.example/p/go-124,https://news.example/p/rust,https://news.example/p/zig',
  shortRows.map((i) => i.url).join(','));
const shortRule = suggestRules(SHORT_VS_CHROME, BASE)[0]?.rule;
check('the suggested rule STORES where the link is, rather than re-deriving it', shortRule?.link === 'h2 a', JSON.stringify(shortRule));

// Chrome-first rows with no heading (the link-aggregator shape): the wrapper class is
// what makes the choice storable.
const WRAPPED = `<html><body><ol class="stories">
  <li class="story"><a href="/v/1">128</a><span class="link"><a href="/p/one">Short</a></span><a href="/c/1">40 comments</a></li>
  <li class="story"><a href="/v/2">7</a><span class="link"><a href="/p/two">Also short</a></span><a href="/c/2">12 comments</a></li>
  <li class="story"><a href="/v/3">3</a><span class="link"><a href="/p/three">Brief</a></span><a href="/c/3">9 comments</a></li>
</ol></body></html>`;
const wrappedRule = suggestRules(WRAPPED, BASE)[0]?.rule;
check('a wrapper class is stored when there is no heading', wrappedRule?.link === '.link a', JSON.stringify(wrappedRule));
check('  ... and it extracts the articles, not the comment pages',
  extractItems(WRAPPED, BASE, wrappedRule ?? { item: 'nope' }).map((i) => i.url).join(',') ===
    'https://news.example/p/one,https://news.example/p/two,https://news.example/p/three',
  JSON.stringify(extractItems(WRAPPED, BASE, wrappedRule ?? { item: 'nope' }).map((i) => i.url)));

const MANY = `<html><body>${Array.from({ length: 150 }, (_, i) => `<div class="card"><a href="/i/${i}">Item number ${i}</a></div>`).join('')}</body></html>`;
check('extraction is capped at 100 items a page', extractItems(MANY, BASE, { item: '.card' }).length === 100,
  String(extractItems(MANY, BASE, { item: '.card' }).length));

// Same probe: ranking by item count alone put site navigation above the article
// list on two of five live pages.
const NAV_HEAVY = `<html><body>
  <nav><ul class="menu">
    <li class="mi"><a href="/a">About</a></li><li class="mi"><a href="/b">News</a></li>
    <li class="mi"><a href="/c">Cases</a></li><li class="mi"><a href="/d">Contact</a></li>
    <li class="mi"><a href="/e">Careers</a></li><li class="mi"><a href="/f">Library</a></li>
  </ul></nav>
  <main><div class="art"><h2><a href="/1">A full length article headline about the court</a></h2></div>
    <div class="art"><h2><a href="/2">Another full length headline about proceedings</a></h2></div>
    <div class="art"><h2><a href="/3">A third headline, also of a realistic length</a></h2></div></main>
</body></html>`;
const ranked = suggestRules(NAV_HEAVY, BASE);
check('the article list outranks the longer navigation menu', ranked[0]?.rule?.item === '.art',
  JSON.stringify(ranked.map((s) => `${s.rule.item}:${s.sample.length}`)));

// Findings from the C-8 round on this change set (16 August 2026): arbitrary
// HTML reached String.fromCodePoint and the recursive walks, and both threw
// rather than erroring. A throw in the poller's loop leaves the feed's row
// untouched, so it stalls silently for ever.
console.log('hostile input:');
const BOMB = `<html><body><div class="card"><h3><a href="/x">Out of range &#x110000; and &#4294967296;</a></h3></div>
<div class="card"><h3><a href="/y">Second &#xFFFFFFFF; item</a></h3></div></body></html>`;
let bombed;
try {
  bombed = extractItems(BOMB, BASE, RULE);
} catch (e) {
  bombed = e;
}
check('an out-of-range character reference does not throw', Array.isArray(bombed), String(bombed));
check('  ... and is left as text', /110000/.test(bombed?.[0]?.title ?? ''), JSON.stringify(bombed?.[0]?.title));

const UNCLOSED = `<html><body><main>${'<p>paragraph never closed '.repeat(6000)}</main>
<div class="card"><h3><a href="/z">Still found</a></h3></div></body></html>`;
let deep;
try {
  deep = extractItems(UNCLOSED, BASE, RULE);
} catch (e) {
  deep = e;
}
check('6,000 unclosed paragraphs do not overflow the stack', Array.isArray(deep), String(deep));
check('  ... and the real item is still extracted', deep?.[0]?.url === 'https://news.example/z', JSON.stringify(deep?.[0]?.url));

const NESTED_DEEP = '<html><body>' + '<div>'.repeat(9000) + 'x' + '</div>'.repeat(9000) + '</body></html>';
stub({ body: NESTED_DEEP });
const rDeep = await fetchScrape(BASE, RULE, 'W/"old"', null);
check('a pathologically nested page is an error, never a throw', rDeep.status === 'error', `${rDeep.status} ${rDeep.error ?? ''}`);
check('  ... and drops its validators like any other unusable body', rDeep.etag === null, String(rDeep.etag));

console.log('suggestRules:');
const suggestions = suggestRules(PAGE, BASE);
check('suggests at least one rule for a list page', suggestions.length >= 1, `got ${suggestions.length}`);
check('the best suggestion finds the three linked cards', suggestions[0]?.sample?.length === 3,
  `${suggestions[0]?.rule?.item} → ${suggestions[0]?.sample?.length}`);
check('the suggested rule survives a round trip through extractItems',
  extractItems(PAGE, BASE, suggestions[0]?.rule ?? { item: 'nope' }).length === 3,
  JSON.stringify(suggestions[0]?.rule));
check('suggests nothing for a page with no repeated linked block', suggestRules(NO_LIST, BASE).length === 0,
  JSON.stringify(suggestRules(NO_LIST, BASE).map((s) => s.rule)));

// Caught by the page harness on 16 August 2026: the first text floor was 15
// characters, which rejected an ordinary list of short headlines outright.
const SHORT_HEADLINES = `<html><body><main>
  <article class="post"><h2><a href="/n/1">Second</a></h2><time datetime="2026-08-09">9 Aug</time></article>
  <article class="post"><h2><a href="/n/2">Third</a></h2><time datetime="2026-08-08">8 Aug</time></article>
  <article class="post"><h2><a href="/n/3">Fourth</a></h2><time datetime="2026-08-07">7 Aug</time></article>
</main></body></html>`;
const shortSug = suggestRules(SHORT_HEADLINES, BASE);
check('a list of SHORT headlines is still suggested', shortSug[0]?.sample?.length === 3,
  `${shortSug.length} candidates: ${JSON.stringify(shortSug.map((s) => s.rule.item))}`);
check('  ... and its date selector is picked up', shortSug[0]?.sample?.[0]?.publishedAt?.startsWith('2026-08-09'),
  String(shortSug[0]?.sample?.[0]?.publishedAt));

console.log('parseRule:');
check('rejects a non-object', parseRule('"x"') === null);
check('rejects a rule with no item selector', parseRule('{"title":"h3"}') === null);
check('rejects a selector that is not a string', parseRule('{"item":3}') === null);
check('rejects an over-long selector', parseRule(JSON.stringify({ item: 'a'.repeat(300) })) === null);
check('rejects malformed JSON', parseRule('{item:') === null);
check('accepts a well-formed rule', parseRule(JSON.stringify(RULE))?.item === '.card', JSON.stringify(parseRule(JSON.stringify(RULE))));
check('drops unknown keys', parseRule('{"item":".card","evil":"x"}') && !('evil' in parseRule('{"item":".card","evil":"x"}')));

console.log('fetchScrape:');
function stub(res) {
  globalThis.fetch = async () => new Response(res.body ?? null, {
    status: res.status ?? 200,
    headers: { 'content-type': res.ct ?? 'text/html; charset=utf-8', ...(res.headers ?? {}) },
  });
}

stub({ body: PAGE, headers: { etag: 'W/"p1"', 'last-modified': 'Mon, 04 Aug 2026 10:00:00 GMT' } });
let r = await fetchScrape(BASE, RULE, null, null);
check('a scrapeable page is ok with items', r.status === 'ok' && r.items.length === 3, `${r.status} ${r.items?.length} ${r.error ?? ''}`);
check('  ... keeps the etag', r.etag === 'W/"p1"', String(r.etag));
check('  ... keeps last-modified', r.lastModified === 'Mon, 04 Aug 2026 10:00:00 GMT', String(r.lastModified));
check('  ... adopts the page title', r.feedTitle === 'Analysis & Comment', JSON.stringify(r.feedTitle));
check('  ... reports the site origin', r.siteUrl === 'https://news.example', String(r.siteUrl));

stub({ status: 304 });
r = await fetchScrape(BASE, RULE, 'W/"p1"', null);
check('a 304 is not-modified and keeps its validators', r.status === 'not-modified' && r.etag === 'W/"p1"', `${r.status} ${r.etag}`);

stub({ status: 403, body: 'no' });
r = await fetchScrape(BASE, RULE, null, null);
check('a 403 is an error', r.status === 'error' && /403/.test(r.error ?? ''), `${r.status} ${r.error ?? ''}`);

stub({ body: '{"items":[]}', ct: 'application/json' });
r = await fetchScrape(BASE, RULE, 'W/"old"', 'Mon, 01 Jan 2020 00:00:00 GMT');
check('a non-HTML body is an error', r.status === 'error' && /not an HTML page/i.test(r.error ?? ''), `${r.status} ${r.error ?? ''}`);
check('  ... drops the stored validators', r.etag === null && r.lastModified === null, `${r.etag} ${r.lastModified}`);

stub({ body: NO_LIST, headers: { etag: 'W/"n"' } });
r = await fetchScrape(BASE, RULE, 'W/"old"', null);
check('a page the rule no longer matches is an error', r.status === 'error' && /matched nothing/i.test(r.error ?? ''), `${r.status} ${r.error ?? ''}`);
check('  ... drops the stored validators so 304 cannot hide it', r.etag === null && r.lastModified === null, `${r.etag} ${r.lastModified}`);

// Response.text() is UTF-8 whatever the page declares, so a legacy encoding
// silently mojibakes every title it produces. Bytes below are windows-1252.
const LATIN1 = new Uint8Array([
  ...[...'<html><body><div class="card"><h3><a href="/c">Caf'].map((c) => c.charCodeAt(0)),
  0xe9, // é in windows-1252
  ...[...' de la Paix</a></h3></div></body></html>'].map((c) => c.charCodeAt(0)),
]);
globalThis.fetch = async () => new Response(LATIN1, { headers: { 'content-type': 'text/html; charset=windows-1252' } });
const latin = await fetchScrape(BASE, { item: '.card', title: 'h3' }, null, null);
check('a windows-1252 page is decoded, not mojibaked', latin.items?.[0]?.title === 'Café de la Paix', JSON.stringify(latin.items?.[0]?.title));

globalThis.fetch = async () => new Response(null, { status: 200, headers: { 'content-type': 'text/html', 'content-length': '9000000' } });
const big = await fetchScrape(BASE, RULE, null, null);
check('an oversized page is refused before it is read', big.status === 'error' && /scrape limit/.test(big.error ?? ''), `${big.status} ${big.error ?? ''}`);

globalThis.fetch = async () => { throw new Error('boom'); };
r = await fetchScrape(BASE, RULE, null, null);
check('a network failure is an error, not a throw', r.status === 'error' && /Network error/.test(r.error ?? ''), `${r.status} ${r.error ?? ''}`);

// Seeded fuzz. The fixtures above cover the failures we know about; this covers
// the ones we do not, which is the whole reason a hand-rolled parser is a risk.
// Deterministic on purpose: a failure here is reproducible from the seed, not a
// flaky gate. A run of 4,000 documents found nothing on 16 August 2026 and took
// 0.31s, so 500 is a cheap standing guard rather than a search.
console.log('fuzz (seeded, 500 documents):');
let seed = 20260816;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const PIECES = [
  '<div class="card">', '</div>', '<a href="/x">', '</a>', '<h3>', '</h3>', '<p class="dek">', '</p>',
  '<script>', '</script>', '<!--', '-->', '<time datetime="2026-01-01">', '</time>', '<li>', '<p>', '<tr>', '<td>',
  '&amp;', '&#x110000;', '&#0;', '&nbsp;', '&', '<', '>', '"', "'", '/>', '<br>', '<svg><path d="M0 0"/>',
  '<![CDATA[x]]>', '<a href="javascript:x()">', '<a href="//evil/">', 'text ', ' ', '�', '<a>',
  '<div class="', '" data-x="a > b" ', '<A HREF=/y>', '</SCRIPT>', '<table>', '<option>', '<dd>', '<template>',
];
const FUZZ_RULES = [
  { item: '.card', title: 'h3', link: 'a', date: 'time', summary: '.dek' },
  { item: 'li' },
  { item: 'div a' },
  { item: '[data-x]' },
];
let thrown = null;
let slowest = 0;
for (let i = 0; i < 500 && !thrown; i++) {
  let doc = '';
  for (let j = 0, n = 3 + Math.floor(rnd() * 120); j < n; j++) doc += pick(PIECES);
  const t0 = performance.now();
  try {
    extractItems(doc, BASE, pick(FUZZ_RULES));
    if (i % 4 === 0) suggestRules(doc, BASE);
    parseRule(doc.slice(0, 50));
  } catch (err) {
    thrown = { i, err, doc: doc.slice(0, 200) };
  }
  slowest = Math.max(slowest, performance.now() - t0);
}
check('500 fuzzed documents produce no throw', !thrown,
  thrown ? `document ${thrown.i}: ${thrown.err}\n        ${JSON.stringify(thrown.doc)}` : '');
console.log(`        (slowest document ${slowest.toFixed(1)}ms)`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
