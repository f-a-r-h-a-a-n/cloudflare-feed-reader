/**
 * Feed fetching, discovery and parsing for the /rss reader (July 2026).
 *
 * Shared by two workerd runtimes: the Pages Functions under functions/api/reader/*
 * (add-feed discovery) and the companion feed-poller Worker (scheduled polls).
 * It stays dependency-light on purpose — fast-xml-parser plus the platform
 * fetch/URL, no DOM and no Node built-ins — so the same file bundles in both.
 *
 * parseFeed normalises RSS 2.0, RSS 1.0/RDF, Atom and JSON Feed into one shape.
 * Nothing here writes to the database or renders HTML: callers sanitise on the
 * way out (the reader strips tags before display, under a strict CSP).
 *
 * The leading `_` keeps this directory off the Pages Functions router; it is an
 * importable library, not a route.
 */
import { XMLParser } from 'fast-xml-parser';
import { YOUTUBE_FEED_MARKER } from './youtube';
import { DEFAULT_UA } from './config';

export interface ParsedItem {
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  summary: string | null;
  content: string | null;
  publishedAt: string | null; // ISO 8601, or null when unparseable
}

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  items: ParsedItem[];
}

const UA = DEFAULT_UA;
const ACCEPT = 'application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5';
const FETCH_TIMEOUT_MS = 10_000; // abort a hanging feed/discovery fetch

/** fetch with a hard timeout, so one slow host cannot stall the sequential poll. */
function tfetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

/* ── value coercion ─────────────────────────────────────────────
 * fast-xml-parser yields a string, a number, or an object of the shape
 * { '#text': ..., '@_attr': ... }. These helpers flatten all three safely. */

function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return text(o['#text']);
  }
  return '';
}

function arr<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function toISO(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const t = Date.parse(s); // handles RFC-822 (RSS pubDate) and ISO-8601 (Atom)
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Stable fallback id (djb2) for feeds that ship no guid and no link. */
function hashGuid(...parts: string[]): string {
  const s = parts.join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `h:${h.toString(16)}`;
}

/**
 * One item's stable identity, in falling order of trust: the feed's own id, then
 * its link, then a hash of title and publication DAY.
 *
 * Two rules here were bought with a month of a silently broken feed, both
 * measured 24 August 2026 against Google Trends.
 *
 * A <link> identical to the channel's own link is a pointer back at the feed,
 * not an item identifier. Trends gives every item the feed's own URL, so the
 * link fallback collapsed all ten items to one id and the archive kept exactly
 * one row from 26 July to 24 August.
 *
 * The hash keys on the publication DAY rather than the timestamp, because a feed
 * that ships no id and no usable link is usually generating its dates too.
 * Trends buckets every item's pubDate to the snapshot's own time: fetches thirty
 * minutes apart returned 06:40 and then 07:10 for a wholly different topic set.
 * Keying on the full timestamp would have minted a fresh id on nearly every
 * poll, turning one row a month into hundreds a week, each immune to
 * INSERT OR IGNORE. Day granularity keys a trending topic once per day, which is
 * what a demand signal means, and only ever merges items sharing both a title
 * and a date, which is dedup rather than loss.
 */
function itemGuid(
  rawGuid: string,
  link: string,
  channelLink: string,
  title: string,
  when: string,
): string {
  if (rawGuid) return rawGuid;
  if (link && link !== channelLink) return link;
  const iso = toISO(when);
  return hashGuid(title, iso ? iso.slice(0, 10) : when);
}

/* ── format-specific parsers ────────────────────────────────── */

function atomLink(link: unknown, rel?: string): string | null {
  const links = arr(link as any);
  if (!links.length) return null;
  const chosen =
    (rel ? links.find((l: any) => (l?.['@_rel'] ?? 'alternate') === rel) : undefined) ?? links[0];
  if (typeof chosen === 'string') return chosen;
  return text(chosen?.['@_href']) || null;
}

function parseRss(channel: any): ParsedFeed {
  const channelLink = text(channel.link);
  const items = arr(channel.item).map((it: any): ParsedItem => {
    const link = text(it.link) || atomLink(it['atom:link'], 'alternate');
    const guid = itemGuid(text(it.guid), link ?? '', channelLink, text(it.title), text(it.pubDate));
    return {
      guid,
      url: link || null,
      title: text(it.title),
      author: text(it['dc:creator']) || text(it.author) || null,
      summary: text(it.description) || null,
      content: text(it['content:encoded']) || null,
      publishedAt: toISO(text(it.pubDate) || text(it['dc:date'])),
    };
  });
  return { title: text(channel.title), siteUrl: text(channel.link) || null, items };
}

function parseAtom(feed: any): ParsedFeed {
  const feedLink = atomLink(feed.link, 'alternate') || atomLink(feed.link);
  const items = arr(feed.entry).map((e: any): ParsedItem => {
    const link = atomLink(e.link, 'alternate') || atomLink(e.link);
    const guid = itemGuid(text(e.id), link ?? '', feedLink ?? '', text(e.title), text(e.updated));
    const mediaGroup = e['media:group'];
    return {
      guid,
      url: link || null,
      title: text(e.title) || text(mediaGroup?.['media:title']),
      author: text(e.author?.name) || null,
      summary: text(e.summary) || text(mediaGroup?.['media:description']) || null,
      content: text(e.content) || null,
      publishedAt: toISO(text(e.published) || text(e.updated)),
    };
  });
  return { title: text(feed.title), siteUrl: feedLink, items };
}

function parseRdf(rdf: any): ParsedFeed {
  const channel = rdf.channel ?? {};
  const channelLink = text(channel.link);
  const items = arr(rdf.item).map((it: any): ParsedItem => {
    const link = text(it.link);
    const guid = itemGuid(text(it['@_rdf:about']), link, channelLink, text(it.title), text(it['dc:date']));
    return {
      guid,
      url: link || null,
      title: text(it.title),
      author: text(it['dc:creator']) || null,
      summary: text(it.description) || null,
      content: text(it['content:encoded']) || null,
      publishedAt: toISO(text(it['dc:date'])),
    };
  });
  return { title: text(channel.title), siteUrl: text(channel.link) || null, items };
}

function parseJsonFeed(feed: any): ParsedFeed {
  const items = arr(feed.items).map((it: any): ParsedItem => {
    const url = it.url ?? it.external_url ?? null;
    const guid = String(it.id ?? url ?? hashGuid(String(it.title ?? ''), String(it.date_published ?? '')));
    return {
      guid,
      url,
      title: String(it.title ?? ''),
      author: it.author?.name ?? feed.author?.name ?? null,
      summary: it.summary ?? null,
      content: it.content_html ?? it.content_text ?? null,
      publishedAt: it.date_published ? toISO(String(it.date_published)) : null,
    };
  });
  return { title: String(feed.title ?? ''), siteUrl: feed.home_page_url ?? null, items };
}

/** Normalise any supported feed body into a ParsedFeed. */
export function parseFeed(body: string, contentType = ''): ParsedFeed {
  const trimmed = body.trimStart();
  if (contentType.includes('json') || trimmed.startsWith('{')) {
    try {
      return parseJsonFeed(JSON.parse(body));
    } catch {
      /* not JSON after all; fall through to XML */
    }
  }
  const doc = parser.parse(body) as Record<string, any>;
  if (doc.rss?.channel) return parseRss(doc.rss.channel);
  if (doc.feed) return parseAtom(doc.feed);
  const rdf = doc['rdf:RDF'] ?? doc.RDF;
  if (rdf) return parseRdf(rdf);
  return { title: '', siteUrl: null, items: [] };
}

/* ── discovery (given a site URL, find its feed) ────────────── */

export interface Discovered {
  feedUrl: string;
  title: string;
  siteUrl: string | null;
}

const FEED_TYPES = ['application/rss+xml', 'application/atom+xml', 'application/feed+json', 'application/json'];
const COMMON_PATHS = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/feed/'];

function looksLikeFeed(body: string, contentType: string): boolean {
  // Strip a UTF-8 BOM before sniffing: a BOM'd feed parses fine, so rejecting
  // it here would turn a working feed into a hard error (fetchFeed gates on this).
  const t = body.replace(/^\uFEFF/, '').trimStart();
  if (contentType.includes('json') && t.startsWith('{')) return true;
  if (/^<\?xml|^<rss\b|^<feed\b|^<rdf:RDF\b/i.test(t)) return true;
  return /application\/(rss|atom|feed)\+|(^|\/)xml/i.test(contentType);
}

/**
 * The five XML predefined entities, enough for an href in a <link> tag.
 * `&amp;` is decoded last, so `&amp;lt;` yields `&lt;` rather than `<`.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&(?:#60|#x3c|lt);/gi, '<')
    .replace(/&(?:#62|#x3e|gt);/gi, '>')
    .replace(/&(?:#34|#x22|quot);/gi, '"')
    .replace(/&(?:#39|#x27|apos);/gi, "'")
    .replace(/&(?:#38|#x26|amp);/gi, '&');
}

function findFeedLinkInHtml(html: string, baseUrl: string): string | null {
  const head = html.slice(0, 200_000); // feed <link>s are declared in <head>
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel\s*=\s*['"]?[^'">]*alternate/i.test(tag)) continue;
    const type = (tag.match(/type\s*=\s*['"]([^'"]+)['"]/i)?.[1] ?? '').toLowerCase();
    if (!FEED_TYPES.includes(type)) continue;
    const href = tag.match(/href\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (!href) continue;
    try {
      // An href is HTML, so its query separators arrive escaped: a raw
      // `?format=feed&amp;type=rss` would be stored, and fetched, verbatim.
      return new URL(decodeHtmlEntities(href), baseUrl).href;
    } catch {
      continue;
    }
  }
  return null;
}

async function tryCommonPaths(baseUrl: string): Promise<Discovered | null> {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return null;
  }
  for (const p of COMMON_PATHS) {
    const u = origin + p;
    try {
      const r = await tfetch(u, { headers: { 'User-Agent': UA, Accept: ACCEPT } });
      if (!r.ok) continue;
      const b = await r.text();
      if (looksLikeFeed(b, r.headers.get('content-type') ?? '')) {
        const parsed = parseFeed(b, r.headers.get('content-type') ?? '');
        return { feedUrl: r.url || u, title: parsed.title, siteUrl: parsed.siteUrl };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/* ── YouTube ─────────────────────────────────────────────────── */

/**
 * Pull a channel's OWN id from its page HTML. Order matters: `externalId` and the
 * canonical /channel/ link identify the page's channel, whereas a bare
 * `"channelId"` often belongs to a recommended channel in the sidebar, so it is
 * the last resort.
 */
export function extractYouTubeChannelId(html: string): string | null {
  return (
    html.match(/"externalId":"(UC[\w-]{20,})"/)?.[1] ??
    html.match(/rel="canonical"[^>]*href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{20,})"/)?.[1] ??
    html.match(/\/feeds\/videos\.xml\?channel_id=(UC[\w-]{20,})/)?.[1] ??
    html.match(/itemprop="(?:channelId|identifier)"\s+content="(UC[\w-]{20,})"/)?.[1] ??
    html.match(/"channelId":"(UC[\w-]{20,})"/)?.[1] ??
    null
  );
}

/**
 * Resolve a YouTube channel URL (/channel/UC…, /@handle, /c/…, /user/…) to its
 * uploads Atom feed. Returns null for non-YouTube or unresolvable URLs so the
 * caller falls through to ordinary discovery.
 */
async function resolveYouTubeChannel(inputUrl: string): Promise<Discovered | null> {
  let host: string;
  try {
    host = new URL(inputUrl).hostname.replace(/^www\.|^m\./, '');
  } catch {
    return null;
  }
  if (host !== 'youtube.com') return null;
  // Already a channel-uploads feed URL: let ordinary discovery handle it (avoids
  // fetching it twice).
  if (inputUrl.includes(YOUTUBE_FEED_MARKER)) return null;

  let channelId = inputUrl.match(/\/channel\/(UC[\w-]{20,})/)?.[1] ?? null;
  if (!channelId) {
    // /@handle, /c/Name, /user/Name: the channel id is embedded in the page HTML.
    try {
      const r = await tfetch(inputUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
      if (r.ok) channelId = extractYouTubeChannelId(await r.text());
    } catch {
      /* fall through */
    }
  }
  if (!channelId) return null;

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const fr = await tfetch(feedUrl, { headers: { 'User-Agent': UA, Accept: ACCEPT } });
    if (fr.ok) {
      const parsed = parseFeed(await fr.text(), fr.headers.get('content-type') ?? '');
      return { feedUrl, title: parsed.title, siteUrl: parsed.siteUrl ?? inputUrl };
    }
  } catch {
    /* fall through to the bare feed URL */
  }
  return { feedUrl, title: '', siteUrl: inputUrl };
}

/**
 * Resolve a user-supplied URL to a subscribable feed: a YouTube channel's
 * uploads feed, the URL itself if it is already a feed, the feed declared in the
 * page's <head>, otherwise a common-path guess. Throws when nothing is found.
 */
export async function discoverFeed(inputUrl: string): Promise<Discovered> {
  const yt = await resolveYouTubeChannel(inputUrl);
  if (yt) return yt;

  const res = await tfetch(inputUrl, { headers: { 'User-Agent': UA, Accept: ACCEPT }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not fetch ${inputUrl} (HTTP ${res.status}).`);
  const ct = res.headers.get('content-type') ?? '';
  const body = await res.text();

  if (looksLikeFeed(body, ct)) {
    const parsed = parseFeed(body, ct);
    return { feedUrl: res.url || inputUrl, title: parsed.title, siteUrl: parsed.siteUrl };
  }

  const linked = findFeedLinkInHtml(body, res.url || inputUrl);
  if (linked) {
    try {
      const fr = await tfetch(linked, { headers: { 'User-Agent': UA, Accept: ACCEPT } });
      if (fr.ok) {
        const fb = await fr.text();
        const parsed = parseFeed(fb, fr.headers.get('content-type') ?? '');
        return { feedUrl: fr.url || linked, title: parsed.title, siteUrl: parsed.siteUrl ?? inputUrl };
      }
    } catch {
      /* fall through: return the discovered URL without a pre-read title */
    }
    return { feedUrl: linked, title: '', siteUrl: inputUrl };
  }

  const guessed = await tryCommonPaths(res.url || inputUrl);
  if (guessed) return guessed;

  throw new Error('No RSS, Atom or JSON feed was found at that address.');
}

/* ── polling (conditional GET for the poller Worker) ────────── */

export interface FetchResult {
  status: 'ok' | 'not-modified' | 'error';
  etag: string | null;
  lastModified: string | null;
  feedTitle: string | null;
  siteUrl: string | null;
  items: ParsedItem[];
  error?: string;
}

/**
 * Per-feed request-header overrides. A few hosts reject the shared defaults:
 * METI answers our feed user-agent with 403 and Eurostat answers our Accept
 * list with 406, both verified 24 August 2026. Overriding per feed keeps the
 * honest default user-agent on every other feed.
 */
export interface FetchOverrides {
  userAgent?: string | null;
  accept?: string | null;
}

/** Fetch a feed with conditional-GET headers and parse it. Never throws. */
export async function fetchFeed(
  feedUrl: string,
  etag: string | null,
  lastModified: string | null,
  overrides?: FetchOverrides,
): Promise<FetchResult> {
  const empty = { etag, lastModified, feedTitle: null, siteUrl: null, items: [] };
  const headers: Record<string, string> = {
    'User-Agent': overrides?.userAgent || UA,
    Accept: overrides?.accept || ACCEPT,
  };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  let res: Response;
  try {
    res = await tfetch(feedUrl, { headers, redirect: 'follow' });
  } catch (err) {
    return { status: 'error', ...empty, error: `Network error: ${String(err)}` };
  }
  if (res.status === 304) return { status: 'not-modified', ...empty };
  if (!res.ok) return { status: 'error', ...empty, error: `HTTP ${res.status}` };

  const body = await res.text();
  const contentType = res.headers.get('content-type') ?? '';

  // A 200 carrying something that is not a feed at all (a bot-challenge page, an
  // HTML 404 body) parses without throwing and yields no items, which is
  // indistinguishable from a healthy feed that happens to be quiet. Fail loudly.
  // The nulled validators matter as much as the status: keeping the old ones
  // would let the next poll get a 304 for a body we just rejected, and 'not-
  // modified' reports healthy without ever reading a body again.
  if (!looksLikeFeed(body, contentType)) {
    return {
      status: 'error',
      ...empty,
      etag: null,
      lastModified: null,
      error: `Response was not a feed (HTTP ${res.status}, ${contentType || 'no content-type'})`,
    };
  }

  let parsed: ParsedFeed;
  try {
    parsed = parseFeed(body, contentType);
  } catch (err) {
    return { status: 'error', ...empty, etag: null, lastModified: null, error: `Parse error: ${String(err)}` };
  }
  return {
    status: 'ok',
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    feedTitle: parsed.title || null,
    siteUrl: parsed.siteUrl,
    items: parsed.items,
  };
}

/* ── OPML import (bring feeds over from another reader) ──────── */

export interface OpmlFeed {
  feedUrl: string;
  title: string;
  siteUrl: string | null;
  folder: string | null;
}

/**
 * Flatten an OPML document to its subscribable feeds. Container outlines (no
 * xmlUrl) become the folder label for the feeds nested beneath them; feed
 * outlines carry xmlUrl (the feed) and usually htmlUrl (the site) and text.
 */
export function parseOpml(xml: string): OpmlFeed[] {
  const doc = parser.parse(xml) as any;
  const body = doc?.opml?.body;
  if (!body) return [];
  const out: OpmlFeed[] = [];
  const walk = (node: any, folder: string | null): void => {
    for (const o of arr(node?.outline)) {
      const xmlUrl = o?.['@_xmlUrl'] ?? o?.['@_xmlurl'];
      const label = String(o?.['@_title'] ?? o?.['@_text'] ?? '');
      if (xmlUrl) {
        const htmlUrl = o?.['@_htmlUrl'] ?? o?.['@_htmlurl'];
        out.push({ feedUrl: String(xmlUrl), title: label, siteUrl: htmlUrl ? String(htmlUrl) : null, folder });
      }
      if (o?.outline) walk(o, xmlUrl ? folder : label || folder);
    }
  };
  walk(body, null);
  return out;
}
