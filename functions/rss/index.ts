/**
 * GET /rss — the owner's private feed reader.
 *
 * A serif reading surface wrapped in a monospace instrument panel, behind the
 * same Cloudflare Access owner gate as /studio (requireOwner). The companion
 * feed-poller Worker fills READER_DB on a cron; this page reads it, plus small
 * POST forms to /api/reader/action for mutations.
 *
 * Progressive enhancement: everything works with no JavaScript (links + <form
 * method=post>). One small first-party keyboard layer is added inline under a
 * per-request CSP nonce (script-src 'nonce-…'), so injected scripts stay blocked
 * and no third-party origin is trusted. Feed-supplied strings are tag-stripped
 * then HTML-escaped; the reading view additionally keeps safe http(s) links.
 * Remote images are never rendered.
 */
import type { Env } from '../_lib';
import { requireOwner } from '../_auth';
import { youtubeVideoId } from '../_shared/youtube';
import { fetchPageHtml, suggestRules } from '../_shared/scrape';
import { REGISTER } from '../_shared/register';
import { POLL_INTERVAL_MIN } from '../_shared/config';

const PAGE_SIZE = 100;

/**
 * The poller's cron cadence, in minutes. Must match the `crons` entry in
 * feed-poller/wrangler.toml (every 20 minutes); it is duplicated rather than
 * derived because the reader cannot read another Worker's triggers. Only the
 * "next pull" countdown depends on it, so drift here misleads a clock, it does
 * not break polling.
 */


/* ── escaping and text extraction ───────────────────────────── */

function esc(v: unknown): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function codepoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codepoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => codepoint(parseInt(n, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** Feed HTML to a single line of plain text (titles, excerpts). */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reading-view body: reduce feed HTML to plain-text paragraphs, but preserve
 * safe http(s) links as anchors. Anchors are pulled out to sentinels first so
 * they survive tag-stripping, then re-emitted with only an escaped href and
 * escaped text — no original attributes carried through, so it stays XSS-safe.
 */
function readingBody(html: string): string {
  // Written as an escape, not a raw NUL byte: a literal NUL makes git and grep
  // classify this whole file as binary, so it gets no reviewable diff.
  const SENT = '\u0000';
  const links: { url: string; text: string }[] = [];
  let marked = html.replace(
    /<a\b[^>]*?\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
    (_, url, inner) => `${SENT}${links.push({ url, text: stripTags(inner) }) - 1}${SENT}`,
  );
  marked = marked
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|article|tr)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const paras = decodeEntities(marked)
    .split(/\n{2,}/)
    .map((s) => s.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim())
    .filter(Boolean);
  const render = (p: string) =>
    esc(p)
      .replace(new RegExp(`${SENT}(\\d+)${SENT}`, 'g'), (_, i) => {
        const l = links[Number(i)];
        return l ? `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(l.text || l.url)}</a>` : '';
      })
      .replaceAll('\n', '<br>');
  return paras.length
    ? paras.map((p) => `<p>${render(p)}</p>`).join('')
    : '<p class="muted">This item carries no inline text. Open the original to read it.</p>';
}

function excerpt(html: string, n = 260): string {
  const t = stripTags(html);
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
}

/** Only http(s) links are emitted; anything else (javascript:, data:) is dropped. */
function safeUrl(u: string | null | undefined): string | null {
  const s = (u ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * D1's datetime('now') is 'YYYY-MM-DD HH:MM:SS' (UTC, no zone); normalise so it
 * is not read as local time. ISO strings (with a T or Z) pass through unchanged.
 */
function sqlMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(/[TZ]/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : t;
}

/** Relative time within a week, otherwise an absolute date. */
function fmtDate(iso: string | null, nowMs: number): string {
  const t = sqlMs(iso);
  if (t === null) return '';
  const diff = nowMs - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function mastheadDate(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCDate()} ${(MONTHS[d.getUTCMonth()] ?? '').toUpperCase()} ${d.getUTCFullYear()}`;
}

/** Elapsed seconds as '42s' / '7m' / '3h 12m' / '2d'. Used by the poll bar. */
function fmtAgo(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h < 6 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Remaining seconds as a clock, 'M:SS' under an hour. Used by the poll bar. */
function fmtLeft(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/* ── data types ─────────────────────────────────────────────── */

interface FeedRow {
  id: number;
  title: string;
  feed_url: string;
  site_url: string | null;
  folder: string | null;
  last_status: string | null;
  last_error: string | null;
}
interface ItemRow {
  id: number;
  feed_id: number;
  url: string | null;
  title: string;
  author: string | null;
  summary: string | null;
  content: string | null;
  published_at: string | null;
  fetched_at: string;
  is_read: number;
  is_starred: number;
  feed_title: string;
  feed_site: string | null;
}

interface PollRun {
  id: number;
  started_at: string;
  finished_at: string | null;
}

type View = 'unread' | 'all' | 'starred';

/* ── query building ─────────────────────────────────────────── */

/** Quote each search token so FTS5 treats input as literal terms, not syntax. */
function ftsQuery(q: string): string {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.slice(0, 12).map((t) => `"${t}"`).join(' ');
}

const ITEM_COLS = `items.id, items.feed_id, items.url, items.title, items.author,
  items.summary, items.content, items.published_at, items.fetched_at,
  items.is_read, items.is_starred, feeds.title AS feed_title, feeds.site_url AS feed_site`;

/* ── rendering ──────────────────────────────────────────────── */

/**
 * The pull clock: when the poller last ran, and how long until it next should.
 *
 * Both figures are emitted as *offsets in seconds at render time*, never as
 * absolute timestamps, so the ticking script counts from elapsed time rather
 * than trusting the browser's clock to agree with D1's UTC. Without script the
 * bar is still correct, it simply stops moving.
 *
 * "Next" is the next wall-clock cron boundary rather than last-run plus twenty
 * minutes: the boundary is what is actually scheduled, so it self-corrects after
 * a late or missed run. Cloudflare crons are not punctual to the second, hence
 * the '≈'.
 */
function pollBar(run: PollRun | null, nowMs: number, unreadTotal: number): string {
  const intervalS = POLL_INTERVAL_MIN * 60;
  const intervalMs = intervalS * 1000;
  let nextMs = Math.ceil(nowMs / intervalMs) * intervalMs;
  if (nextMs - nowMs < 5000) nextMs += intervalMs;
  const nextIn = Math.round((nextMs - nowMs) / 1000);

  const startedMs = sqlMs(run?.started_at);
  const agoS = startedMs === null ? null : Math.max(0, Math.round((nowMs - startedMs) / 1000));
  const last =
    agoS === null
      ? '<span class="pb-v" data-role="ago">no pull recorded</span>'
      : `<span class="pb-v" data-role="ago">${esc(fmtAgo(agoS))} ago</span>`;

  return `<div class="pollbar" data-poll="${run?.id ?? ''}" data-unread="${unreadTotal}"
      data-ago="${agoS ?? ''}" data-next="${nextIn}" data-interval="${intervalS}">
    <span class="pb-cell"><span class="pb-k">Last pull</span>${last}</span>
    <span class="pb-cell"><span class="pb-k">Next</span><span class="pb-v" data-role="next">≈ ${esc(
      fmtLeft(nextIn),
    )}</span></span>
    <button type="button" class="pb-new" data-role="new" hidden>New items ↻</button>
  </div>`;
}

function statusDot(feed: FeedRow): string {
  if (feed.last_status === 'error') return `<span class="dot err" title="${esc(feed.last_error ?? 'error')}"></span>`;
  if (!feed.last_status) return '<span class="dot new" title="not polled yet"></span>';
  return '';
}

/**
 * The sidebar: three tiers, deliberately distinct.
 *
 *   views   (Unread / All / Starred) — largest, no chevron, own section
 *   folder  — a serif row with a chevron, the prominent tier, collapsed by default
 *   feed    — smaller, quieter, indented behind a rail inside its folder
 *
 * A folder row has two targets, deliberately separate: the **arrow** expands and
 * collapses it, the **name** navigates to that folder's own filter. That is why
 * the group is a checkbox and a label rather than <details>: inside a <summary>
 * the two would compete for the same click, and whether a nested link toggles
 * the disclosure as well as navigating is browser-dependent. A checkbox makes it
 * deterministic and still needs no script.
 *
 * Nothing here ever renders a folder open. The arrow is the only thing that
 * opens one, and the script layer restores whichever were left open from
 * localStorage. Filtering by a folder marks it active; it does not expand it.
 *
 * The scroll region is `.side-scroll` only, so the view rows, the FEEDS label and
 * the manage link stay pinned while 200-odd feeds scroll under them.
 */
function feedSidebar(
  feeds: FeedRow[],
  unread: Map<number, number>,
  view: View,
  activeFeed: number | null,
  activeFolder: string | null,
): string {
  const qs = (params: Record<string, string>) => '/rss?' + new URLSearchParams(params).toString();
  const total = [...unread.values()].reduce((a, b) => a + b, 0);
  const noFilter = activeFeed === null && activeFolder === null;
  const ct = (n: number) => (n ? `<span class="ct">${n > 999 ? '999+' : n}</span>` : '');

  const vrow = (label: string, href: string, on: boolean, count?: number) =>
    `<a class="vrow${on ? ' on' : ''}" href="${esc(href)}"><span class="fname">${esc(label)}</span>${
      count ? ct(count) : ''
    }</a>`;

  const views =
    vrow('Unread', qs({ view: 'unread' }), view === 'unread' && noFilter, total) +
    vrow('All items', qs({ view: 'all' }), view === 'all' && noFilter) +
    vrow('Starred', qs({ view: 'starred' }), view === 'starred' && noFilter);

  const feedRow = (f: FeedRow) => {
    const c = unread.get(f.id) ?? 0;
    const on = activeFeed === f.id;
    return `<a class="frow${on ? ' on' : ''}${c ? ' tick' : ''}" href="${esc(qs({ view, feed: String(f.id) }))}">${statusDot(
      f,
    )}<span class="fname">${esc(f.title || f.feed_url)}</span>${ct(c)}</a>`;
  };

  const folders = new Map<string, FeedRow[]>();
  const ungrouped: FeedRow[] = [];
  for (const f of feeds) {
    const key = (f.folder ?? '').trim();
    if (key) (folders.get(key) ?? folders.set(key, []).get(key)!).push(f);
    else ungrouped.push(f);
  }

  const folderBlocks = [...folders.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name, i) => {
      const ff = folders.get(name)!;
      const fu = ff.reduce((n, f) => n + (unread.get(f.id) ?? 0), 0);
      const on = activeFolder === name;
      const id = `fg${i}`;
      // Never checked server-side: the arrow is the only thing that opens a
      // folder. Filtering by a folder marks it active, it does not expand it.
      return `<div class="fgroup" data-folder="${esc(name)}">
        <input type="checkbox" class="fg-toggle" id="${id}"
          aria-label="Show the feeds in ${esc(name)}">
        <div class="folder${on ? ' on' : ''}">
          <label class="fg-arrow" for="${id}"></label>
          <a class="foldername" href="${esc(qs({ view, folder: name }))}">${esc(name)}</a>${ct(fu)}
        </div>
        <div class="fbody">${ff.map(feedRow).join('')}</div>
      </div>`;
    })
    .join('');

  const feedsSection = feeds.length
    ? `${folderBlocks}${ungrouped.length ? `<div class="fbody flat">${ungrouped.map(feedRow).join('')}</div>` : ''}`
    : '<p class="muted pad">No feeds yet — add one above.</p>';

  // Checkbox rather than <details> for the narrow-screen collapse: CSS alone can
  // then neutralise it above 52rem (a <details> cannot be forced open by CSS),
  // so the panel needs no script to be permanently expanded on a desktop.
  return `<aside class="side">
    <input type="checkbox" id="sidetoggle" class="side-toggle">
    <label class="side-summary" for="sidetoggle"><span class="ss-chev"></span><span class="ss-word">Feeds</span>${ct(
      total,
    )}</label>
    <div class="side-inner">
      <div class="side-views">${views}</div>
      <div class="side-head"><span>Feeds</span>
        <button type="button" class="side-all" data-role="all" hidden>Expand all</button>
      </div>
      <div class="side-scroll">${feedsSection}</div>
      <div class="side-foot"><a class="manage-link" href="${esc(qs({ manage: '1' }))}">Manage feeds</a></div>
    </div>
    <div class="side-grip" role="separator" aria-orientation="vertical" tabindex="0"
      aria-label="Sidebar width. Drag, or use the arrow keys; double-click to reset."></div>
  </aside>`;
}

function itemCard(it: ItemRow, ret: string, nowMs: number): string {
  const vid = youtubeVideoId(it.url);
  const link = vid ? `/rss/watch?v=${vid}` : safeUrl(it.url);
  const openExt = link ?? '';
  const readUrl = `/rss?item=${it.id}&return=${encodeURIComponent(ret)}`;
  const titleText = stripTags(it.title) || '(untitled)';
  const title = link
    ? `<a class="ititle" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(titleText)}</a>`
    : `<span class="ititle">${esc(titleText)}</span>`;
  const author = it.author && stripTags(it.author) !== (it.feed_title || '') ? esc(stripTags(it.author)) : '';
  const meta =
    (vid ? '<span class="vid">▶ Video</span> · ' : '') +
    `<span class="src">${esc(it.feed_title || 'feed')}</span>` +
    (author ? ` · <span>${author}</span>` : '') +
    ` · <span>${fmtDate(it.published_at ?? it.fetched_at, nowMs)}</span>`;
  const ex = it.summary || it.content ? `<p class="iexc">${esc(excerpt(it.summary || it.content || ''))}</p>` : '';

  const act = (doVal: string, extra: Record<string, string>, label: string, on = false) => {
    const hidden = Object.entries({ do: doVal, return: ret, ...extra })
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('');
    return `<form data-do="${esc(doVal)}" method="post" action="/api/reader/action">${hidden}<button class="act${on ? ' on' : ''}">${esc(label)}</button></form>`;
  };

  const readBtn = it.is_read
    ? act('mark-read', { item_id: String(it.id), state: '0' }, 'Unread')
    : act('mark-read', { item_id: String(it.id), state: '1' }, 'Mark read');
  const starBtn = it.is_starred
    ? act('star', { item_id: String(it.id), state: '0' }, '★ Starred', true)
    : act('star', { item_id: String(it.id), state: '1' }, '☆ Star');
  const readHere = `<a class="act" href="${esc(readUrl)}">Read ⏎</a>`;

  return `<article class="item${it.is_read ? ' read' : ' tick'}" id="item-${it.id}" data-feed="${it.feed_id}"
    data-read-url="${esc(readUrl)}" data-open="${esc(openExt)}">
    <div class="imeta">${meta}</div>
    <h2 class="ititle-wrap">${title}</h2>
    ${ex}
    <div class="iacts">${readHere}${readBtn}${starBtn}</div>
  </article>`;
}

function itemView(it: ItemRow, ret: string, nowMs: number): string {
  const vid = youtubeVideoId(it.url);
  const link = vid ? `/rss/watch?v=${vid}` : safeUrl(it.url);
  const titleText = stripTags(it.title) || '(untitled)';
  const heading = link
    ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(titleText)}</a>`
    : esc(titleText);
  const src =
    it.feed_site && safeUrl(it.feed_site)
      ? `<a href="${esc(safeUrl(it.feed_site)!)}" target="_blank" rel="noopener noreferrer nofollow">${esc(it.feed_title || 'feed')}</a>`
      : esc(it.feed_title || 'feed');
  const author = it.author && stripTags(it.author) !== (it.feed_title || '') ? ` · ${esc(stripTags(it.author))}` : '';
  const when = fmtDate(it.published_at ?? it.fetched_at, nowMs);

  const body = readingBody(it.content || it.summary || '');

  const hidden = (o: Record<string, string>) =>
    Object.entries(o)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('');
  const back = `<a class="act" data-key="back" href="${esc(ret)}">‹ Back</a>`;
  const open = link
    ? `<a class="act" data-key="open" href="${esc(link)}" target="_blank" rel="noopener noreferrer nofollow">${vid ? 'Watch ▶' : 'Open original ↗'}</a>`
    : '';
  const star = it.is_starred
    ? `<form data-do="star" method="post" action="/api/reader/action">${hidden({ do: 'star', item_id: String(it.id), state: '0', return: `/rss?item=${it.id}` })}<button class="act on">★ Starred</button></form>`
    : `<form data-do="star" method="post" action="/api/reader/action">${hidden({ do: 'star', item_id: String(it.id), state: '1', return: `/rss?item=${it.id}` })}<button class="act">☆ Star</button></form>`;
  const unread = `<form method="post" action="/api/reader/action">${hidden({ do: 'mark-read', item_id: String(it.id), state: '0', return: ret })}<button class="act">Mark unread</button></form>`;

  return `<article class="reading">
    <div class="iacts top">${back}${open}${star}${unread}</div>
    <div class="rsrc">${vid ? '<span class="vid">▶ Video</span> · ' : ''}${src}</div>
    <h1 class="rtitle">${heading}</h1>
    <div class="rmeta">${when}${author}</div>
    <div class="rbody">${body}</div>
    <div class="iacts">${back}${open}</div>
  </article>`;
}

/** Header for a folder view, which until now arrived with no context at all. */
function folderHeader(name: string, feeds: FeedRow[], unread: Map<number, number>): string {
  const inFolder = feeds.filter((f) => (f.folder ?? '').trim() === name);
  const un = inFolder.reduce((n, f) => n + (unread.get(f.id) ?? 0), 0);
  const bad = inFolder.filter((f) => f.last_status === 'error').length;
  const n = (v: number, one: string, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;
  return `<div class="feedhead folderhead">
    <div class="fh-top">
      <span class="fh-kind">Folder</span>
      <span class="fh-name">${esc(name)}</span>
    </div>
    <div class="fh-url"><span class="fh-key">Holds</span><span>${esc(n(inFolder.length, 'feed'))} · ${esc(
      n(un, 'unread item'),
    )}</span>${bad ? `<span class="fh-badge err">${esc(n(bad, 'feed'))} erroring</span>` : ''}</div>
  </div>`;
}

/** Every folder that exists, unique and human-sorted: the chooser's option set. */
function folderList(feeds: FeedRow[]): string[] {
  return [...new Set(feeds.map((f) => (f.folder ?? '').trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' }),
  );
}

/**
 * The folder chooser: a native <select> of the folders that exist, beside a
 * small box for a new one. Used by all three places a feed gets a folder (the
 * Add form, the Manage row, the feed header's Move).
 *
 * It replaced a text input bound to a <datalist> (27 July 2026). A datalist
 * popup takes the width of its own input, which no CSS can widen, so the 6.5rem
 * Add box clipped every suggestion to 'News -' and 'YouTube -'; a <select>
 * popup sizes itself to its longest option instead. The second field is what
 * keeps creating a group possible without leaving the form, and the server
 * prefers it whenever it carries anything (folderFrom in api/reader/action.ts).
 * Choosing is now closed-vocabulary, so a typo can no longer quietly invent a
 * near-duplicate folder.
 *
 * The current folder is force-added to the options if it is somehow missing
 * from the list: a select whose value is absent falls back to its first option,
 * which here would silently move the feed to Ungrouped on the next save.
 */
function folderPicker(folders: string[], current: string, id = ''): string {
  const chosen = (current ?? '').trim();
  const known = chosen && !folders.includes(chosen) ? [...folders, chosen] : folders;
  const opts = [`<option value=""${chosen ? '' : ' selected'}>Ungrouped</option>`].concat(
    known.map((n) => `<option value="${esc(n)}"${n === chosen ? ' selected' : ''}>${esc(n)}</option>`),
  );
  // The wrapper carries the caret: appearance:none makes the control render the
  // same in Safari and Chrome, light and dark, and a CSS triangle on the wrapper
  // reads --ink-faint, so it follows the theme without a second asset.
  return `<span class="fpick-wrap"><select class="fpick"${id ? ` id="${esc(id)}"` : ''} name="folder" aria-label="Folder">${opts.join(
    '',
  )}</select></span><input type="text" class="fnew" name="folder_new" maxlength="100" placeholder="new folder" aria-label="New folder name">`;
}

function feedHeader(feed: FeedRow, ret: string, folders: string[]): string {
  const inGroup = (feed.folder ?? '').trim();
  const hidden = `<input type="hidden" name="do" value="set-folder"><input type="hidden" name="feed_id" value="${feed.id}"><input type="hidden" name="return" value="${esc(
    ret,
  )}">`;
  // The visible word matches the chooser's accessible name, and points at it by
  // id: a label reading 'Group' over a control named 'Folder' is a WCAG 2.5.3
  // mismatch, and it left the page speaking three vocabularies for one thing.
  const pickerId = `fh-folder-${feed.id}`;
  const move = `<form class="fh-form" method="post" action="/api/reader/action">${hidden}<label class="fh-label" for="${pickerId}">Folder</label>${folderPicker(
    folders,
    inGroup,
    pickerId,
  )}<button type="submit">Move</button></form>`;
  const remove = inGroup
    ? `<form class="fh-form" method="post" action="/api/reader/action">${hidden}<input type="hidden" name="folder" value=""><button type="submit" class="act">Remove from “${esc(
        inGroup,
      )}”</button></form>`
    : '';
  // The feed's own URL, shown in full and selectable: it is what you need when a
  // feed goes quiet and you want to check it, and it is otherwise only reachable
  // through Manage feeds. Linked to the feed itself; the site link sits beside it.
  const feedLink = safeUrl(feed.feed_url);
  const site = safeUrl(feed.site_url);
  const urls =
    `<div class="fh-url"><span class="fh-key">Feed</span>${
      feedLink
        ? `<a href="${esc(feedLink)}" target="_blank" rel="noopener noreferrer nofollow">${esc(feed.feed_url)}</a>`
        : `<span>${esc(feed.feed_url)}</span>`
    }</div>` +
    (site
      ? `<div class="fh-url"><span class="fh-key">Site</span><a href="${esc(
          site,
        )}" target="_blank" rel="noopener noreferrer nofollow">${esc(site)}</a></div>`
      : '');

  const status =
    feed.last_status === 'error'
      ? `<span class="fh-badge err">error${feed.last_error ? `: ${esc(stripTags(feed.last_error))}` : ''}</span>`
      : '';

  // Two steps on purpose. Deleting cascades every stored item and there is no
  // undo, so it must not sit one stray click away while you are reading; the
  // disclosure needs no script, unlike a confirm dialog.
  const del = `<details class="fh-del">
    <summary>Delete feed</summary>
    <form method="post" action="/api/reader/action">
      <input type="hidden" name="do" value="delete-feed">
      <input type="hidden" name="feed_id" value="${feed.id}">
      <input type="hidden" name="return" value="/rss">
      <p class="fh-warn">Unsubscribes and removes every stored item from this feed. There is no undo.</p>
      <button type="submit" class="danger">Delete “${esc(feed.title || feed.feed_url)}”</button>
    </form>
  </details>`;

  return `<div class="feedhead">
    <div class="fh-top"><span class="fh-name">${esc(feed.title || feed.feed_url)}</span>${
      inGroup ? `<span class="fh-badge">${esc(inGroup)}</span>` : '<span class="fh-badge ung">ungrouped</span>'
    }${status}</div>
    ${urls}
    <div class="fh-controls">${move}${remove}${del}</div>
  </div>`;
}

const UNGROUPED = 'Ungrouped';

/**
 * Manage feeds: a tally, then the failing feeds gathered at the top with their
 * error text, then every feed grouped under its folder the same way the sidebar
 * groups them. The error note is repeated on the row itself rather than left in
 * a title attribute, because a tooltip is unreadable on a phone and unfindable
 * on a desktop unless you already suspect the feed.
 */
function manageView(feeds: FeedRow[], unread: Map<number, number>, held: Map<number, number>): string {
  if (!feeds.length) return '<div class="empty">No feeds yet. Add one from the reading view.</div>';

  const errText = (f: FeedRow) => (f.last_error ? stripTags(f.last_error) : 'no detail recorded');
  const errored = feeds.filter((f) => f.last_status === 'error');
  const folderNames = folderList(feeds);
  const folders = new Set(folderNames);
  /**
   * Silent: answering healthily and holding nothing. This is the class the page
   * could not show before, and the only one the reader cannot otherwise catch,
   * because a feed that 304s against a stored ETag on an empty body stays green
   * for ever without ever being wrong. A feed that has never been polled is not
   * silent, it is simply new.
   */
  const silent = feeds.filter((f) => f.last_status && f.last_status !== 'error' && (held.get(f.id) ?? 0) === 0);

  const row = (f: FeedRow) => {
    const c = unread.get(f.id) ?? 0;
    const n = held.get(f.id) ?? 0;
    const site = safeUrl(f.site_url);
    const bad = f.last_status === 'error';
    const quiet = !bad && !!f.last_status && n === 0;
    const status = bad
      ? '<span class="mstatus err">error</span>'
      : `<span class="mstatus">${f.last_status ? 'ok' : 'new'}</span>`;
    return `<div class="mrow${bad ? ' bad' : ''}${quiet ? ' quiet' : ''}" id="feed-${f.id}">
      <form class="mform" method="post" action="/api/reader/action">
        <input type="hidden" name="do" value="update-feed">
        <input type="hidden" name="feed_id" value="${f.id}">
        <input type="hidden" name="return" value="/rss?manage=1">
        <input class="mtitle" type="text" name="title" value="${esc(f.title || '')}" placeholder="(feed title)" aria-label="Feed title">
        ${folderPicker(folderNames, f.folder ?? '')}
        <button type="submit">Save</button>
      </form>
      <form class="mform mdel" method="post" action="/api/reader/action">
        <input type="hidden" name="do" value="delete-feed">
        <input type="hidden" name="feed_id" value="${f.id}">
        <input type="hidden" name="return" value="/rss?manage=1">
        <button type="submit" class="danger">Delete</button>
      </form>
      <div class="mmeta">${status} · <span class="mitems${n === 0 ? ' none' : ''}">${n} item${
        n === 1 ? '' : 's'
      }</span> · <a href="/rss?feed=${f.id}">${c} unread</a> · ${
        site ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer nofollow">${esc(f.feed_url)}</a>` : esc(f.feed_url)
      }</div>
      ${bad ? `<div class="merr">${esc(errText(f))}</div>` : ''}
      ${quiet ? '<div class="mquiet">Answers healthily and holds nothing. Check the URL still points at a live feed.</div>' : ''}
    </div>`;
  };

  const tally = `<div class="mtally">
    <span class="mt-cell"><span class="mt-n">${feeds.length}</span> feed${feeds.length === 1 ? '' : 's'}</span>
    <span class="mt-cell"><span class="mt-n">${folders.size}</span> folder${folders.size === 1 ? '' : 's'}</span>
    <span class="mt-cell${errored.length ? ' bad' : ''}"><span class="mt-n">${errored.length}</span> erroring</span>
    <span class="mt-cell${silent.length ? ' quiet' : ''}"><span class="mt-n">${silent.length}</span> silent</span>
  </div>`;

  /**
   * Both summary panels are capped. A broad outage could otherwise list a
   * hundred feeds and bury the page it is meant to summarise. What is cut is
   * stated, never silently dropped: every feed is still listed in its folder.
   */
  const PANEL_MAX = 25;
  const panel = (title: string, list: FeedRow[], why: (f: FeedRow) => string, quiet = false) =>
    list.length
      ? `<div class="merrs${quiet ? ' quiet' : ''}">
          <div class="opml-label">${esc(title)}</div>
          ${list
            .slice(0, PANEL_MAX)
            .map(
              (f) => `<div class="merr-row">
                <a class="merr-name" href="#feed-${f.id}">${esc(f.title || f.feed_url)}</a>
                <span class="merr-why">${esc(why(f))}</span>
                <span class="merr-url">${esc(f.feed_url)}</span>
                <form class="merr-del" method="post" action="/api/reader/action">
                  <input type="hidden" name="do" value="delete-feed">
                  <input type="hidden" name="feed_id" value="${f.id}">
                  <input type="hidden" name="return" value="/rss?manage=1">
                  <button type="submit" class="danger">Delete</button>
                </form>
              </div>`,
            )
            .join('')}
          ${
            list.length > PANEL_MAX
              ? `<div class="merr-more">and ${list.length - PANEL_MAX} more, listed in their folders below</div>`
              : ''
          }
        </div>`
      : '';

  const errorPanel = panel('Feeds with errors', errored, errText);

  const silentPanel = panel(
    'Silent feeds — healthy replies, no items',
    silent,
    (f) => `last reply: ${f.last_status ?? ''}`,
    true,
  );

  const byFolder = new Map<string, FeedRow[]>();
  for (const f of feeds) {
    const key = (f.folder ?? '').trim() || UNGROUPED;
    (byFolder.get(key) ?? byFolder.set(key, []).get(key)!).push(f);
  }
  // Ungrouped last, everything else alphabetical, matching the sidebar's order.
  const names = [...byFolder.keys()].sort((a, b) =>
    a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b),
  );
  const sections = names
    .map((name) => {
      const ff = byFolder.get(name)!;
      const bad = ff.filter((f) => f.last_status === 'error').length;
      const mute = ff.filter((f) => f.last_status && f.last_status !== 'error' && (held.get(f.id) ?? 0) === 0).length;
      return `<section class="mgroup">
        <h3 class="mgroup-head">${esc(name)}<span class="mgroup-n">${ff.length}</span>${
          bad ? `<span class="mgroup-n bad">${bad} erroring</span>` : ''
        }${mute ? `<span class="mgroup-n quiet">${mute} silent</span>` : ''}</h3>
        ${ff.map(row).join('')}
      </section>`;
    })
    .join('');

  return `<div class="manage">
    <div class="mhead"><h2>Manage feeds</h2><a class="act" href="/rss">‹ Back to reading</a></div>
    ${tally}
    <p class="muted mnote">Choose a folder to group a feed in the sidebar, or Ungrouped to take it out of one. Renaming changes only the display name. To make a new group, type its name in the box beside the chooser: it wins over whatever the chooser shows.</p>
    ${errorPanel}
    ${silentPanel}
    ${sections}
    <form class="opml-box" method="post" action="/api/reader/action" enctype="multipart/form-data">
      <div class="opml-label">Import subscriptions</div>
      <p class="mnote">Bring feeds over in bulk: export an OPML file from another reader (Feedly, Inoreader, NetNewsWire…), then choose it here. Folders in the file are kept.</p>
      <input type="hidden" name="do" value="import-opml">
      <input type="hidden" name="return" value="/rss?manage=1">
      <div class="opml-row"><input type="file" name="opml" accept=".opml,.xml,application/xml,text/xml" aria-label="OPML file"><button type="submit">Import OPML</button></div>
    </form>
  </div>`;
}

function toolbar(view: View, activeFeed: number | null, activeFolder: string | null, q: string, feeds: FeedRow[], back = ''): string {
  const feedField = activeFeed !== null ? `<input type="hidden" name="feed" value="${activeFeed}">` : '';
  const folderField = activeFolder !== null ? `<input type="hidden" name="folder" value="${esc(activeFolder)}">` : '';
  const search = `<form class="tb-search" method="get" action="/rss" role="search">
    <input type="hidden" name="view" value="${esc(view)}">${feedField}${folderField}
    <input type="search" name="q" value="${esc(q)}" placeholder="Search" aria-label="Search articles">
    <button type="submit">Find</button>
  </form>`;

  // Adding a feed returns you to the list you were reading, not to the top of
  // the unread pile: the new feed holds nothing until the next poll, so there is
  // nothing to be shown by throwing away your filter, your search and your page.
  // `back` is the caller's own return string when it has one (it carries the
  // page number too); otherwise the current filter is rebuilt from what the
  // toolbar knows. Both are in-app paths, which is what backTo() will honour.
  const addReturn =
    back ||
    '/rss?' +
      new URLSearchParams({
        view,
        ...(activeFeed !== null ? { feed: String(activeFeed) } : {}),
        ...(activeFolder !== null ? { folder: activeFolder } : {}),
        ...(q ? { q } : {}),
      }).toString();

  // Two submits, so `do` comes from whichever was pressed rather than a hidden
  // field. 'From page' skips discovery entirely, which is the only way to reach
  // the scrape preview for a site that HAS a feed. Some publishers leave a
  // valid rss.xml in place long after it stopped carrying the news, and while
  // discovery keeps resolving to it the page's own list is unreachable.
  // Add stays first, so pressing Enter in the field still adds.
  const add = `<form class="tb-add" method="post" action="/api/reader/action">
    <input type="hidden" name="return" value="${esc(addReturn)}">
    <input type="url" name="url" placeholder="Add feed or site URL" aria-label="Feed or site URL" required>
    ${folderPicker(folderList(feeds), '')}
    <button type="submit" name="do" value="add-feed">Add</button>
    <button type="submit" name="do" value="scrape-preview" class="alt"
            title="Build a feed from the page's own list of articles, ignoring any feed it publishes">From page</button>
  </form>`;

  const markAll =
    view === 'unread'
      ? `<form class="tb-mark" method="post" action="/api/reader/action">
          <input type="hidden" name="do" value="mark-all">
          <input type="hidden" name="return" value="${esc('/rss?' + new URLSearchParams({ view, ...(activeFeed !== null ? { feed: String(activeFeed) } : {}), ...(activeFolder !== null ? { folder: activeFolder } : {}) }).toString())}">
          ${activeFeed !== null ? `<input type="hidden" name="feed_id" value="${activeFeed}">` : ''}
          ${activeFolder !== null ? `<input type="hidden" name="folder" value="${esc(activeFolder)}">` : ''}
          <button type="submit">Mark all read</button>
        </form>`
      : '';

  return `<div class="toolbar">${search}${markAll}${add}</div>`;
}

/* ── the instrument's finish (CSS) ──────────────────────────── */

const STYLE = `
${REGISTER}

  /* THIS READER'S VOCABULARY, ALIASED ONTO THE REGISTER. Every rule below still
     asks for --ink, --hair, --accent and the rest; one indirection, and the next
     re-inking is this block alone.

     ONE RED, ONE MEANING, which is the whole substance of the change and it was
     settled by a C-8 round that reversed the recommendation it reviewed.
       - The signal means ATTEND TO THIS. Nothing else is chromatic. It marks a
         feed that is erroring and the destructive controls, and no third thing.
       - Where you ARE is an ink fill, not a colour. On the public site the
         signal marks the active nav item, because nothing on a publications
         index can break. A reader can break, so on this surface red is spent on
         what broke rather than on where you are standing. That divergence is
         deliberate and it is the reason it is written down here.
       - QUIET IS NO LONGER A HUE. It was brass, and brass sat at dE2000 4.6
         from alert under deuteranopia in the day theme, which is close to
         indistinguishable. Quiet is now ink plus a 1px mark; broken is the
         signal plus a 2px mark. Ink against signal is dE2000 39.1 by day and
         34.6 by night, so the two states separate by roughly six times what the
         old pair managed, in every kind of vision.
       - The words were always there. Every place the two states meet, the
         markup already writes 'erroring' and 'silent' in the cell, so colour
         has never been the only channel and the marks are a scanning aid rather
         than a fix for a broken interface.

     THREE GROUNDS ONTO TWO, stated rather than left to be discovered: --paper
     and --raise both take the parchment, --surface takes the inset. The reader's
     third step has nowhere to go in a two-step ladder and the inset is where the
     panels already sat. */
  :root {
    --paper: var(--bg-parchment);
    --surface: var(--bg-ivory);
    --raise: var(--bg-parchment);
    --ink: var(--fg-ink);
    --ink-soft: var(--fg-ink-soft);
    --ink-faint: var(--fg-ink-soft);
    --hair: var(--rule-soft);
    --hair-soft: var(--line-soft);
    --accent: var(--fg-ink);
    --accent-soft: var(--rule-soft);
    --accent-wash: var(--line-soft);
    --brass: var(--fg-ink);
    --alert: var(--signal);
    --serif: var(--font-display);
    --mono: var(--font-mono);
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
         font:16px/1.6 var(--serif); -webkit-font-smoothing:antialiased; }
  a { color:var(--accent); }
  .devbar { background:var(--accent); color:var(--surface); text-align:center;
            font:.7rem/1 var(--mono); letter-spacing:.06em; padding:.45rem; }
  .wrap { max-width:72rem; margin:0 auto; padding:0 1.25rem 5rem; }

  /* masthead — the instrument dial */
  .mast { display:flex; align-items:center; gap:.9rem; padding:1.1rem .1rem .9rem; border-bottom:1px solid var(--hair); }
  .mast .mark { width:1.5rem; height:1.5rem; flex:0 0 auto; color:var(--accent); }
  .mast .word { font:600 .95rem/1 var(--mono); letter-spacing:.34em; text-transform:uppercase; color:var(--ink); }
  .mast .date { margin-left:auto; font:.7rem/1 var(--mono); letter-spacing:.1em; color:var(--ink-faint);
                font-variant-numeric:tabular-nums; }
  .mast .who { font:.7rem/1 var(--mono); letter-spacing:.04em; color:var(--ink-faint); }

  .flash { border:1px solid var(--hair); border-left:2px solid var(--accent); background:var(--surface);
           border-radius:2px; padding:.55rem .85rem; margin:1rem 0 0; font:.9rem/1.5 var(--serif); color:var(--ink-soft); }
  .flash.err { border-left-color:var(--alert); }

  /* the scrape preview: a page with no feed, and what a rule would make of it */
  .scrape-panel { border:1px solid var(--hair); border-left:2px solid var(--brass); background:var(--surface);
    border-radius:2px; padding:.85rem; margin:1rem 0 0; }
  .sp-intro { margin:0 0 .75rem; font:.9rem/1.5 var(--serif); color:var(--ink-soft); }
  .sp-card { border:1px solid var(--hair-soft); background:var(--raise); border-radius:2px;
    padding:.6rem .7rem; margin:0 0 .6rem; display:flex; flex-direction:column; gap:.5rem; align-items:flex-start; }
  .sp-head { display:flex; gap:.75rem; align-items:baseline; font:.66rem/1.4 var(--mono);
    letter-spacing:.07em; text-transform:uppercase; color:var(--ink-faint); }
  .sp-sel { color:var(--brass); text-transform:none; letter-spacing:.02em; }
  .sp-list { margin:0; padding:0 0 0 1.1rem; font:.85rem/1.45 var(--serif); color:var(--ink); }
  .sp-list li { margin:.15rem 0; }
  .sp-when { font:.66rem/1 var(--mono); color:var(--ink-faint); }

  /* the pull clock */
  .pollbar { display:flex; flex-wrap:wrap; align-items:center; gap:.35rem 1.2rem; margin:.75rem 0 0;
    font:.66rem/1.4 var(--mono); letter-spacing:.07em; text-transform:uppercase; color:var(--ink-faint); }
  .pb-cell { display:inline-flex; align-items:baseline; gap:.4rem; }
  .pb-v { color:var(--ink-soft); font-variant-numeric:tabular-nums; }
  .pb-new { margin-left:auto; font:.64rem/1 var(--mono); letter-spacing:.07em; text-transform:uppercase;
    border:1px solid var(--accent); background:var(--accent); color:var(--surface); border-radius:2px;
    padding:.3rem .55rem; cursor:pointer; transition:filter .12s ease; }
  .pb-new:hover { filter:brightness(1.08); }
  .pb-new[hidden] { display:none; }

  /* toolbar — instrument controls in mono */
  .toolbar { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; margin:1rem 0 1.4rem; }
  .toolbar form { display:flex; gap:.3rem; align-items:center; }
  .toolbar input[type=search], .toolbar input[type=url], .toolbar .fnew {
    font:.8rem/1 var(--mono); padding:.4rem .55rem; border:1px solid var(--hair); border-radius:2px;
    background:var(--raise); color:var(--ink); }
  .toolbar input[type=search] { min-width:8rem; }
  .toolbar input[type=url] { min-width:11rem; }

  /* the folder chooser (Add form, Manage row, feed-header Move), see
     folderPicker(). The closed control is capped; its popup is not, and that is
     the whole point of the select element here. */
  .fpick-wrap { position:relative; display:inline-flex; align-items:center; min-width:0; }
  .fpick { appearance:none; -webkit-appearance:none; width:100%; min-width:0; cursor:pointer;
    font:.8rem/1 var(--mono); padding:.4rem 1.55rem .4rem .55rem; border:1px solid var(--hair);
    border-radius:2px; background:var(--raise); color:var(--ink); text-overflow:ellipsis; }
  .fpick:focus-visible { outline:2px solid var(--accent-soft); outline-offset:1px; }
  .fpick-wrap::after { content:''; position:absolute; right:.5rem; top:50%; margin-top:-.12rem;
    width:0; height:0; border-left:.26rem solid transparent; border-right:.26rem solid transparent;
    border-top:.28rem solid var(--ink-faint); pointer-events:none; }
  .toolbar .fpick-wrap { max-width:11rem; }
  .toolbar .fnew { width:7rem; }
  .toolbar input[type=file] { font:.7rem/1 var(--mono); max-width:8.5rem; color:var(--ink-soft); }
  .filelabel { display:inline-flex; align-items:center; gap:.35rem; font:.66rem/1 var(--mono);
               letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint); }
  .toolbar button { font:.68rem/1 var(--mono); letter-spacing:.08em; text-transform:uppercase;
    padding:.45rem .7rem; border:1px solid var(--accent); background:var(--accent); color:var(--surface);
    border-radius:2px; cursor:pointer; white-space:nowrap; transition:filter .12s ease; }
  .toolbar button:hover { filter:brightness(1.08); }
  .tb-add { margin-left:auto; }
  .tb-mark button, .tb-import button, .tb-add .alt { background:transparent; color:var(--accent); }

  /* layout — the sidebar's width is a variable so the grip can drag it. The
     clamp is the safety net: a width dragged wide on a large display cannot
     swallow a smaller one later, because 40vw wins over the stored value. */
  .layout { display:grid; grid-template-columns:clamp(9.5rem, var(--side-w, 15.5rem), 40vw) minmax(0,1fr);
    gap:2.25rem; align-items:start; }

  /* sidebar — its own scroller, pinned beside the list */
  .side { position:sticky; top:1rem; min-width:0; }
  .side-inner { display:flex; flex-direction:column; min-height:0;
    max-height:calc(100vh - 2rem); max-height:calc(100dvh - 2rem);
    border:1px solid var(--hair-soft); border-radius:3px; background:var(--surface); }
  .side-views { flex:0 0 auto; display:flex; flex-direction:column; padding:.35rem; }
  .side-head { flex:0 0 auto; display:flex; align-items:center; gap:.5rem;
    font:600 .6rem/1 var(--mono); letter-spacing:.2em; text-transform:uppercase;
    color:var(--ink-faint); padding:.6rem .75rem .45rem; border-top:1px solid var(--hair-soft); }
  .side-all { margin-left:auto; font:.58rem/1 var(--mono); letter-spacing:.1em; text-transform:uppercase;
    color:var(--accent); background:none; border:1px solid transparent; border-radius:2px;
    padding:.2rem .35rem; cursor:pointer; }
  .side-all:hover { border-color:var(--accent-soft); }
  .side-all[hidden] { display:none; }
  .side-scroll { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain;
    padding:0 .35rem .45rem; scrollbar-width:thin; scrollbar-color:var(--hair) transparent; }
  .side-scroll::-webkit-scrollbar { width:.5rem; }
  .side-scroll::-webkit-scrollbar-track { background:transparent; }
  .side-scroll::-webkit-scrollbar-thumb { background:var(--hair); border-radius:99px;
    border:.13rem solid var(--surface); }
  .side-foot { flex:0 0 auto; border-top:1px solid var(--hair-soft); }

  /* narrow-screen disclosure; the media block below turns it on */
  .side-toggle { position:absolute; width:1px; height:1px; opacity:0; }
  .side-summary { display:none; }

  /* drag handle, live only in the two-pane shell (below 52rem there is one
     column, so there is no width to drag) */
  .side-grip { display:none; }

  /* tier 1 — the view rows */
  .vrow { display:flex; align-items:center; gap:.5rem; padding:.4rem .6rem; border-radius:2px;
    text-decoration:none; color:var(--ink); font:500 .95rem/1.3 var(--serif); }
  .vrow:hover { background:var(--accent-wash); }
  .vrow.on { background:var(--accent); color:var(--surface); }
  .vrow .fname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* tier 2 — folders: the prominent row, collapsed by default. Two targets: the
     arrow toggles (a label for the group's checkbox), the name navigates. */
  .fgroup { position:relative; margin:0 0 .1rem; }
  .fg-toggle { position:absolute; top:0; left:0; width:1px; height:1px; opacity:0; }
  .folder { display:flex; align-items:center; gap:.1rem; border-radius:2px; }
  .folder:hover { background:var(--accent-wash); }
  .fg-arrow { flex:0 0 auto; display:flex; align-items:center; justify-content:center;
    width:1.4rem; align-self:stretch; cursor:pointer; border-radius:2px; }
  .fg-arrow::before { content:''; width:.36rem; height:.36rem;
    border-right:1.4px solid var(--ink-faint); border-bottom:1.4px solid var(--ink-faint);
    transform:rotate(-45deg); transition:transform .14s ease; }
  .fg-arrow:hover::before { border-color:var(--accent); }
  .fg-toggle:checked ~ .folder .fg-arrow::before { transform:rotate(45deg); }
  .fg-toggle:focus-visible ~ .folder .fg-arrow { outline:2px solid var(--accent); outline-offset:-2px; }
  .foldername { flex:1; min-width:0; padding:.42rem .3rem .42rem 0; text-decoration:none;
    font:600 .89rem/1.3 var(--serif); color:var(--ink);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .foldername:hover { color:var(--accent); }
  .folder.on .foldername { color:var(--accent); }
  .folder.on .fg-arrow::before { border-color:var(--accent); }
  .fbody { display:none; }
  .fg-toggle:checked ~ .fbody { display:flex; }

  /* tier 3 — feeds: quieter, smaller, indented behind a rail. The display
     property is owned by the collapse rules above; setting it here overrides them. */
  .fbody { flex-direction:column; margin:.05rem 0 .35rem 1.1rem; padding-left:.5rem;
    border-left:1px solid var(--hair-soft); }
  .fbody.flat { display:flex; margin-left:.6rem; padding-left:0; border-left:none; }
  .frow { display:flex; align-items:center; gap:.4rem; padding:.28rem .5rem; border-radius:2px;
    text-decoration:none; color:var(--ink-soft); font:.83rem/1.3 var(--serif); position:relative; }
  .frow:hover { background:var(--accent-wash); color:var(--ink); }
  .frow.on { background:var(--accent); color:var(--surface); }
  /* Unread is carried by weight and ink, not a rail: a rail here would run
     alongside .fbody's grouping line and read as a second, meaningless one. */
  .frow.tick { color:var(--ink); font-weight:500; }
  .frow .fname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  .ct { flex:0 0 auto; font:.66rem/1 var(--mono); color:var(--ink-faint); font-variant-numeric:tabular-nums;
    background:var(--accent-wash); padding:.1rem .34rem; border-radius:2px; }
  .vrow.on .ct, .frow.on .ct { background:rgba(255,255,255,.22); color:var(--surface); }
  .folder .ct { background:none; padding:.1rem .45rem .1rem 0; }
  .dot { width:.42rem; height:.42rem; border-radius:50%; flex:0 0 auto; }
  .dot.err { background:var(--alert); } .dot.new { background:var(--accent-soft); }
  .pad { padding:.4rem .6rem; }
  .manage-link { display:block; padding:.5rem .75rem; font:.64rem/1 var(--mono); letter-spacing:.08em;
                 text-transform:uppercase; color:var(--accent); text-decoration:none; }
  .manage-link:hover { text-decoration:underline; }

  /* item list */
  .items { min-width:0; }
  .item { padding:1.05rem 0 1.15rem 1.1rem; border-bottom:1px solid var(--hair-soft); position:relative; }
  .item.tick::before { content:''; position:absolute; left:0; top:1.2rem; bottom:1.2rem; width:2px; background:var(--accent); }
  .item.sel { background:var(--accent-wash); box-shadow:-1.1rem 0 0 var(--accent-wash), 1.25rem 0 0 var(--accent-wash); }
  .item.read { opacity:.52; }
  .imeta { font:.66rem/1 var(--mono); letter-spacing:.05em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:.4rem; }
  .imeta .src { color:var(--accent); font-weight:600; }
  .imeta .vid { color:var(--brass); font-weight:600; border:1px solid var(--brass); border-radius:2px; padding:.03rem .28rem; }
  /* The heading's own strut, not the body's 1.6, sets the line box: otherwise a
     title that wraps on a narrow screen opens a gap the title's leading never asked for. */
  h2.ititle-wrap { margin:0 0 .3rem; font:400 1rem/1.32 var(--serif); }
  .ititle { font:500 clamp(1.02rem, .96rem + .3vw, 1.12rem)/1.32 var(--serif); color:var(--ink);
    text-decoration:none; letter-spacing:-.005em; text-wrap:pretty; overflow-wrap:break-word; }
  .ititle:hover { color:var(--accent); }
  /* No measure cap: the excerpt is two or three lines, so it fills the column
     rather than breaking short of it. The reading view keeps its measure, which
     is where a long line actually costs something. */
  .iexc { margin:0; font:clamp(.88rem, .85rem + .18vw, .94rem)/1.55 var(--serif); color:var(--ink-soft);
    text-wrap:pretty; overflow-wrap:break-word; }
  .iacts { display:flex; flex-wrap:wrap; gap:.35rem; align-items:center; margin-top:.7rem; }
  .iacts.top { margin:0 0 1.3rem; }
  .iacts form { margin:0; }
  .act { font:.64rem/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--ink-soft);
    border:1px solid var(--hair); background:var(--surface); border-radius:2px; padding:.32rem .55rem; cursor:pointer;
    text-decoration:none; display:inline-block; transition:border-color .12s ease, color .12s ease; }
  .act:hover { border-color:var(--accent-soft); color:var(--accent); }
  .act.on { background:var(--accent-wash); border-color:transparent; color:var(--accent); }

  /* reading view */
  .reading { max-width:min(42rem, 100%); }
  .rsrc { font:.68rem/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--accent); margin-bottom:.5rem; }
  .rsrc a { color:var(--accent); text-decoration:none; }
  .rsrc .vid { color:var(--brass); }
  .rtitle { font:500 clamp(1.4rem, 1.06rem + 1.5vw, 1.85rem)/1.2 var(--serif); letter-spacing:-.012em;
    margin:0 0 .5rem; text-wrap:balance; overflow-wrap:break-word; }
  .rtitle a { color:var(--ink); text-decoration:none; }
  .rtitle a:hover { color:var(--accent); }
  .rmeta { font:.7rem/1.4 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:1.6rem; }
  .rbody { font:clamp(1rem, .97rem + .2vw, 1.06rem)/1.75 var(--serif); }
  .rbody p { margin:0 0 1.15rem; max-width:64ch; text-wrap:pretty; overflow-wrap:break-word; }
  .rbody a { color:var(--accent); text-underline-offset:2px; overflow-wrap:break-word; }
  .rbody p:first-of-type::first-letter { font-size:3rem; line-height:.82; float:left; padding:.12rem .5rem 0 0;
    font-weight:600; color:var(--accent); }

  /* manage + feed header */
  .feedhead { border:1px solid var(--hair); border-radius:2px; background:var(--surface); padding:.7rem .9rem; margin:0 0 1.2rem; }
  .fh-top { display:flex; align-items:center; gap:.6rem; margin-bottom:.55rem; }
  .fh-name { font:500 1rem/1.3 var(--serif); color:var(--ink); }
  .folderhead .fh-name { font-size:1.2rem; }
  .fh-kind { font:600 .58rem/1 var(--mono); letter-spacing:.18em; text-transform:uppercase;
             color:var(--ink-faint); }
  .fh-badge { font:.62rem/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; padding:.15rem .45rem;
              border-radius:2px; background:var(--accent-wash); color:var(--accent); }
  .fh-badge.ung { background:none; border:1px solid var(--hair); color:var(--ink-faint); }
  .fh-badge.err { background:none; border:1px solid var(--alert); color:var(--alert); text-transform:none;
                  letter-spacing:.02em; }
  .fh-url { display:flex; gap:.5rem; align-items:baseline; font:.72rem/1.5 var(--mono);
            color:var(--ink-soft); margin-bottom:.35rem; }
  .fh-url a { color:var(--accent); text-decoration:none; overflow-wrap:anywhere; }
  .fh-url a:hover { text-decoration:underline; }
  .fh-key { flex:0 0 2.4rem; font-size:.62rem; letter-spacing:.14em; text-transform:uppercase;
            color:var(--ink-faint); }
  .fh-controls { display:flex; flex-wrap:wrap; gap:.5rem .8rem; align-items:center; margin-top:.6rem; }
  .fh-form { display:flex; gap:.35rem; align-items:center; }
  .fh-label { font:.64rem/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint);
              display:inline-flex; align-items:center; gap:.35rem; }
  .fh-form input[type=text] { font:.82rem/1 var(--mono); padding:.3rem .5rem; border:1px solid var(--hair);
    border-radius:2px; background:var(--raise); color:var(--ink); width:7.5rem; }
  .fh-form .fpick { font:.82rem/1 var(--mono); padding:.3rem 1.5rem .3rem .5rem; }
  .fh-form .fpick-wrap { max-width:11rem; }
  .fh-form button[type=submit]:not(.act) { font:.64rem/1 var(--mono); letter-spacing:.06em; text-transform:uppercase;
    padding:.32rem .65rem; cursor:pointer; border:1px solid var(--accent); background:var(--accent); color:var(--surface); border-radius:2px; }
  .fh-del { margin-left:auto; }
  /* width:max-content keeps the summary button-sized; without it the open
     details stretches it to the width of the warning beneath. */
  .fh-del > summary { list-style:none; cursor:pointer; width:max-content; font:.64rem/1 var(--mono);
    letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); padding:.32rem .55rem;
    border:1px solid var(--hair); border-radius:2px; }
  .fh-del > summary::-webkit-details-marker { display:none; }
  .fh-del > summary:hover { color:var(--alert); border-color:var(--alert); }
  .fh-del[open] > summary { color:var(--alert); border-color:var(--alert); }
  .fh-del form { margin:.6rem 0 0; }
  .fh-warn { margin:0 0 .5rem; font:.82rem/1.5 var(--serif); color:var(--ink-soft); max-width:44ch; }
  .fh-del button.danger { font:.64rem/1 var(--mono); letter-spacing:.06em; text-transform:uppercase;
    padding:.4rem .7rem; cursor:pointer; border:1px solid var(--alert); background:var(--alert);
    color:var(--surface); border-radius:2px; }

  .manage { max-width:52rem; }
  /* tally + error panel + folder sections */
  .mtally { display:flex; flex-wrap:wrap; gap:.4rem 1.6rem; margin:.7rem 0 .2rem;
    font:.68rem/1.4 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint); }
  .mt-cell.bad { color:var(--alert); }
  .mt-cell.quiet { color:var(--brass); }
  .mt-n { font-size:1.15rem; letter-spacing:0; color:var(--ink); font-variant-numeric:tabular-nums; }
  .mt-cell.bad .mt-n { color:var(--alert); }
  .mt-cell.quiet .mt-n { color:var(--brass); }
  .merrs { border:1px solid var(--alert); border-radius:2px; background:var(--surface);
    padding:.8rem 1rem; margin:1.1rem 0 1.4rem; }
  .merrs .opml-label { color:var(--alert); margin-bottom:.55rem; }
  /* Silent is brass, not red: the feed is not failing, it is just delivering
     nothing, and colouring it as an error would blunt what red means here. */
  .merrs.quiet { border-color:var(--brass); }
  .merrs.quiet .opml-label { color:var(--brass); }
  .merrs.quiet .merr-why { color:var(--brass); }
  .merr-row { display:grid; grid-template-columns:minmax(8rem,14rem) 1fr auto; gap:.15rem .9rem;
    align-items:start; padding:.45rem 0; border-top:1px solid var(--hair-soft); }
  .merr-del { grid-column:3; grid-row:1 / span 2; align-self:center; margin:0; }
  .merr-del button.danger { font:.6rem/1 var(--mono); letter-spacing:.06em; text-transform:uppercase;
    padding:.3rem .55rem; cursor:pointer; border:1px solid var(--hair); background:none;
    color:var(--alert); border-radius:2px; }
  .merr-del button.danger:hover { border-color:var(--alert); }
  .merr-row:first-of-type { border-top:none; }
  .merr-name { font:500 .9rem/1.35 var(--serif); color:var(--accent); text-decoration:none; }
  .merr-name:hover { text-decoration:underline; }
  .merr-why { font:.72rem/1.45 var(--mono); color:var(--alert); overflow-wrap:anywhere; }
  .merr-url { grid-column:2; font:.68rem/1.4 var(--mono); color:var(--ink-faint); overflow-wrap:anywhere; }
  .merr-more { padding-top:.5rem; border-top:1px solid var(--hair-soft); margin-top:.35rem;
    font:.68rem/1.4 var(--mono); color:var(--ink-faint); }
  .mgroup { margin:0 0 1.6rem; }
  .mgroup-head { display:flex; align-items:baseline; gap:.6rem; margin:0 0 .2rem;
    font:600 .72rem/1.4 var(--mono); letter-spacing:.16em; text-transform:uppercase; color:var(--ink-soft);
    border-bottom:1px solid var(--hair); padding-bottom:.35rem; }
  .mgroup-n { font-size:.66rem; letter-spacing:.08em; color:var(--ink-faint); font-variant-numeric:tabular-nums; }
  .mgroup-n.bad { color:var(--alert); }
  .mgroup-n.quiet { color:var(--brass); }
  .mrow.bad { box-shadow:inset .16rem 0 0 var(--alert); padding-left:.7rem; }
  .mrow.quiet { box-shadow:inset .16rem 0 0 var(--brass); padding-left:.7rem; }
  .merr { flex-basis:100%; font:.7rem/1.45 var(--mono); color:var(--alert); overflow-wrap:anywhere; }
  .mquiet { flex-basis:100%; font:.7rem/1.45 var(--mono); color:var(--brass); overflow-wrap:anywhere; }
  .mitems { font-variant-numeric:tabular-nums; }
  .mitems.none { color:var(--brass); font-weight:600; }
  .mhead { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--hair);
    padding-bottom:.6rem; margin-bottom:.5rem; }
  .mhead h2 { font:500 1.35rem/1.2 var(--serif); color:var(--ink); margin:0; }
  .mrow { border-bottom:1px solid var(--hair-soft); padding:.85rem 0; display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
  .mform { display:flex; gap:.35rem; align-items:center; flex-wrap:wrap; }
  .mform input[type=text] { font:.82rem/1 var(--mono); padding:.32rem .5rem; border:1px solid var(--hair);
    border-radius:2px; background:var(--raise); color:var(--ink); }
  .mtitle { min-width:13rem; }
  .mform .fpick { font:.82rem/1 var(--mono); padding:.32rem 1.5rem .32rem .5rem; }
  .mform .fpick-wrap { max-width:11rem; }
  .mform .fnew { min-width:6.5rem; width:6.5rem; }
  .mform button { font:.64rem/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; padding:.34rem .65rem;
    cursor:pointer; border:1px solid var(--accent); background:var(--accent); color:var(--surface); border-radius:2px; }
  .mform.mdel button.danger { background:none; color:var(--alert); border-color:var(--hair); }
  .mmeta { flex-basis:100%; font:.7rem/1.3 var(--mono); color:var(--ink-faint); }
  .mmeta a { color:var(--accent); }
  .mstatus { text-transform:uppercase; letter-spacing:.06em; }
  .mstatus.err { color:var(--alert); }
  .mnote { font:.85rem/1.5 var(--serif); color:var(--ink-faint); }
  .opml-box { border:1px solid var(--hair); border-radius:2px; background:var(--surface); padding:.9rem 1rem; margin-top:1.7rem; }
  .opml-label { font:600 .64rem/1 var(--mono); letter-spacing:.16em; text-transform:uppercase; color:var(--ink-soft); }
  .opml-box .mnote { margin:.5rem 0 .85rem; max-width:48ch; }
  .opml-row { display:flex; gap:.7rem; align-items:center; flex-wrap:wrap; }
  .opml-row input[type=file] { font:.8rem/1.6 var(--mono); color:var(--ink-soft); flex:1; min-width:13rem; }
  .opml-row input[type=file]::file-selector-button { font:.62rem/1 var(--mono); letter-spacing:.06em; text-transform:uppercase;
    padding:.42rem .7rem; margin-right:.7rem; border:1px solid var(--accent); background:transparent; color:var(--accent); border-radius:2px; cursor:pointer; }
  .opml-row button[type=submit] { font:.64rem/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; padding:.44rem .75rem;
    border:1px solid var(--accent); background:var(--accent); color:var(--surface); border-radius:2px; cursor:pointer; }

  .pager { display:flex; justify-content:space-between; gap:1rem; margin-top:1.6rem; font:.7rem/1 var(--mono);
           letter-spacing:.06em; text-transform:uppercase; }
  .pager a { color:var(--accent); text-decoration:none; }
  .empty { padding:3.5rem 1rem; text-align:center; font:1rem/1.6 var(--serif); color:var(--ink-faint); }
  .muted { color:var(--ink-faint); }
  footer { margin-top:3.5rem; padding-top:1rem; border-top:1px solid var(--hair);
           font:.68rem/1.5 var(--mono); letter-spacing:.05em; text-transform:uppercase; color:var(--ink-faint); }
  footer a { color:var(--accent); }
  /* ── widths ─────────────────────────────────────────────────────
     Four steps: a two-pane app shell above 52rem, a tighter desktop below
     64rem, the sidebar folding into a disclosure below 52rem, and a phone pass
     below 34rem where the toolbar forms stack and the instrument type steps
     down. Everything below 52rem is one column and scrolls as a document, so
     nothing there depends on the sidebar being reachable. */

  /* Above 52rem the page stops scrolling as a document and becomes two panes
     that scroll independently, which is the only way the sidebar's own
     scrollbar is usable without first scrolling the page: a sticky column
     cannot know how far down the viewport it starts. The masthead, the pull
     clock and the toolbar stay put above both. */
  @media (min-width:52.0625rem) {
    .wrap { display:flex; flex-direction:column; height:100vh; height:100dvh; padding-bottom:0; }
    .layout { flex:1 1 auto; min-height:0; align-items:stretch; padding-bottom:.9rem; }
    .side { position:relative; min-height:0; }
    .side-inner { height:100%; max-height:none; }
    /* Sits in the column gap, so it never steals width from either pane. */
    .side-grip { display:block; position:absolute; top:0; bottom:0; right:-1.15rem; width:.6rem;
      cursor:col-resize; touch-action:none; }
    .side-grip::before { content:''; position:absolute; top:0; bottom:0; left:50%; width:1px;
      transform:translateX(-50%); background:var(--hair-soft); transition:background .12s ease, width .12s ease; }
    .side-grip:hover::before, .side-grip.dragging::before { background:var(--accent-soft); width:2px; }
    .side-grip:focus-visible { outline:none; }
    .side-grip:focus-visible::before { background:var(--accent); width:2px; }
    body.resizing { cursor:col-resize; user-select:none; }
    /* The negative padding/margin pair keeps the selected card's bleed painting:
       overflow clips at the padding box, so without it the -1.1rem shadow that
       marks a keyboard selection would be cut off against the pane's edge. */
    .items { overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain;
      padding:0 .6rem 1.6rem 1.2rem; margin-left:-1.2rem;
      scrollbar-width:thin; scrollbar-color:var(--hair) transparent; }
    .items::-webkit-scrollbar { width:.5rem; }
    .items::-webkit-scrollbar-track { background:transparent; }
    .items::-webkit-scrollbar-thumb { background:var(--hair); border-radius:99px;
      border:.13rem solid var(--paper); }
    footer { flex:0 0 auto; margin-top:0; }
  }

  @media (max-width:64rem) {
    .wrap { padding:0 1rem 4.5rem; }
    /* only the default moves; a dragged width is set inline and still wins */
    .layout { --side-w:13.5rem; gap:1.5rem; }
    .side-grip { right:-.8rem; }
  }

  @media (max-width:52rem) {
    .layout { grid-template-columns:minmax(0,1fr); gap:.9rem; }
    .side { position:static; }
    .side-summary { display:flex; align-items:center; gap:.55rem; cursor:pointer;
      border:1px solid var(--hair); border-radius:3px; background:var(--surface); padding:.6rem .8rem;
      font:600 .68rem/1 var(--mono); letter-spacing:.16em; text-transform:uppercase; color:var(--ink-soft); }
    .ss-chev { flex:0 0 auto; width:.4rem; height:.4rem; border-right:1.4px solid var(--ink-faint);
      border-bottom:1.4px solid var(--ink-faint); transform:rotate(-45deg); transition:transform .14s ease; }
    .ss-word { flex:1; }
    .side-toggle:checked ~ .side-summary .ss-chev { transform:rotate(45deg); }
    .side-toggle:focus-visible ~ .side-summary { outline:2px solid var(--accent); outline-offset:2px; }
    .side-inner { display:none; margin-top:.45rem; max-height:70vh; max-height:70dvh; }
    .side-toggle:checked ~ .side-inner { display:flex; }
    .item.sel { box-shadow:-.85rem 0 0 var(--accent-wash), .85rem 0 0 var(--accent-wash); }
  }

  @media (max-width:34rem) {
    body { font-size:15px; }
    .wrap { padding:0 .85rem 3.5rem; }
    .mast { flex-wrap:wrap; gap:.45rem .7rem; padding:.9rem .1rem .75rem; }
    .mast .word { letter-spacing:.22em; }
    .mast .who { flex-basis:100%; overflow-wrap:anywhere; }
    .pollbar { gap:.3rem .9rem; }
    .pb-new { flex-basis:100%; margin-left:0; }
    .toolbar { gap:.4rem; margin:.85rem 0 1.1rem; }
    .toolbar form { flex:1 1 100%; }
    .toolbar .tb-mark { flex:0 0 auto; }
    .toolbar input[type=search] { flex:1; min-width:0; }
    .toolbar input[type=url] { flex:1 1 100%; min-width:0; }
    .tb-add { margin-left:0; flex-wrap:wrap; }
    .toolbar .fpick-wrap, .toolbar .fnew { flex:1 1 7rem; width:auto; max-width:none; min-width:0; }
    .item { padding:.9rem 0 1rem .8rem; }
    .item.sel { box-shadow:-.6rem 0 0 var(--accent-wash), .6rem 0 0 var(--accent-wash); }
    .rbody p:first-of-type::first-letter { font-size:2.5rem; }
    .mhead { flex-wrap:wrap; gap:.5rem; }
    .mform { flex:1 1 100%; }
    .mform input[type=text] { flex:1 1 8rem; min-width:0; }
    .mtitle { min-width:0; }
    .mform .fpick-wrap { flex:1 1 8rem; max-width:none; }
    .mform .fnew { flex:1 1 8rem; width:auto; min-width:0; }
    .fh-form { flex-wrap:wrap; }
    .fh-form input[type=text] { flex:1; width:auto; min-width:0; }
    .fh-form .fpick-wrap { flex:1 1 8rem; max-width:none; }
    .opml-row input[type=file] { min-width:0; }
    /* Reading on a phone: the article starts at the top. The toolbar and the
       feeds disclosure are four rows of chrome you cannot use mid-article, and
       the article carries its own Back. */
    .wrap:has(.reading) .toolbar, .wrap:has(.reading) .side { display:none; }
    .wrap:has(.reading) .pollbar { margin-bottom:.2rem; }
  }

  @media (prefers-reduced-motion: reduce) { * { transition:none !important; } }

  /* ══ The register's grammar, over this reader's inherited shapes ══════════

     NO ROUNDED CORNERS. A press page rules and divides; it does not round.
     Blanket, because the shapes it flattens run to dozens across pills, badges,
     panels, dots and inputs, and that many separate zeroes is that many places
     to miss one. */
  *, *::before, *::after { border-radius: 0 !important; }
  /* The two status dots are the exception: a dot is a dot. */
  .dot, .dot.err, .dot.new { border-radius: 50% !important; }

  /* ── The three-state health machine ────────────────────────────────────
     Healthy is ink and unmarked. QUIET is ink with a 1px mark. BROKEN is the
     signal with a 2px mark. Weight and hue move together, so the pair survives
     greyscale, both dichromacies and a bad monitor, and the words 'silent' and
     'erroring' that the markup already writes carry the third channel. */
  .mrow.quiet { box-shadow: inset 1px 0 0 var(--fg-ink); padding-left:.7rem; }
  .mrow.bad   { box-shadow: inset 2px 0 0 var(--signal); padding-left:.7rem; }
  .mt-cell.quiet, .mt-cell.quiet .mt-n, .mgroup-n.quiet, .mquiet, .mitems.none,
  .merrs.quiet, .merrs.quiet .opml-label, .merrs.quiet .merr-why {
    color: var(--fg-ink);
  }
  .merrs.quiet { border-color: var(--rule-soft); }
  .mquiet, .mitems.none { font-weight:600; }

  /* ── The four brass sites that were never 'quiet' ──────────────────────
     A C-8 round found 4 of brass's 14 uses outside the semantics the channel
     was said to carry: two are scrape-feature chrome and two colour a video
     content badge. They are not diagnostics and they do not get a hue. */
  .scrape-panel { border-left-color: var(--rule-hard); }
  .sp-sel { color: var(--fg-ink); }
  .imeta .vid, .rsrc .vid {
    color: var(--fg-ink-soft); border-color: var(--rule-soft); font-weight:600;
  }

  /* ── Where you are is an ink fill, not a colour ────────────────────────
     Selection is ambient rather than something to attend to, so it spends ink
     and leaves the one red for what broke. */
  .vrow.on, .frow.on { background: var(--fg-ink); color: var(--bg-parchment); }
  .vrow.on .ct, .frow.on .ct { background: rgba(127,127,127,.28); color: var(--bg-parchment); }
  .dot.new { background: var(--fg-ink-soft); }
  .dot.err { background: var(--signal); }
  .act.on { background: var(--line-soft); color: var(--fg-ink); border-color:transparent; }

  /* Buttons: solid means ink. The signal never fills a block, which is the
     reservation stated in tokens.css and the reason it still means anything. */
  .tb-add button, .tb-mark button.primary, .fh-del button.danger,
  .mform button.primary {
    background: var(--btn-solid-bg, var(--fg-ink));
    color: var(--btn-solid-fg, var(--bg-parchment));
    border-color: transparent;
  }
  .merr-del button.danger, .mform.mdel button.danger, .fh-del > summary {
    background: none; color: var(--signal); border-color: var(--rule-soft);
  }
  .merr-del button.danger:hover, .mform.mdel button.danger:hover,
  .fh-del > summary:hover, .fh-del[open] > summary {
    border-color: var(--signal); color: var(--signal);
  }

  /* The masthead takes the site's grammar: a 2px hard rule and the label face. */
  .mast { border-bottom:2px solid var(--rule-hard); }
  .mast .word { font-family: var(--font-grot); font-variation-settings:'wdth' var(--label-wdth);
                font-weight:600; letter-spacing:.16em; }
  .mast .mark { color: var(--fg-ink); }
  .mast .date { font-family: var(--font-grot); font-variation-settings:'wdth' var(--label-wdth);
                font-weight:600; letter-spacing:.14em; }
  .devbar { background: var(--signal); color: var(--bg-parchment); }
`;

/* ── script layer (inline, nonce-gated) ─────────────────────────
   Independent enhancements, each a no-op if its markup is absent, so the page
   is still complete with the script off: keyboard control, remembering which
   folders you left open, the pull clock with its guarded refresh, the sidebar
   grip, in-place row actions, scroll memory and the Add button's busy state.
   They are listed at the foot of this block, which is the count that governs. */

const READER_JS = `(function(){
  function field(t){ return t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName); }
  var reading = document.querySelector('.reading');

  /* ── keyboard ───────────────────────────────────────────── */
  function keyboard(){
    if (reading){
      var back = reading.querySelector('[data-key="back"]');
      var open = reading.querySelector('[data-key="open"]');
      var starF = reading.querySelector('form[data-do="star"]');
      document.addEventListener('keydown', function(e){
        if (field(e.target)) return;
        if ((e.key==='Escape'||e.key==='u') && back){ location.href=back.getAttribute('href'); e.preventDefault(); }
        else if (e.key==='o' && open){ window.open(open.getAttribute('href'),'_blank','noopener'); e.preventDefault(); }
        else if (e.key==='s' && starF){ starF.requestSubmit(); e.preventDefault(); }
      });
      return;
    }
    var items = Array.prototype.slice.call(document.querySelectorAll('.item'));
    if (!items.length) return;
    var sel = -1, g = false;
    function focus(i){ sel = Math.max(0, Math.min(items.length-1, i));
      items.forEach(function(el,idx){ el.classList.toggle('sel', idx===sel); });
      items[sel].scrollIntoView({block:'nearest'}); }
    document.addEventListener('keydown', function(e){
      if (field(e.target)) return;
      if (g){ g=false; if (e.key==='u'){ location.href='/rss?view=unread'; e.preventDefault(); return; } }
      var el = sel>=0 ? items[sel] : null;
      switch(e.key){
        case 'j': focus(sel+1); e.preventDefault(); break;
        case 'k': focus(sel<0?0:sel-1); e.preventDefault(); break;
        case 'Enter': if (el){ var ru=el.getAttribute('data-read-url'); if(ru) location.href=ru; e.preventDefault(); } break;
        case 'o': if (el){ var op=el.getAttribute('data-open'); if(op) window.open(op,'_blank','noopener'); e.preventDefault(); } break;
        case 'm': if (el){ var mf=el.querySelector('form[data-do="mark-read"]'); if(mf) mf.requestSubmit(); e.preventDefault(); } break;
        case 's': if (el){ var sf=el.querySelector('form[data-do="star"]'); if(sf) sf.requestSubmit(); e.preventDefault(); } break;
        case 'r': location.reload(); break;
        case 'g': g=true; break;
      }
    });
  }

  /* ── folder memory ──────────────────────────────────────────
     Every click here is a full page load, so the checkbox state would reset on
     each navigation. Nothing is checked server-side, so this store is the only
     thing that carries an open folder across a click, and only the arrow ever
     writes to it. */
  var FKEY = 'rss.openFolders';
  function stored(){
    try { var v = JSON.parse(localStorage.getItem(FKEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch(e){ return []; }
  }
  function folders(){
    var groups = Array.prototype.slice.call(document.querySelectorAll('.fgroup[data-folder]'));
    if (!groups.length) return;
    var open = stored();
    var boxes = [];
    groups.forEach(function(g){
      var name = g.getAttribute('data-folder');
      var box = g.querySelector('.fg-toggle');
      if (!box) return;
      boxes.push({ box: box, name: name });
      if (open.indexOf(name) !== -1) box.checked = true;
      box.addEventListener('change', function(){
        var cur = stored(), i = cur.indexOf(name);
        if (box.checked && i === -1) cur.push(name);
        else if (!box.checked && i !== -1) cur.splice(i, 1);
        try { localStorage.setItem(FKEY, JSON.stringify(cur.slice(0, 300))); } catch(e){}
        label();
      });
    });

    /* Expand/collapse all. Hidden until here because it does nothing without
       script, and a dead control is worse than no control. */
    var all = document.querySelector('[data-role="all"]');
    if (!all) return;
    function anyShut(){ return boxes.some(function(b){ return !b.box.checked; }); }
    function label(){ all.textContent = anyShut() ? 'Expand all' : 'Collapse all'; }
    all.hidden = false;
    label();
    all.addEventListener('click', function(){
      var open = anyShut();                       // expand if any is shut, else collapse
      boxes.forEach(function(b){ b.box.checked = open; });
      try {
        localStorage.setItem(FKEY, JSON.stringify(open ? boxes.map(function(b){ return b.name; }).slice(0, 300) : []));
      } catch(e){}
      label();
    });
  }

  /* ── the pull clock, and the refresh it guards ──────────────
     Offsets come from the server as seconds-at-render, and elapsed time is
     measured with performance.now(), so a browser clock that disagrees with
     D1's UTC cannot skew either figure. A refresh only ever happens where it
     cannot interrupt: never in the reading view, never over a search, never
     with a keyboard selection live, never while typing, and never once you
     have scrolled into the list. Everything else surfaces as a badge. */
  function pullClock(){
    var bar = document.querySelector('.pollbar');
    if (!bar) return;
    var agoEl = bar.querySelector('[data-role="ago"]');
    var nextEl = bar.querySelector('[data-role="next"]');
    var newBtn = bar.querySelector('[data-role="new"]');
    var interval = parseInt(bar.getAttribute('data-interval'), 10) || 1200;
    var ago0 = parseInt(bar.getAttribute('data-ago'), 10);
    var next0 = parseInt(bar.getAttribute('data-next'), 10);
    var poll0 = bar.getAttribute('data-poll') || '';
    var unread0 = parseInt(bar.getAttribute('data-unread'), 10) || 0;
    var clock = (window.performance && performance.now) ? function(){ return performance.now(); } : function(){ return Date.now(); };
    var t0 = clock();
    var stopped = false, pending = false, timer = null;

    function elapsed(){ return Math.round((clock() - t0) / 1000); }
    function ago(s){ if (s < 60) return Math.max(0, s) + 's'; var m = Math.floor(s/60); if (m < 60) return m + 'm';
      var h = Math.floor(m/60); if (h < 24) return h < 6 ? h + 'h ' + (m%60) + 'm' : h + 'h'; return Math.floor(h/24) + 'd'; }
    function left(s){ s = Math.max(0, s); return Math.floor(s/60) + ':' + String(s%60).padStart(2, '0'); }
    /* A late or missed run rolls the countdown to the next boundary rather than
       running negative; the boundary is the schedule, so this self-corrects. */
    function remaining(){
      if (isNaN(next0)) return null;
      var rem = next0 - elapsed();
      while (rem <= -30) rem += interval;
      return rem;
    }
    function tick(){
      if (agoEl && !isNaN(ago0)) agoEl.textContent = ago(ago0 + elapsed()) + ' ago';
      if (nextEl){ var rem = remaining(); if (rem !== null) nextEl.textContent = rem > 0 ? '\\u2248 ' + left(rem) : 'due now'; }
    }

    /* Above 52rem the list is its own scroller and window.scrollY never moves,
       so both the pane and the document have to be near the top. */
    function atTop(){
      var pane = document.querySelector('.items');
      var paneTop = pane ? (pane.scrollTop || 0) : 0;
      var docTop = window.scrollY || document.documentElement.scrollTop || 0;
      return paneTop <= 80 && docTop <= 80;
    }
    function safeToRefresh(){
      if (reading) return false;
      if (document.querySelector('.item.sel')) return false;
      if (field(document.activeElement)) return false;
      try { if (new URLSearchParams(location.search).get('q')) return false; } catch(e){}
      return atTop();
    }
    if (newBtn) newBtn.addEventListener('click', function(){ location.reload(); });

    function check(){
      if (stopped || pending || document.hidden) return;
      pending = true;
      fetch('/api/reader/status', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
        .then(function(r){
          /* An expired Access session answers with the login page, not JSON.
             Stop rather than bounce the reader into a reload loop. */
          if (!r.ok || r.redirected || (r.headers.get('content-type') || '').indexOf('json') === -1){ stopped = true; return null; }
          return r.json();
        })
        .then(function(s){
          pending = false;
          if (!s || s.poll === null || s.poll === undefined) return;
          if (String(s.poll) === poll0) return;
          if (safeToRefresh()) { location.reload(); return; }
          if (newBtn){
            var n = (s.unread || 0) - unread0;
            newBtn.textContent = (n > 0 ? n + ' new \\u21bb' : 'New items \\u21bb');
            newBtn.hidden = false;
          }
        })
        .catch(function(){ pending = false; });
    }

    /* Poll once a minute, tightening to 20s for the six minutes after a cron
       boundary, which is when a run (roughly three minutes over 200-odd feeds)
       actually lands. */
    function schedule(){
      if (stopped) return;
      var rem = remaining();
      var due = rem !== null && (rem <= 0 || rem > interval - 360);
      clearTimeout(timer);
      timer = setTimeout(function(){ check(); schedule(); }, due ? 20000 : 60000);
    }
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) check(); });
    setInterval(tick, 1000);
    tick();
    schedule();
  }

  /* ── sidebar width ──────────────────────────────────────────
     Drag the grip, or focus it and use the arrow keys; double-click resets to
     the stylesheet's default. The width is written as an inline custom property
     on .layout, so it beats the per-breakpoint default in the stylesheet while
     the CSS clamp still bounds it against the viewport. Without script the
     sidebar simply keeps its default width. */
  function resizer(){
    var layout = document.querySelector('.layout');
    var side = document.querySelector('.side');
    var grip = document.querySelector('.side-grip');
    if (!layout || !side || !grip) return;
    var WKEY = 'rss.sideWidth', MIN = 150, MAX = 460;
    var clamp = function(px){ return Math.max(MIN, Math.min(MAX, Math.round(px))); };
    var width = function(){ return side.getBoundingClientRect().width; };
    var apply = function(px){ layout.style.setProperty('--side-w', clamp(px) + 'px'); };
    var save = function(){
      var w = Math.round(width());
      grip.setAttribute('aria-valuenow', String(w));
      try { localStorage.setItem(WKEY, String(w)); } catch(e){}
    };

    grip.setAttribute('aria-valuemin', String(MIN));
    grip.setAttribute('aria-valuemax', String(MAX));
    var saved;
    try { saved = parseInt(localStorage.getItem(WKEY) || '', 10); } catch(e){ saved = NaN; }
    if (!isNaN(saved)) apply(saved);

    var startX = 0, startW = 0, dragging = false;
    grip.addEventListener('pointerdown', function(e){
      dragging = true; startX = e.clientX; startW = width();
      try { grip.setPointerCapture(e.pointerId); } catch(err){}
      grip.classList.add('dragging');
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    grip.addEventListener('pointermove', function(e){
      if (dragging) apply(startW + (e.clientX - startX));
    });
    function endDrag(){
      if (!dragging) return;
      dragging = false;
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing');
      save();
    }
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);
    grip.addEventListener('dblclick', function(){
      layout.style.removeProperty('--side-w');
      try { localStorage.removeItem(WKEY); } catch(e){}
      grip.removeAttribute('aria-valuenow');
    });
    grip.addEventListener('keydown', function(e){
      var step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
      if (!step) return;
      apply(width() + step);
      save();
      e.preventDefault();
    });
  }

  /* ── which element actually scrolls ─────────────────────────
     Above 52rem the item list is its own scroller and the document never
     moves; below it, the document scrolls and .items does not. */
  function scroller(){
    var pane = document.querySelector('.items');
    if (pane){
      var oy = getComputedStyle(pane).overflowY;
      if (oy === 'auto' || oy === 'scroll') return pane;
    }
    return document.scrollingElement || document.documentElement;
  }

  /* ── mark read / star, in place ─────────────────────────────
     A form post is a full navigation: the screen flickers and you land back at
     the top of the list. These act on the row instead and never navigate. The
     DOM is updated first and the request follows, so the click feels immediate;
     if the request fails the row is put back and the form submits normally, so
     the no-script path is still the fallback rather than a silent failure. */
  function inPlace(){
    if (reading) return;
    document.addEventListener('submit', function(e){
      var form = e.target;
      if (!form || typeof form.matches !== 'function' || !form.matches('form[data-do]')) return;
      var card = form.closest ? form.closest('.item') : null;
      if (!card) return;                                  // toolbar forms still navigate
      e.preventDefault();
      var data = new FormData(form);
      var doing = String(data.get('do') || '');
      var to = String(data.get('state') || '') === '1';
      var undo = paint(card, form, doing, to);
      fetch(form.action, { method: 'POST', body: data, credentials: 'same-origin', redirect: 'manual',
                          headers: { 'X-Reader-Action': '1' } })
        .then(function(r){
          // 204 is the ONLY success, because it is the only answer Access cannot
          // fake. With redirect:'manual' a lapsed session's 302 to the login and
          // this endpoint's own 303 are the same opaque response, so the old
          // test (opaqueredirect, or any 2xx/3xx) counted a write that never
          // happened as a write that did: the row painted read and nothing
          // reached D1. Anything else falls through to a real form submit, which
          // lands on the Access login where it belongs.
          if (r.status === 204) return;
          throw new Error('rejected');
        })
        .catch(function(){ undo(); form.submit(); });
    });
  }

  /** Apply one action to a row and return a function that puts it back. */
  function paint(card, form, doing, to){
    var btn = form.querySelector('button');
    var state = form.querySelector('input[name="state"]');
    var before = { cls: card.className, label: btn ? btn.textContent : '', on: btn ? btn.className : '', st: state ? state.value : '' };
    if (doing === 'mark-read'){
      card.classList.toggle('read', to);
      card.classList.toggle('tick', !to);
      if (btn) btn.textContent = to ? 'Unread' : 'Mark read';
      if (state) state.value = to ? '0' : '1';
      bumpCounts(card, to ? -1 : 1);
    } else if (doing === 'star'){
      if (btn){ btn.textContent = to ? '★ Starred' : '☆ Star'; btn.classList.toggle('on', to); }
      if (state) state.value = to ? '0' : '1';
    }
    return function(){
      card.className = before.cls;
      if (btn){ btn.textContent = before.label; btn.className = before.on; }
      if (state) state.value = before.st;
      if (doing === 'mark-read') bumpCounts(card, to ? 1 : -1);
    };
  }

  /** Keep the sidebar honest. A clamped count (999+) is left alone rather than guessed at. */
  function bumpCounts(card, by){
    var feed = card.getAttribute('data-feed');
    var cells = [];
    var row = feed && document.querySelector('.frow[href*="feed=' + feed + '"] .ct');
    if (row) cells.push(row);
    var unread = document.querySelector('.vrow .ct');
    if (unread) cells.push(unread);
    cells.forEach(function(el){
      // indexOf, not a regex: this string is a template literal, and an escape
      // like \\+ inside one collapses to a bare + and yields an invalid pattern.
      var n = parseInt(el.textContent, 10);
      if (isNaN(n) || el.textContent.indexOf('+') !== -1) return;
      var next = Math.max(0, n + by);
      el.textContent = String(next);
      if (!next) el.textContent = '0';
    });
  }

  /* ── keep your place across a navigation ────────────────────
     Reading an article and coming back is a fresh GET, and the page is
     no-store, so the browser restores nothing. The list's offset is stashed
     against its own URL on the way out and put back on the way in. */
  function scrollMemory(){
    var SKEY = 'rss.scroll';
    var here = location.href.split('#')[0];
    function read(){
      try { var v = JSON.parse(sessionStorage.getItem(SKEY) || '{}'); return (v && typeof v === 'object') ? v : {}; }
      catch(e){ return {}; }
    }
    var saved = read()[here];
    if (typeof saved === 'number' && saved > 0) scroller().scrollTop = saved;
    window.addEventListener('pagehide', function(){
      var map = read();
      map[here] = scroller().scrollTop || 0;
      var keys = Object.keys(map);
      if (keys.length > 12) delete map[keys[0]];     // a handful of lists is plenty
      try { sessionStorage.setItem(SKEY, JSON.stringify(map)); } catch(e){}
    });
  }

  /* ── the Add form says it is working ────────────────────────
     Discovery fetches the URL you pasted and then guesses up to seven common
     feed paths, each with its own ten-second timeout, so ADD can sit for over a
     minute looking as though the click missed. That silence is what invites a
     second click, and two overlapping adds of one URL race the UNIQUE feed_url.
     The insert is atomic now so the race cannot fail, but the better outcome is
     not firing the second request at all. */
  function addBusy(){
    var form = document.querySelector('.tb-add');
    var first = form && form.querySelector('button[type=submit]');
    if (!first) return;
    var btn = first, label = first.textContent, timer = 0;
    function idle(){ clearTimeout(timer); btn.disabled = false; btn.textContent = label; }
    form.addEventListener('submit', function(e){
      // Whichever submit was pressed, since the two now do different things and
      // labelling the wrong one is worse than labelling none. Both carry a name
      // and value that the post needs, which is why this stays deferred a tick:
      // the browser builds the entry list at submit time and only then does the
      // button change under it.
      btn = e.submitter || first;
      label = btn.textContent;
      setTimeout(function(){
        btn.disabled = true;
        btn.textContent = btn.value === 'scrape-preview' ? 'Reading…' : 'Adding…';
        // Abandoning the navigation (Stop, or Escape) fires no event of its own,
        // and a button left disabled blocks the retry as well as the click.
        // Escape is the cheap direct signal; the timer covers the rest, set past
        // the worst discovery can take rather than interrupting a slow one.
        clearTimeout(timer);
        timer = setTimeout(idle, 95000);
      }, 0);
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && btn.disabled) idle();
    });
    // A restored page must not come back holding a dead button either.
    window.addEventListener('pageshow', function(e){ if (e.persisted) idle(); });
  }

  keyboard(); folders(); pullClock(); resizer(); inPlace(); scrollMemory(); addBusy();
})();`;

// Dial-and-index mark, in a mid steel-blue that reads on light and dark tabs.
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#4A6DA8" stroke-width="1.7"/><circle cx="12" cy="12" r="1.9" fill="#4A6DA8"/><path d="M12 12 15.4 8.6" stroke="#4A6DA8" stroke-width="1.7" stroke-linecap="round"/></svg>',
  );

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function page(body: string, dev: boolean): Response {
  const n = nonce();
  const doc = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${FAVICON}">
<title>Reader</title>
<style>${STYLE}</style>
</head>
<body>
${dev ? '<div class="devbar">Local dev — Cloudflare Access is NOT enforcing identity here</div>' : ''}
${body}
<script nonce="${n}">${READER_JS}</script>
</body>
</html>`;
  return new Response(doc, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // connect-src is the auto-refresh probe to /api/reader/status and nothing
      // else; default-src 'none' would otherwise block it along with everything.
      // font-src 'self' added 23 August 2026 with the register: the page now
      // self-hosts two faces from /fonts/, and under default-src 'none' the
      // browser refuses them silently while getComputedStyle still reports the
      // family name. Same-origin fonts only; nothing else widened.
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${n}'; style-src 'unsafe-inline'; font-src 'self'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/* ── scrape preview (a page with no feed) ───────────────────── */

/**
 * The panel the Add form falls through to when a URL has no feed: fetch the
 * page, guess how its list is built, and show what each guess would actually
 * produce. Nothing is stored until a guess is chosen, and the samples are the
 * page's own text, escaped like any other ingested string (C-12: it is data).
 */
async function scrapePreview(target: string, folders: string[], back: string, forced: boolean): Promise<string> {
  if (!/^https?:\/\//i.test(target)) return '';
  const { html, error } = await fetchPageHtml(target);
  if (!html) {
    return `<div class="flash err">${
      forced ? `<strong>${esc(target)}</strong> could not be read` : `No feed at <strong>${esc(target)}</strong>, and it cannot be scraped either`
    }: ${esc(error)}</div>`;
  }

  // Contained for the same reason fetchScrape is: a page that breaks the
  // extractor must not take the whole reader down with it.
  let suggestions: ReturnType<typeof suggestRules>;
  try {
    suggestions = suggestRules(html, target);
  } catch (err) {
    return `<div class="flash err">No feed at <strong>${esc(target)}</strong>, and the page could not be read as a list: ${esc(String(err))}</div>`;
  }
  if (!suggestions.length) {
    return `<div class="flash err">${
      forced ? `Nothing on <strong>${esc(target)}</strong>` : `No feed at <strong>${esc(target)}</strong>, and nothing on the page`
    } reads as a list of articles (a repeated block of linked headlines). Nothing was stored.</div>`;
  }

  const cards = suggestions
    .map((s, i) => {
      const sample = s.sample
        .map((it) => `<li>${esc(it.title || it.url)}${it.publishedAt ? ` <span class="sp-when">${esc(it.publishedAt.slice(0, 10))}</span>` : ''}</li>`)
        .join('');
      return `<form class="sp-card" method="post" action="/api/reader/action">
        <input type="hidden" name="do" value="add-scrape">
        <input type="hidden" name="url" value="${esc(target)}">
        <input type="hidden" name="rule" value="${esc(JSON.stringify(s.rule))}">
        <input type="hidden" name="return" value="${esc(back)}">
        <div class="sp-head"><span class="sp-sel">${esc(s.rule.item)}</span>
          <span class="sp-n">${s.sample.length}${s.sample.length === 5 ? '+' : ''} item${s.sample.length === 1 ? '' : 's'}</span></div>
        <ol class="sp-list">${sample}</ol>
        ${folderPicker(folders, '', `spf${i}`)}
        <button type="submit">Use this</button>
      </form>`;
    })
    .join('');

  return `<section class="scrape-panel">
    <p class="sp-intro">${
      forced
        ? `Building a feed from <strong>${esc(target)}</strong> itself, ignoring any feed it publishes.`
        : `No feed at <strong>${esc(target)}</strong>.`
    } These are the lists found on the page;
      choose the one that matches its articles, or ignore this and nothing is stored.</p>
    ${cards}
  </section>`;
}

/* ── handler ────────────────────────────────────────────────── */

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  // The reader has its own Access application; fall back to the studio AUD
  const auth = await requireOwner(request, env);
  if (!auth.ok) return auth.response;

  const db = env.READER_DB;
  const p = new URL(request.url).searchParams;
  const nowMs = Date.now();

  const flash = (() => {
    const added = p.get('added');
    if (added) return `<div class="flash">Added <strong>${esc(added)}</strong>. New items appear after the next poll.</div>`;
    const err = p.get('err');
    if (err) return `<div class="flash err">${esc(err)}</div>`;
    const msg = p.get('msg');
    if (msg) return `<div class="flash">${esc(msg)}</div>`;
    return '';
  })();

  const [feedsRes, unreadRes, lastRun] = await Promise.all([
    db.prepare('SELECT id, title, feed_url, site_url, folder, last_status, last_error FROM feeds ORDER BY LOWER(title), feed_url').all<FeedRow>(),
    db.prepare('SELECT feed_id, COUNT(*) AS n FROM items WHERE is_read = 0 GROUP BY feed_id').all<{ feed_id: number; n: number }>(),
    // poll_runs may be absent on an unmigrated database (the /studio Reader
    // panel tolerates the same); the pull clock then reads 'no pull recorded'
    // rather than the page failing.
    db.prepare('SELECT id, started_at, finished_at FROM poll_runs ORDER BY id DESC LIMIT 1').first<PollRun>().catch(() => null),
  ]);
  const feeds = feedsRes.results ?? [];
  const unread = new Map<number, number>((unreadRes.results ?? []).map((r) => [r.feed_id, r.n]));

  // ?scrape=<url> arrives from a failed add. The return path is this page
  // without the one-shot parameters, so choosing a rule lands you back on the
  // list you were reading rather than on the preview again.
  const scrapeTarget = p.get('scrape');
  const scrapeBack = (() => {
    const u = new URL(request.url);
    for (const k of ['scrape', 'via', 'err', 'msg', 'added']) u.searchParams.delete(k);
    return u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '');
  })();
  const scrapePanel = scrapeTarget ? await scrapePreview(scrapeTarget, folderList(feeds), scrapeBack, p.get('via') === 'page') : '';

  const shell = (inner: string, view: View, activeFeed: number | null, activeFolder: string | null, q: string, back = '') => `
<div class="wrap">
  <header class="mast">
    <svg class="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" stroke-width="1.5"/>
      <circle cx="12" cy="12" r="1.7" fill="currentColor"/>
      <path d="M12 4.4V6.6M12 17.4V19.6M4.4 12H6.6M17.4 12H19.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M12 12 15.3 8.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <span class="word">Reader</span>
    <span class="date">${esc(mastheadDate(nowMs))}</span>
    <span class="who">${esc(auth.email)}</span>
  </header>
  ${pollBar(lastRun, nowMs, [...unread.values()].reduce((a, b) => a + b, 0))}
  ${flash}
  ${scrapePanel}
  ${toolbar(view, activeFeed, activeFolder, q, feeds, back)}
  <div class="layout">
    ${feedSidebar(feeds, unread, view, activeFeed, activeFolder)}
    <main class="items">${inner}</main>
  </div>
  <footer>Private reader · not indexed</footer>
</div>`;

  // Manage-feeds view. The per-feed item totals are queried only here: they are
  // what makes a silent feed visible, and nothing else on the site needs them.
  if (p.get('manage') === '1') {
    const heldRes = await db
      .prepare('SELECT feed_id, COUNT(*) AS n FROM items GROUP BY feed_id')
      .all<{ feed_id: number; n: number }>();
    const held = new Map<number, number>((heldRes.results ?? []).map((r) => [r.feed_id, r.n]));
    // Manage is the one view where the premise behind the Add form's return
    // fails: a feed appears in this list the moment it is subscribed, items or
    // not, so this is the page that actually shows you what you just added.
    return page(shell(manageView(feeds, unread, held), 'all', null, null, '', '/rss?manage=1'), auth.dev);
  }

  // Single-item reading view. Marks the item read on open (with a read_at stamp).
  const itemId = parseInt(p.get('item') ?? '', 10);
  if (Number.isFinite(itemId) && itemId > 0) {
    const it = await db
      .prepare(`SELECT ${ITEM_COLS} FROM items JOIN feeds ON feeds.id = items.feed_id WHERE items.id = ?`)
      .bind(itemId)
      .first<ItemRow>();
    if (!it) return page(shell('<div class="empty">That item was not found.</div>', 'unread', null, null, ''), auth.dev);
    if (!it.is_read) {
      await db.prepare("UPDATE items SET is_read = 1, read_at = datetime('now') WHERE id = ?").bind(itemId).run();
      const cur = unread.get(it.feed_id) ?? 0;
      if (cur > 0) unread.set(it.feed_id, cur - 1);
    }
    const ret = p.get('return') && p.get('return')!.startsWith('/rss') ? p.get('return')! : '/rss';
    return page(shell(itemView(it, ret, nowMs), 'unread', it.feed_id, null, '', ret), auth.dev);
  }

  // List view.
  const viewParam = p.get('view');
  const view: View = viewParam === 'all' || viewParam === 'starred' ? viewParam : 'unread';
  const feedParam = parseInt(p.get('feed') ?? '', 10);
  const activeFeed = Number.isFinite(feedParam) && feedParam > 0 ? feedParam : null;
  const activeFolder = (p.get('folder') ?? '').trim().slice(0, 100) || null;
  const q = (p.get('q') ?? '').trim().slice(0, 120);
  const pageNum = Math.max(0, parseInt(p.get('page') ?? '0', 10) || 0);
  const offset = pageNum * PAGE_SIZE;

  const ret = '/rss?' + new URLSearchParams({ view, ...(activeFeed !== null ? { feed: String(activeFeed) } : {}), ...(activeFolder !== null ? { folder: activeFolder } : {}), ...(q ? { q } : {}), ...(pageNum ? { page: String(pageNum) } : {}) }).toString();

  let rows: ItemRow[];
  let totalCount: number;
  const match = q ? ftsQuery(q) : '';

  if (q && match) {
    const where = ['items_fts MATCH ?'];
    const binds: unknown[] = [match];
    if (activeFeed !== null) {
      where.push('items.feed_id = ?');
      binds.push(activeFeed);
    } else if (activeFolder !== null) {
      where.push('items.feed_id IN (SELECT id FROM feeds WHERE folder = ?)');
      binds.push(activeFolder);
    }
    const whereSql = where.join(' AND ');
    const [listRes, countRes] = await Promise.all([
      db
        .prepare(
          `SELECT ${ITEM_COLS} FROM items_fts JOIN items ON items.id = items_fts.rowid
           JOIN feeds ON feeds.id = items.feed_id WHERE ${whereSql} ORDER BY rank LIMIT ? OFFSET ?`,
        )
        .bind(...binds, PAGE_SIZE, offset)
        .all<ItemRow>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM items_fts JOIN items ON items.id = items_fts.rowid WHERE ${whereSql}`)
        .bind(...binds)
        .first<{ n: number }>(),
    ]);
    rows = listRes.results ?? [];
    totalCount = countRes?.n ?? 0;
  } else {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (view === 'unread') where.push('items.is_read = 0');
    else if (view === 'starred') where.push('items.is_starred = 1');
    if (activeFeed !== null) {
      where.push('items.feed_id = ?');
      binds.push(activeFeed);
    } else if (activeFolder !== null) {
      where.push('items.feed_id IN (SELECT id FROM feeds WHERE folder = ?)');
      binds.push(activeFolder);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [listRes, countRes] = await Promise.all([
      db
        .prepare(
          // items.id breaks the tie. `fetched_at` has second granularity, so a
          // whole batch of dateless items (every scraped page, and any feed
          // publishing several posts under one date) shares a sort key; without
          // a tiebreaker their order is unspecified, which also makes OFFSET
          // paging over them able to skip or repeat a row. The poller inserts
          // oldest first, so the higher id is the newer item.
          `SELECT ${ITEM_COLS} FROM items JOIN feeds ON feeds.id = items.feed_id ${whereSql}
           ORDER BY COALESCE(items.published_at, items.fetched_at) DESC, items.id DESC LIMIT ? OFFSET ?`,
        )
        .bind(...binds, PAGE_SIZE, offset)
        .all<ItemRow>(),
      db.prepare(`SELECT COUNT(*) AS n FROM items ${whereSql}`).bind(...binds).first<{ n: number }>(),
    ]);
    rows = listRes.results ?? [];
    totalCount = countRes?.n ?? 0;
  }

  let inner: string;
  if (!feeds.length) {
    inner = '<div class="empty">No feeds yet. Paste an RSS feed or a site URL in the box above to subscribe.</div>';
  } else if (!rows.length) {
    const what = q ? `No articles match “${esc(q)}”.` : view === 'unread' ? 'Nothing unread. All caught up.' : 'No articles here yet.';
    inner = `<div class="empty">${what}</div>`;
  } else {
    inner = rows.map((it) => itemCard(it, ret, nowMs)).join('');
    const hasPrev = pageNum > 0;
    const hasNext = offset + rows.length < totalCount;
    if (hasPrev || hasNext) {
      const pageLink = (nn: number, label: string) =>
        `<a href="/rss?${new URLSearchParams({ view, ...(activeFeed !== null ? { feed: String(activeFeed) } : {}), ...(activeFolder !== null ? { folder: activeFolder } : {}), ...(q ? { q } : {}), page: String(nn) }).toString()}">${label}</a>`;
      inner += `<div class="pager">${hasPrev ? pageLink(pageNum - 1, '‹ Newer') : '<span></span>'}${
        hasNext ? pageLink(pageNum + 1, 'Older ›') : '<span></span>'
      }</div>`;
    }
  }

  const activeFeedRow = activeFeed !== null ? feeds.find((f) => f.id === activeFeed) ?? null : null;
  if (activeFeedRow) inner = feedHeader(activeFeedRow, ret, folderList(feeds)) + inner;
  else if (activeFolder !== null) inner = folderHeader(activeFolder, feeds, unread) + inner;

  return page(shell(inner, view, activeFeed, activeFolder, q, ret), auth.dev);
};
