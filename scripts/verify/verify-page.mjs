/**
 * Functional smoke test for the /rss page itself. The other two harnesses cover
 * the poller and feed.ts; nothing covered the rendered page, which is where the
 * sidebar, the pull clock and the auto-refresh contract live. This drives the
 * real `onRequestGet` against a fake D1 with the Access guard stubbed, so the
 * HTML asserted here is the HTML the browser gets.
 *
 * Run:  node scripts/verify/verify-page.mjs "$PWD" /tmp
 */
import { pathToFileURL } from 'node:url';

const REPO = process.argv[2];
const TMP = process.argv[3];
const { build } = await import(pathToFileURL(`${REPO}/node_modules/esbuild/lib/main.js`).href);

/** Replace the Cloudflare Access guard with an always-owner stub. */
const stubAuth = {
  name: 'stub-auth',
  setup(b) {
    b.onResolve({ filter: /_auth$/ }, () => ({ path: 'auth', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const requireOwner = async () => ({ ok: true, email: "owner@example.com", dev: false });',
      loader: 'js',
    }));
  },
};

const bundle = async (entry, name) => {
  const out = `${TMP}/${name}-verify-bundle.mjs`;
  await build({
    entryPoints: [`${REPO}/${entry}`],
    bundle: true, format: 'esm', platform: 'node', absWorkingDir: REPO, outfile: out,
    logLevel: 'error', plugins: [stubAuth],
  });
  return import(pathToFileURL(out).href);
};

const FEEDS = [
  { id: 1, title: 'Example News', feed_url: 'https://news.example/feed', site_url: 'https://news.example', folder: 'General News', last_status: 'ok', last_error: null },
  { id: 2, title: 'Example Review', feed_url: 'https://review.example/feed', site_url: null, folder: 'General News', last_status: 'ok', last_error: null },
  { id: 3, title: 'Example Journal', feed_url: 'https://journal.example/feed', site_url: null, folder: 'Specialist', last_status: 'error', last_error: 'HTTP 403' },
  { id: 4, title: 'Loose feed', feed_url: 'https://loose.example/feed', site_url: null, folder: null, last_status: null, last_error: null },
];
const ITEM = {
  id: 90, feed_id: 1, url: 'https://news.example/p1', title: 'A headline', author: null,
  summary: 'Some summary text.', content: null, published_at: '2026-07-26 08:00:00',
  fetched_at: '2026-07-26 08:05:00', is_read: 0, is_starred: 0,
  feed_title: 'Example News', feed_site: 'https://news.example',
};

const queries = []; // every statement the page prepares, so SQL can be asserted too

/** `pollRuns: false` simulates an unmigrated database, where the read throws. */
function fakeDb({ pollRuns = true } = {}) {
  const rows = (q) => {
    if (/FROM feeds ORDER BY LOWER\(title\)/i.test(q)) return FEEDS;
    if (/COUNT\(\*\) AS n FROM items WHERE is_read = 0 GROUP BY/i.test(q))
      return [{ feed_id: 1, n: 249 }, { feed_id: 2, n: 68 }, { feed_id: 3, n: 1400 }];
    if (/FROM poll_runs/i.test(q)) {
      if (!pollRuns) throw new Error('no such table: poll_runs');
      return [{ id: 42, started_at: '2026-07-26 08:00:00', finished_at: '2026-07-26 08:03:00' }];
    }
    // Only feed 3 holds anything, and it is the erroring one. That leaves feeds
    // 1 and 2 healthy-but-empty (silent) and feed 4 never polled (new, not
    // silent), which is the distinction the manage view has to get right.
    if (/SELECT feed_id, COUNT\(\*\) AS n FROM items GROUP BY feed_id/i.test(q)) return [{ feed_id: 3, n: 1 }];
    if (/COUNT\(\*\) AS n FROM items/i.test(q)) return [{ n: 1 }];
    if (/FROM items JOIN feeds|FROM items_fts/i.test(q)) return [ITEM];
    return [];
  };
  const stmt = (q) => {
    queries.push(q);
    const self = {
      bind: () => self,
      run: async () => ({ meta: { changes: 1 } }),
      all: async () => ({ results: rows(q) }),
      first: async () => rows(q)[0] ?? null,
    };
    return self;
  };
  return { prepare: stmt };
}

const env = { READER_DB: fakeDb(), CF_ACCESS_AUD: 'aud' };
const page = await bundle('functions/rss/index.ts', 'page');
const status = await bundle('functions/api/reader/status.ts', 'status');

const get = async (url, e = env) => {
  const res = await page.onRequestGet({ request: new Request(url), env: e });
  return { res, html: await res.text() };
};

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}  ${detail ?? ''}`); }
};

console.log('page shell:');
const base = await get('https://x.dev/rss');
check('renders 200', base.res.status === 200, String(base.res.status));
check('CSP allows the status probe', /connect-src 'self'/.test(base.res.headers.get('content-security-policy') ?? ''),
  base.res.headers.get('content-security-policy') ?? '');
check('CSP still forbids remote images', /img-src data:;/.test(base.res.headers.get('content-security-policy') ?? ''),
  'img-src widened');

console.log('sidebar:');
check('the feed list is its own scroller', /class="side-scroll"/.test(base.html) && /\.side-scroll \{[^}]*overflow-y:auto/.test(base.html),
  'no scrolling region');
check('views, label and manage link sit outside it', /class="side-views"/.test(base.html) && /class="side-foot"/.test(base.html));
check('the sidebar carries a resize grip', /class="side-grip" role="separator" aria-orientation="vertical" tabindex="0"/.test(base.html));
check('its width is a variable the grip can drive',
  /\.layout \{[^}]*grid-template-columns:clamp\(9\.5rem, var\(--side-w, 15\.5rem\), 40vw\)/.test(base.html));
check('the grip is absent where there is one column',
  /\.side-grip \{ display:none; \}/.test(base.html) && !/@media \(max-width:52rem\)[\s\S]{0,1400}\.side-grip \{ display:block/.test(base.html));
check('folders are collapsed by default',
  /<div class="fgroup" data-folder="Specialist">\s*<input type="checkbox" class="fg-toggle" id="fg\d+"\s+aria-label/.test(base.html),
  'a folder rendered checked');
check('the arrow toggles and the name navigates (two targets, not one)',
  /<label class="fg-arrow" for="fg\d+"><\/label>\s*<a class="foldername" href="[^"]*folder=General\+News"/.test(base.html),
  'arrow and name are not separate controls');
check('the collapse needs no script', /\.fg-toggle:checked ~ \.fbody \{ display:flex/.test(base.html));
check('the redundant "All in this folder" row is gone', !/frow fall/.test(base.html));
check('feeds are nested behind a rail', /class="fbody">/.test(base.html) && /\.fbody \{[^}]*border-left/.test(base.html));
check('ungrouped feeds render flat', /class="fbody flat"/.test(base.html));
check('folder and feed rows are different tiers',
  /\.foldername \{[^}]*\.89rem/.test(base.html) && /\.frow \{[^}]*\.83rem/.test(base.html), 'type sizes not distinct');
check('unread counts render, 4-figure ones clamped', /class="ct">249</.test(base.html) && /class="ct">999\+</.test(base.html));
check('an errored feed still shows its dot', /class="dot err"/.test(base.html));

console.log('only the arrow opens a folder:');
const checkedIn = (html, folder) => {
  const m = html.match(new RegExp(`data-folder="${folder}">\\s*<input([^>]*)>`));
  return m ? / checked/.test(m[1]) : null;
};
const byFeed = await get('https://x.dev/rss?feed=2');
const byFolder = await get('https://x.dev/rss?folder=Specialist');
check('filtering by a folder does NOT expand it', checkedIn(byFolder.html, 'Specialist') === false,
  'clicking the folder name opened the dropdown');
check('the folder is still marked active', /<div class="folder on">/.test(byFolder.html), 'no active marking');
check('opening a feed does not expand its folder either', checkedIn(byFeed.html, 'General News') === false);
check('no folder is ever checked server-side',
  !/class="fg-toggle"[^>]*checked/.test(base.html + byFeed.html + byFolder.html), 'a folder rendered pre-checked');

console.log('in-place actions:');
check('each row names its item and feed so the script can act on it',
  /<article class="item[^"]*" id="item-90" data-feed="1"/.test(base.html), 'no row identity');
check('the row actions are intercepted rather than posted',
  /form\.matches\('form\[data-do\]'\)/.test(base.html) && /e\.preventDefault\(\)/.test(base.html));
check('the request does not re-download the list', /redirect: 'manual'/.test(base.html));
check('the in-place request marks itself, so the endpoint can answer 204',
  /'X-Reader-Action': '1'/.test(base.html), 'the endpoint cannot tell it apart from a form post');
// Anchored on the accept path itself, not on the word 'opaqueredirect', which
// also appears in the comment explaining why this rule exists: a probe that a
// comment can fail is testing vocabulary rather than behaviour.
check('only a 204 counts as success, never a redirect',
  /if \(r\.status === 204\) return;/.test(base.html) && !/r\.type/.test(base.html),
  'a lapsed Access session would read as a write that never happened');
check('a failed request puts the row back and falls through to the form',
  /undo\(\); form\.submit\(\);/.test(base.html), 'a failure would be silent');
check('toolbar forms are left alone', /if \(!card\) return;/.test(base.html));
check('a clamped sidebar count is not guessed at', /indexOf\('\+'\) !== -1/.test(base.html));
// The script is emitted from a template literal, where a stray escape silently
// becomes a different character. Parse what actually ships.
const inlineJs = (base.html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/) ?? [])[1] ?? '';
let jsOk = true, jsErr = '';
try { new Function(inlineJs); } catch (e) { jsOk = false; jsErr = String(e.message).slice(0, 90); }
check('the inline script actually parses', jsOk, jsErr);
check('scroll is stashed per list URL and restored', /rss\.scroll/.test(base.html) && /pagehide/.test(base.html));

console.log('folder header:');
check('a folder view names the folder at the top',
  /class="feedhead folderhead"[\s\S]{0,300}class="fh-name">Specialist</.test(byFolder.html),
  'folder view has no header');
check('and states what it holds', /class="fh-key">Holds<\/span><span>1 feed · 1400 unread items</.test(byFolder.html),
  'no counts, or the wrong ones');
check('the header uses the true count, not the sidebar\'s 999+ clamp', !/Holds<\/span><span>[^<]*999\+/.test(byFolder.html));
check('flagging erroring feeds inside it', /class="fh-badge err">1 feed erroring</.test(byFolder.html));
// "folderhead" also appears in the inline stylesheet, so match the markup itself.
check('a single-feed view still gets the feed header, not the folder one',
  /class="feedhead"/.test(byFeed.html) && !/class="feedhead folderhead"/.test(byFeed.html));

console.log('feed header:');
check('opening a feed shows its feed URL', /class="fh-url"[\s\S]{0,200}https:\/\/review\.example\/feed/.test(byFeed.html),
  'no feed URL in the header');
const byErrFeed = await get('https://x.dev/rss?feed=3');
check('an errored feed shows why, at the top', /class="fh-badge err">error: HTTP 403</.test(byErrFeed.html));
check('the excerpt no longer caps its measure', !/\.iexc \{[^}]*max-width:58ch/.test(base.html));
check('the reading measure is kept', /\.rbody p \{[^}]*max-width:64ch/.test(base.html));

console.log('sidebar expand/collapse all:');
check('the control is present', /class="side-all" data-role="all" hidden/.test(base.html));
check('it is hidden until script un-hides it', /\.side-all\[hidden\] \{ display:none; \}/.test(base.html),
  'a dead control would show with script off');

console.log('delete from the feed page:');
check('the feed page offers a delete', /class="fh-del"/.test(byFeed.html));
check('it takes two steps, not one', /<details class="fh-del">\s*<summary>Delete feed<\/summary>/.test(byFeed.html));
check('it returns to /rss, not to the deleted feed',
  /name="do" value="delete-feed"[\s\S]{0,200}name="return" value="\/rss"/.test(byFeed.html));

console.log('manage feeds:');
const manage = await get('https://x.dev/rss?manage=1');
check('renders', manage.res.status === 200 && /class="manage"/.test(manage.html));
check('counts the feeds', /<span class="mt-n">4<\/span> feeds/.test(manage.html), 'wrong feed total');
check('counts the folders', /<span class="mt-n">2<\/span> folders/.test(manage.html), 'wrong folder total');
check('counts the errors', /<span class="mt-n">1<\/span> erroring/.test(manage.html), 'wrong error total');
check('lists the failing feeds up top', /class="merrs"[\s\S]*?class="merr-name" href="#feed-3">Example Journal/.test(manage.html));
check('shows the error note, not just "error"', /class="merr-why">HTTP 403</.test(manage.html));
check('shows the feed URL beside each error', /class="merr-url">https:\/\/journal\.example\/feed</.test(manage.html));
check('offers a delete beside each error',
  /class="merr-del"[\s\S]{0,260}name="feed_id" value="3"[\s\S]{0,160}class="danger">Delete/.test(manage.html),
  'no delete in the error list');
check('repeats the note on the row itself', /class="merr">HTTP 403<\/div>/.test(manage.html),
  'the note lives only in a tooltip');
check('groups feeds under folder headings',
  /class="mgroup-head">Specialist/.test(manage.html) && /class="mgroup-head">General News/.test(manage.html));
check('ungrouped feeds get their own section, last',
  manage.html.indexOf('mgroup-head">Ungrouped') > manage.html.indexOf('mgroup-head">General News'));
check('a folder heading carries its own error count', /class="mgroup-n bad">1 erroring/.test(manage.html));
check('every row shows how many items it holds', /class="mitems none">0 items/.test(manage.html) && /class="mitems">1 item</.test(manage.html));
check('silent feeds are counted', /<span class="mt-n">2<\/span> silent/.test(manage.html), 'wrong silent total');
check('and gathered into their own panel', /class="merrs quiet"[\s\S]*?Silent feeds/.test(manage.html));
check('silent is not dressed as an error', /\.merrs\.quiet \{ border-color:var\(--brass\)/.test(manage.html));
const silentPanel = (manage.html.split('Silent feeds')[1] ?? '').split('</div>')[0] + (manage.html.split('Silent feeds')[1] ?? '').slice(0, 900);
check('the silent panel names the healthy-but-empty feeds',
  /Example News/.test(silentPanel) && /Example Review/.test(silentPanel));
check('a never-polled feed is new, not silent', !/Loose feed/.test(silentPanel),
  'an unpolled feed was reported silent');
check('an erroring feed is not double-counted as silent', !/Example Journal/.test(silentPanel));
// A broad outage must not bury the page, and what is cut must be stated.
const many = Array.from({ length: 40 }, (_, i) => ({
  id: 500 + i, title: `Quiet ${i}`, feed_url: `https://q${i}.example/feed`, site_url: null,
  folder: 'Bulk', last_status: 'ok', last_error: null,
}));
const bulk = await get('https://x.dev/rss?manage=1', {
  READER_DB: (() => { const db = fakeDb(); const inner = db.prepare;
    return { prepare: (q) => /FROM feeds ORDER BY LOWER\(title\)/i.test(q)
      ? { bind: () => ({}), all: async () => ({ results: many }), first: async () => many[0] }
      : inner(q) }; })(),
  CF_ACCESS_AUD: 'aud',
});
check('a long panel is capped', (bulk.html.match(/class="merr-row"/g) ?? []).length <= 25,
  String((bulk.html.match(/class="merr-row"/g) ?? []).length));
check('and says what it cut', /class="merr-more">and 15 more, listed in their folders below/.test(bulk.html),
  'the cap is silent');

console.log('pull clock:');
check('the bar renders', /class="pollbar"/.test(base.html));
check('it carries the run id', /data-poll="42"/.test(base.html));
check('offsets are seconds, not timestamps', /data-ago="\d+"/.test(base.html) && /data-next="\d+"/.test(base.html));
check('the cadence is published to the script', /data-interval="1200"/.test(base.html));
check('the unread baseline is published', /data-unread="1717"/.test(base.html));
check('a countdown is rendered without script', /data-role="next">≈ \d+:\d\d</.test(base.html));
check('the new-items badge starts hidden', /class="pb-new" data-role="new" hidden/.test(base.html));
const noRuns = await get('https://x.dev/rss', { READER_DB: fakeDb({ pollRuns: false }), CF_ACCESS_AUD: 'aud' });
check('an unmigrated database degrades, it does not 500', noRuns.res.status === 200 && /no pull recorded/.test(noRuns.html),
  String(noRuns.res.status));

console.log('responsive:');
check('sidebar folds into a disclosure below 52rem',
  /@media \(max-width:52rem\)[\s\S]{0,1400}\.side-toggle:checked ~ \.side-inner \{ display:flex/.test(base.html));
check('the disclosure is neutralised above it', /\.side-summary \{ display:none; \}/.test(base.html));
check('a phone pass exists', /@media \(max-width:34rem\)/.test(base.html));
check('reading type is fluid', /\.rbody \{ font:clamp\(/.test(base.html) && /\.rtitle \{ font:500 clamp\(/.test(base.html));
check('long strings cannot blow out a narrow column', (base.html.match(/overflow-wrap:break-word/g) ?? []).length >= 4);

console.log('reading view:');
const reading = await get('https://x.dev/rss?item=90');
check('renders the article', reading.res.status === 200 && /class="reading"/.test(reading.html));
check('the clock is present there too', /class="pollbar"/.test(reading.html));

console.log('status endpoint:');
const s1 = await status.onRequestGet({ request: new Request('https://x.dev/api/reader/status'), env });
const b1 = await s1.json();
check('answers JSON', s1.status === 200 && /application\/json/.test(s1.headers.get('content-type') ?? ''), String(s1.status));
check('reports the newest run', b1.poll === 42, JSON.stringify(b1));
check('reports the unread total', b1.unread === 1, JSON.stringify(b1));
check('is never cached', s1.headers.get('cache-control') === 'no-store', s1.headers.get('cache-control') ?? '');
const s2 = await status.onRequestGet({
  request: new Request('https://x.dev/api/reader/status'),
  env: { READER_DB: fakeDb({ pollRuns: false }), CF_ACCESS_AUD: 'aud' },
});
const b2 = await s2.json();
check('a missing poll_runs degrades to poll:null', s2.status === 200 && b2.poll === null, JSON.stringify(b2));

console.log('item ordering:');
check('the list query breaks ties on id, so a dateless batch has one order',
  queries.some((q) => /ORDER BY COALESCE\(items\.published_at, items\.fetched_at\) DESC, items\.id DESC/.test(q)),
  'no id tiebreak in the list query');

console.log('add form:');
check('the Add form carries both submits', /name="do" value="add-feed"/.test(base.html) && /name="do" value="scrape-preview"/.test(base.html),
  'a submit is missing');
check('Add comes first, so Enter still adds',
  base.html.indexOf('value="add-feed"') < base.html.indexOf('value="scrape-preview"'), 'From page precedes Add');
const addForm = base.html.slice(base.html.indexOf('class="tb-add"'), base.html.indexOf('</form>', base.html.indexOf('class="tb-add"')));
check('the hidden do field is gone, or it would win over the button',
  !/<input type="hidden" name="do"/.test(addForm), 'a hidden do field survives in the add form');
check('  ... including between the two submits, where it would silently convert one to the other',
  addForm.length > 700 && !/value="add-feed"[\s\S]*<input type="hidden" name="do"[\s\S]*value="scrape-preview"/.test(addForm),
  `form is ${addForm.length} chars; the old guard only read 700`);
check('From page says what it does', /title="Build a feed from the page's own list/.test(base.html), 'no title on the alt submit');

console.log('scrape preview:');
const LIST_PAGE = `<html><head><title>Notes &amp; Comment</title></head><body><main>
  <article class="post"><h2><a href="/n/1">First &amp; last</a></h2><time datetime="2026-08-10">10 Aug</time></article>
  <article class="post"><h2><a href="/n/2">Second</a></h2><time datetime="2026-08-09">9 Aug</time></article>
  <article class="post"><h2><a href="/n/3">Third</a></h2><time datetime="2026-08-08">8 Aug</time></article>
</main></body></html>`;
const FLAT_PAGE = '<html><head><title>About</title></head><body><h1>About</h1><p>Nothing listable here.</p></body></html>';

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('flat.example')) return new Response(FLAT_PAGE, { headers: { 'content-type': 'text/html' } });
  if (u.includes('dead.example')) return new Response('nope', { status: 403, headers: { 'content-type': 'text/html' } });
  return new Response(LIST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
};

const sp = await get('https://x.dev/rss?scrape=' + encodeURIComponent('https://page.example/notes') + '&view=unread');
check('the panel renders for a page with no feed', /class="scrape-panel"/.test(sp.html), 'no panel');
check('it names the selector it would use', /class="sp-sel">\.post</.test(sp.html), 'no selector shown');
check('it shows the page\'s own headlines as a sample', /First &amp; last/.test(sp.html), 'no sample rendered');
check('the sample is escaped, not injected', !/<h2><a href="\/n\/1">/.test(sp.html), 'raw page markup reached the document');
check('each candidate is a form that stores nothing until submitted',
  /name="do" value="add-scrape"/.test(sp.html) && /name="rule" value="\{&quot;item&quot;/.test(sp.html), 'no add-scrape form');
check('the return path drops the one-shot parameters',
  /name="return" value="\/rss\?view=unread"/.test(sp.html), (sp.html.match(/name="return" value="[^"]*"/g) ?? []).slice(-1)[0] ?? '');
check('the CSP is unchanged by the panel', /img-src data:;/.test(sp.res.headers.get('content-security-policy') ?? ''), 'img-src widened');

const flat = await get('https://x.dev/rss?scrape=' + encodeURIComponent('https://flat.example/about'));
check('a page with no list says so and stores nothing',
  /nothing on the page reads as a list/.test(flat.html) && !/class="sp-card"/.test(flat.html), 'offered a rule anyway');

const dead = await get('https://x.dev/rss?scrape=' + encodeURIComponent('https://dead.example/x'));
check('an unfetchable page reports the HTTP status', /answered HTTP 403/.test(dead.html), 'no honest failure');

const notUrl = await get('https://x.dev/rss?scrape=' + encodeURIComponent('javascript:alert(1)'));
check('a non-http scrape target is ignored entirely', !/class="scrape-panel"/.test(notUrl.html), 'panel rendered for a non-http target');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
