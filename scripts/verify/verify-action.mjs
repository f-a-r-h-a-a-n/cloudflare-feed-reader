/**
 * Functional smoke test for the reader's one mutation endpoint,
 * functions/api/reader/action.ts. It had no harness until scrape-to-feed gave it
 * a path that stores a rule taken from a form, so this covers the write side:
 * what is refused, what is stored, and what the redirect says afterwards.
 *
 * Run:  node scripts/verify/verify-action.mjs "$PWD" /tmp
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

const out = `${TMP}/action-verify-bundle.mjs`;
await build({
  entryPoints: [`${REPO}/functions/api/reader/action.ts`],
  bundle: true, format: 'esm', platform: 'node', absWorkingDir: REPO, outfile: out,
  logLevel: 'error', plugins: [stubAuth],
});
const mod = await import(pathToFileURL(out).href);

const LIST = `<html><head><title>Notes</title></head><body><main>
  <div class="card"><h3><a href="/n/1">A headline of realistic length</a></h3></div>
  <div class="card"><h3><a href="/n/2">A second headline, also long</a></h3></div>
  <div class="card"><h3><a href="/n/3">And a third one for good measure</a></h3></div>
</main></body></html>`;

let inserts = [];
let fetched = [];
let existing = null; // row returned by the 'already subscribed' lookup

function fakeDb() {
  const stmt = (q) => {
    let binds = [];
    const self = {
      bind: (...a) => { binds = a; return self; },
      run: async () => {
        if (/INSERT OR IGNORE INTO feeds/i.test(q)) {
          inserts.push({ q, binds });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 1 } };
      },
      all: async () => ({ results: [] }),
      first: async () => (/SELECT id, title, folder FROM feeds WHERE feed_url/i.test(q) ? existing : null),
    };
    return self;
  };
  return { prepare: stmt };
}

globalThis.fetch = async (url) => {
  const u = String(url);
  fetched.push(u);
  if (u.includes('nothing.example')) return new Response('<html><body><p>no list here</p></body></html>', { headers: { 'content-type': 'text/html' } });
  return new Response(LIST, { headers: { 'content-type': 'text/html; charset=utf-8' } });
};

const post = async (fields, headers) => {
  inserts = [];
  fetched = [];
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await mod.onRequestPost({
    request: new Request('https://x.dev/api/reader/action', { method: 'POST', body: form, headers }),
    env: { READER_DB: fakeDb(), CF_ACCESS_AUD: 'aud' },
  });
  return { res, location: new URL(res.headers.get('location') ?? 'https://x.dev/rss') };
};

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}  ${detail ?? ''}`); }
};

const RULE = JSON.stringify({ item: '.card', title: 'h3' });

console.log('add-feed falling through to a scrape:');
const fell = await post({ do: 'add-feed', url: 'https://page.example/notes', return: '/rss?view=unread' });
check('a page with no feed still 303s', fell.res.status === 303, String(fell.res.status));
check('  ... and hands the URL to the scrape preview',
  fell.location.searchParams.get('scrape') === 'https://page.example/notes', fell.location.search);
check('  ... while saying what discovery found', /No RSS, Atom or JSON feed/.test(fell.location.searchParams.get('err') ?? ''),
  fell.location.searchParams.get('err') ?? '');
check('  ... and stores nothing', inserts.length === 0, JSON.stringify(inserts));

console.log('scrape-preview (the Add form\'s "From page"):');
const forced = await post({ do: 'scrape-preview', url: 'https://stale-feed.example', return: '/rss?view=unread' });
check('it skips discovery entirely', fetched.length === 0, `${fetched.length} fetches`);
check('  ... hands the URL to the preview', forced.location.searchParams.get('scrape') === 'https://stale-feed.example',
  forced.location.search);
check('  ... keeps the list you were on', forced.location.pathname + forced.location.search.split('&')[0] === '/rss?view=unread',
  forced.location.pathname + forced.location.search);
check('  ... and stores nothing', inserts.length === 0, JSON.stringify(inserts));
check('  ... and marks the route, so the panel does not claim there is no feed',
  forced.location.searchParams.get('via') === 'page', forced.location.search);

const forcedBad = await post({ do: 'scrape-preview', url: 'not-a-url', return: '/rss' });
check('a non-http target is refused', !forcedBad.location.searchParams.get('scrape') && /full http/.test(forcedBad.location.searchParams.get('err') ?? ''),
  forcedBad.location.search);

console.log('add-scrape:');
const ok = await post({ do: 'add-scrape', url: 'https://page.example/notes', rule: RULE, folder: 'Reading', return: '/rss' });
check('a working rule stores one feed', inserts.length === 1, JSON.stringify(inserts.map((i) => i.binds)));
check('  ... marked as a scrape, with the rule alongside it',
  inserts[0]?.binds[4] === RULE && /kind, scrape_rule/.test(inserts[0]?.q ?? ''), JSON.stringify(inserts[0]?.binds));
check('  ... taking its title from the page', inserts[0]?.binds[2] === 'Notes', JSON.stringify(inserts[0]?.binds[2]));
check('  ... and its folder from the form', inserts[0]?.binds[3] === 'Reading', JSON.stringify(inserts[0]?.binds[3]));
check('  ... reporting what was added', /Notes/.test(ok.location.searchParams.get('added') ?? ''), ok.location.search);

const nomatch = await post({ do: 'add-scrape', url: 'https://nothing.example/page', rule: RULE, return: '/rss' });
check('a rule that matches nothing is refused at the door', inserts.length === 0, JSON.stringify(inserts));
check('  ... and says why', /matched nothing/.test(nomatch.location.searchParams.get('err') ?? ''),
  nomatch.location.searchParams.get('err') ?? '');

const badRule = await post({ do: 'add-scrape', url: 'https://page.example/notes', rule: '{oops', return: '/rss' });
check('an unreadable rule is refused without fetching', inserts.length === 0 && fetched.length === 0,
  `${inserts.length} inserts, ${fetched.length} fetches`);
check('  ... and says so', /could not be read/.test(badRule.location.searchParams.get('err') ?? ''),
  badRule.location.searchParams.get('err') ?? '');

const evilRule = await post({ do: 'add-scrape', url: 'https://page.example/notes', rule: JSON.stringify({ item: '.card', evil: 'x' }), return: '/rss' });
check('an unknown key is dropped rather than stored',
  inserts.length === 1 && !/evil/.test(inserts[0]?.binds[4] ?? ''), JSON.stringify(inserts[0]?.binds[4]));

const notHttp = await post({ do: 'add-scrape', url: 'javascript:alert(1)', rule: RULE, return: '/rss' });
check('a non-http target is refused without fetching', inserts.length === 0 && fetched.length === 0,
  `${inserts.length} inserts, ${fetched.length} fetches`);
check('  ... and says so', /full http/.test(notHttp.location.searchParams.get('err') ?? ''),
  notHttp.location.searchParams.get('err') ?? '');

existing = { id: 9, title: 'Already there', folder: 'Reading' };
const dup = await post({ do: 'add-scrape', url: 'https://page.example/notes', rule: RULE, return: '/rss' });
check('a page already subscribed is not re-added, or re-fetched',
  inserts.length === 0 && fetched.length === 0, `${inserts.length} inserts, ${fetched.length} fetches`);
check('  ... and names where it already sits', /Already there \(in Reading\)/.test(dup.location.searchParams.get('msg') ?? ''),
  dup.location.searchParams.get('msg') ?? '');
existing = null;

// The in-place path's success signal must be one Cloudflare Access cannot
// imitate. Access intercepts before this Function and answers 302, which to a
// fetch using redirect:'manual' is the same opaque response as the endpoint's
// own 303, so a redirect-shaped success test reads a lapsed session as a write
// that happened. Both directions are pinned here: the marked request gets 204,
// and the unmarked one still gets its 303 so the no-script path is unchanged.
console.log('the in-place success signal:');
const inPlaceRead = await post({ do: 'mark-read', item_id: '90', state: '1' }, { 'X-Reader-Action': '1' });
check('a marked mark-read answers 204, not a redirect', inPlaceRead.res.status === 204,
  String(inPlaceRead.res.status));
check('  ... and carries no Location for a client to mistake for success',
  !inPlaceRead.res.headers.get('location'), 'a 204 with a Location');
const plainRead = await post({ do: 'mark-read', item_id: '90', state: '1' });
check('  ... while an unmarked post still 303s, leaving the no-script path alone',
  plainRead.res.status === 303, String(plainRead.res.status));
const inPlaceStar = await post({ do: 'star', item_id: '90', state: '1' }, { 'X-Reader-Action': '1' });
check('star answers the same way', inPlaceStar.res.status === 204, String(inPlaceStar.res.status));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
