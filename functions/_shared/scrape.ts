/**
 * Scrape-to-feed for the /rss reader (August 2026): build a feed from a page
 * that publishes none.
 *
 * Shared by the same two workerd runtimes as feed.ts, and by the Node
 * verification harness, which is why the HTML is parsed here rather than with
 * the platform's HTMLRewriter: HTMLRewriter exists in workerd and not in Node,
 * so using it would mean the shipped extractor and the tested extractor were two
 * different pieces of code. The parser below is deliberately small and covers
 * only what a list page needs: elements, attributes, comments and raw-text
 * elements. It never executes anything and never renders; callers escape on the
 * way out, as they already do for feed content.
 *
 * A scraped page is ingested content (CONSTITUTION C-12): text pulled out of it
 * is data, never instruction, and nothing harvested here reaches a shell.
 */
import type { ParsedItem, FetchResult } from './feed';
import { DEFAULT_UA } from './config';

/** A stored extraction rule. Selectors after `item` are resolved inside it. */
export interface ScrapeRule {
  item: string;
  title?: string;
  link?: string;
  date?: string;
  summary?: string;
}

const UA = DEFAULT_UA;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 4_000_000;
const MAX_ITEMS = 100; // matches the reader's RETAIN_PER_FEED: storing more only churns
const MAX_TITLE = 300;
const MAX_SUMMARY = 2_000;
const MAX_SELECTOR = 200;

/* ── the parser ─────────────────────────────────────────────── */

interface El {
  tag: string;
  id: string | null;
  classes: string[];
  attrs: Record<string, string>;
  children: El[];
  start: number; // index of '<' on the open tag
  openEnd: number; // index just after the open tag's '>'
  closeStart: number; // index of '<' on the close tag, or openEnd when there is none
  end: number; // index just after the close tag, or openEnd
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/**
 * Implied end tags, the subset browsers apply. Without these, a page whose
 * paragraphs or list items are never closed (ordinary hand-written HTML) nests
 * one level per element, and a few thousand of them overflow the stack in the
 * recursive walks below rather than parsing.
 */
const CLOSES_OPEN: Record<string, string[]> = {
  p: ['p'],
  li: ['li'],
  option: ['option'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  dd: ['dd', 'dt'],
  dt: ['dd', 'dt'],
};

function newEl(tag: string, start: number): El {
  return { tag, id: null, classes: [], attrs: {}, children: [], start, openEnd: start, closeStart: start, end: start };
}

/** Read an open tag's attributes. Quoted values may contain '>' and often do. */
function readAttrs(html: string, from: number): { attrs: Record<string, string>; end: number; selfClosing: boolean } {
  const attrs: Record<string, string> = {};
  let i = from;
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] === '>') return { attrs, end: i + 1, selfClosing: false };
    if (html[i] === '/' && html[i + 1] === '>') return { attrs, end: i + 2, selfClosing: true };
    const nameStart = i;
    while (i < html.length && !/[\s=/>]/.test(html[i])) i++;
    const name = html.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] !== '=') {
      attrs[name] = '';
      continue;
    }
    i++;
    while (i < html.length && /\s/.test(html[i])) i++;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      const stop = close === -1 ? html.length : close;
      attrs[name] = html.slice(i + 1, stop);
      i = stop + 1;
    } else {
      const valStart = i;
      while (i < html.length && !/[\s>]/.test(html[i])) i++;
      attrs[name] = html.slice(valStart, i);
    }
  }
  return { attrs, end: i, selfClosing: false };
}

/**
 * Build a tree. Unclosed tags are closed implicitly by an ancestor's close tag,
 * which is what browsers do and what real pages need: a list of <li>s without
 * close tags is common and must still yield one node per item.
 */
function parseHtml(html: string): El {
  const root = newEl('#root', 0);
  root.openEnd = 0;
  root.closeStart = html.length;
  root.end = html.length;
  const stack: El[] = [root];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const next = html[lt + 1];

    if (next === '!') {
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4);
        i = close === -1 ? html.length : close + 3;
      } else {
        const close = html.indexOf('>', lt);
        i = close === -1 ? html.length : close + 1;
      }
      continue;
    }

    if (next === '/') {
      const close = html.indexOf('>', lt);
      const end = close === -1 ? html.length : close + 1;
      const tag = html.slice(lt + 2, close === -1 ? html.length : close).trim().toLowerCase();
      // Close the nearest open element with this tag, and everything under it.
      const at = [...stack].reverse().findIndex((e) => e.tag === tag);
      if (at !== -1) {
        const depth = stack.length - 1 - at;
        for (let d = stack.length - 1; d > depth; d--) {
          const orphan = stack[d];
          orphan.closeStart = lt;
          orphan.end = lt;
          stack.pop();
        }
        const el = stack.pop() as El;
        el.closeStart = lt;
        el.end = end;
      }
      i = end;
      continue;
    }

    if (!/[a-zA-Z]/.test(next ?? '')) {
      i = lt + 1;
      continue;
    }

    let j = lt + 1;
    while (j < html.length && !/[\s/>]/.test(html[j])) j++;
    const tag = html.slice(lt + 1, j).toLowerCase();
    const { attrs, end, selfClosing } = readAttrs(html, j);

    const closes = CLOSES_OPEN[tag] ?? [];
    while (stack.length > 1 && closes.includes(stack[stack.length - 1].tag)) {
      const implied = stack.pop() as El;
      implied.closeStart = lt;
      implied.end = lt;
    }

    const el = newEl(tag, lt);
    el.attrs = attrs;
    el.openEnd = end;
    el.closeStart = end;
    el.end = end;
    el.id = attrs.id ? attrs.id.trim() : null;
    el.classes = (attrs.class ?? '').split(/\s+/).filter(Boolean);
    stack[stack.length - 1].children.push(el);

    if (selfClosing || VOID_TAGS.has(tag)) {
      i = end;
      continue;
    }

    if (RAW_TEXT_TAGS.has(tag)) {
      // A script body may contain anything, close tags included; only its own
      // end tag ends it, so parsing its content as markup would invent elements.
      const closeIdx = html.toLowerCase().indexOf(`</${tag}`, end);
      if (closeIdx === -1) {
        el.closeStart = html.length;
        el.end = html.length;
        i = html.length;
      } else {
        const gt = html.indexOf('>', closeIdx);
        el.closeStart = closeIdx;
        el.end = gt === -1 ? html.length : gt + 1;
        i = el.end;
      }
      continue;
    }

    stack.push(el);
    i = end;
  }

  while (stack.length > 1) {
    const el = stack.pop() as El;
    el.closeStart = html.length;
    el.end = html.length;
  }
  return root;
}

/* ── text ───────────────────────────────────────────────────── */

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', middot: '·', eacute: 'é',
};

/** A reference outside Unicode's range throws in fromCodePoint; leave it as text. */
function codePoint(n: number): string | null {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePoint(parseInt(h, 16)) ?? m)
    .replace(/&#(\d+);/g, (m, d) => codePoint(parseInt(d, 10)) ?? m)
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[String(name).toLowerCase()] ?? m);
}

/**
 * The element's text. Walks children and takes the gaps between them, so an
 * attribute value containing '>' cannot be mistaken for the end of a tag, which
 * is the failure mode of stripping tags with a regex.
 */
function textOf(el: El, html: string): string {
  let out = '';
  let cursor = el.openEnd;
  for (const child of el.children) {
    out += html.slice(cursor, child.start);
    if (!RAW_TEXT_TAGS.has(child.tag)) out += textOf(child, html);
    cursor = child.end;
  }
  out += html.slice(cursor, el.closeStart);
  return decodeEntities(out).replace(/\s+/g, ' ').trim();
}

/* ── selectors ──────────────────────────────────────────────── */

interface Simple {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
}

/** `div.card`, `.card h3`, `a[rel="bookmark"]`, `#main .row`. Descendant only. */
export function parseSelector(sel: string): Simple[] | null {
  const parts = sel.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const out: Simple[] = [];
  for (const part of parts) {
    const simple: Simple = { tag: null, id: null, classes: [], attrs: [] };
    const tokens = part.match(/^[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+|\[[^\]]+\]/g);
    if (!tokens || tokens.join('').length !== part.length) return null;
    for (const t of tokens) {
      if (t.startsWith('.')) simple.classes.push(t.slice(1));
      else if (t.startsWith('#')) simple.id = t.slice(1);
      else if (t.startsWith('[')) {
        const m = t.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"']*)["']?)?$/);
        if (!m) return null;
        simple.attrs.push({ name: m[1].toLowerCase(), value: m[2] ?? null });
      } else simple.tag = t.toLowerCase();
    }
    out.push(simple);
  }
  return out;
}

function matchesSimple(el: El, s: Simple): boolean {
  if (s.tag && el.tag !== s.tag) return false;
  if (s.id && el.id !== s.id) return false;
  if (s.classes.some((c) => !el.classes.includes(c))) return false;
  return s.attrs.every((a) => {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    return a.value === null || v === a.value;
  });
}

/** Depth-first matches of a descendant selector, in document order. */
function queryAll(root: El, sel: Simple[]): El[] {
  const out: El[] = [];
  const walk = (el: El, ancestors: El[]): void => {
    for (const child of el.children) {
      const chain = [...ancestors, child];
      if (matchesChain(chain, sel)) out.push(child);
      walk(child, chain);
    }
  };
  walk(root, []);
  return out;
}

function matchesChain(chain: El[], sel: Simple[]): boolean {
  if (!matchesSimple(chain[chain.length - 1], sel[sel.length - 1])) return false;
  let si = sel.length - 2;
  for (let ci = chain.length - 2; ci >= 0 && si >= 0; ci--) {
    if (matchesSimple(chain[ci], sel[si])) si--;
  }
  return si < 0;
}

function queryFirst(root: El, sel: string | undefined, html: string): El | null {
  if (!sel) return null;
  const parsed = parseSelector(sel);
  if (!parsed) return null;
  return queryAll(root, parsed)[0] ?? null;
}

/* ── extraction ─────────────────────────────────────────────── */

function absolute(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  const raw = decodeEntities(href).trim();
  if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) return null;
  try {
    const u = new URL(raw, baseUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function firstDescendant(el: El, tags: string[]): El | null {
  for (const child of el.children) {
    if (tags.includes(child.tag)) return child;
    const deeper = firstDescendant(child, tags);
    if (deeper) return deeper;
  }
  return null;
}

function allDescendants(el: El, tag: string, out: El[] = []): El[] {
  for (const child of el.children) {
    if (child.tag === tag) out.push(child);
    allDescendants(child, tag, out);
  }
  return out;
}

/**
 * The headline link in a block, in order of trustworthiness: the anchor inside
 * the title element, else the largest piece of linked text.
 *
 * NOT the first anchor: a list row commonly opens with interactive chrome (a
 * vote arrow, a score, a comment count), and taking the first anchor gives you
 * '128' pointing at /login. Largest-text alone is not enough either, because a
 * short headline ('Go 1.24') loses to the row's own '124 comments' link, which
 * is why the title element is consulted first.
 */
function headlineAnchor(el: El, html: string, titleEl: El | null): El | null {
  const anchors = allDescendants(el, 'a').filter((a) => a.attrs.href);
  if (!anchors.length) return null;
  if (titleEl) {
    const inTitle = anchors.find((a) => a.start >= titleEl.start && a.end <= titleEl.end);
    if (inTitle) return inTitle;
  }
  const texted = anchors.map((a) => ({ a, text: textOf(a, html) })).filter((x) => x.text.length > 0);
  if (!texted.length) return anchors[0];
  // A row's chrome opens with a score and closes with a comment count, and both
  // start with a digit; the headline almost never does. Where every anchor does,
  // fall back to the longest, which is right for a plain list of links. The cost
  // is a headline that opens with a number in a row that also carries a
  // non-numeric tag link. This runs at every poll, not only at subscription, so
  // the Add form's preview catches such a row only if it was on the page that
  // day; a rule that stored an explicit link selector never reaches this code.
  const preferred = texted.filter((x) => !/^\d/.test(x.text));
  const pool = preferred.length ? preferred : texted;
  return pool.reduce((best, x) => (x.text.length > best.text.length ? x : best)).a;
}

/**
 * One ParsedItem per container the rule matches. A container with no resolvable
 * link is skipped: the link is the guid, so without it there is no stable
 * identity and every poll would re-insert the same row under a new id.
 */
export function extractItems(html: string, baseUrl: string, rule: ScrapeRule): ParsedItem[] {
  const itemSel = parseSelector(rule.item);
  if (!itemSel) return [];
  const root = parseHtml(html);
  const all = queryAll(root, itemSel);

  // Outermost wins: a rule matching a container that also matches inside itself
  // (a nested list) would otherwise yield the same article twice. `all` is in
  // document order, so anything starting before the last kept container ends is
  // inside it; one pass, because comparing every match with every other one cost
  // 4.4 seconds on a page with 30,000 containers.
  const containers: El[] = [];
  let lastEnd = -1;
  for (const el of all) {
    if (el.start >= lastEnd) {
      containers.push(el);
      lastEnd = el.end;
    }
  }

  const out: ParsedItem[] = [];
  for (const c of containers.slice(0, MAX_ITEMS)) {
    const titleEl = rule.title ? queryFirst(c, rule.title, html) : firstDescendant(c, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    const headline = headlineAnchor(c, html, titleEl);
    const linkEl = rule.link ? queryFirst(c, rule.link, html) ?? headline : headline;
    const url = absolute(linkEl?.attrs.href, baseUrl);
    if (!url) continue;

    const title = (titleEl ? textOf(titleEl, html) : headline ? textOf(headline, html) : '').slice(0, MAX_TITLE);

    const dateEl = rule.date ? queryFirst(c, rule.date, html) : null;
    const dateRaw = dateEl ? dateEl.attrs.datetime || dateEl.attrs.content || textOf(dateEl, html) : '';
    const t = dateRaw ? Date.parse(dateRaw) : NaN;

    const summaryEl = rule.summary ? queryFirst(c, rule.summary, html) : null;
    const summary = summaryEl ? textOf(summaryEl, html).slice(0, MAX_SUMMARY) : null;

    out.push({
      guid: url,
      url,
      title,
      author: null,
      summary: summary || null,
      content: null,
      publishedAt: Number.isNaN(t) ? null : new Date(t).toISOString(),
    });
  }
  return out;
}

/* ── rule suggestion (the Add form's first guess) ───────────── */

export interface Suggestion {
  rule: ScrapeRule;
  sample: ParsedItem[];
}

function signature(el: El): string {
  return el.classes.length ? `${el.tag}.${[...el.classes].sort().join('.')}` : el.tag;
}

/**
 * Rank candidates by headline length first and count second. Ranking on count
 * alone puts a site's navigation above its articles, because a menu has more
 * entries than a front page has stories; what actually separates them is that
 * article titles are long and menu labels are short. Measured against live
 * pages: on an institutional news index, count-only ranking preferred
 * `.nav-item` (44 short links) over the article list; on a link aggregator it
 * preferred `.tags li` over `.story`.
 */
function score(items: ParsedItem[]): number {
  const avgTitle = items.reduce((n, it) => n + it.title.length, 0) / items.length;
  return Math.min(avgTitle, 80) * Math.log2(items.length + 1);
}

function descendants(el: El, out: El[] = []): El[] {
  for (const child of el.children) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

/**
 * Where the headline anchor sits, as a selector, so the rule stores the choice
 * instead of re-deriving it from text lengths at every poll. Without this a row
 * whose headline is shorter than its own '124 comments' link would scrape the
 * comments page, and the item's identity would move with it, since the guid is
 * the url.
 */
function linkSelectorFor(model: El, anchor: El, heading: El | null): string | null {
  if (heading && anchor.start >= heading.start && anchor.end <= heading.end) return `${heading.tag} a`;
  const wrapper = descendants(model)
    .filter((el) => el !== anchor && el.classes.length && el.start <= anchor.start && el.end >= anchor.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  if (wrapper) return `.${wrapper.classes[0]} a`;
  if (anchor.classes.length) return `a.${anchor.classes[0]}`;
  return null;
}

function selectorFor(el: El, parent: El): string {
  if (el.classes.length) return `.${el.classes.join('.')}`;
  if (el.id) return `#${el.id}`;
  if (parent.classes.length) return `.${parent.classes[0]} ${el.tag}`;
  if (parent.id) return `#${parent.id} ${el.tag}`;
  return el.tag;
}

/**
 * Guess extraction rules for a page, best first. The signal is a parent holding
 * several same-shaped children that each carry a link and some text, which is
 * what an index of articles looks like whatever the site calls its classes.
 * Nothing here is authoritative: the Add form shows the sample and you decide.
 */
export function suggestRules(html: string, baseUrl: string): Suggestion[] {
  const root = parseHtml(html);
  const candidates: (Suggestion & { score: number })[] = [];
  const seen = new Set<string>();

  const consider = (parent: El): void => {
    const groups = new Map<string, El[]>();
    for (const child of parent.children) {
      const sig = signature(child);
      groups.set(sig, [...(groups.get(sig) ?? []), child]);
    }
    for (const members of groups.values()) {
      if (members.length < 3) continue;
      // The floor is low on purpose: it is here to keep a row of one-word nav or
      // footer links out, not to judge headlines, and real ones are often short
      // ('Second', '9 Aug'). Whatever survives is shown to the owner with its
      // sample before anything is stored, so a wrong guess costs a glance.
      const linked = members.filter((m) => firstDescendant(m, ['a']) && textOf(m, html).length >= 8);
      if (linked.length < 2) continue;

      const sel = selectorFor(members[0], parent);
      if (seen.has(sel)) continue;
      seen.add(sel);

      const model = linked[0];
      const rule: ScrapeRule = { item: sel };
      const heading = firstDescendant(model, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
      if (heading) rule.title = heading.tag;
      // Never a bare `a`: that pins the rule to the block's first anchor, which
      // is an upvote or a comment count as often as it is the article. What is
      // stored is where the headline anchor actually sits.
      const anchor = headlineAnchor(model, html, heading);
      const linkSel = anchor ? linkSelectorFor(model, anchor, heading) : null;
      if (linkSel) rule.link = linkSel;
      const time = firstDescendant(model, ['time']);
      if (time) rule.date = 'time';
      const para = firstDescendant(model, ['p']);
      if (para) rule.summary = para.classes.length ? `.${para.classes[0]}` : 'p';

      const found = extractItems(html, baseUrl, rule);
      if (found.length >= 2) candidates.push({ rule, sample: found.slice(0, 5), score: score(found) });
    }
    for (const child of parent.children) consider(child);
  };
  consider(root);

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ rule, sample }) => ({ rule, sample }));
}

/* ── rule validation (the rule arrives from a form) ─────────── */

const RULE_KEYS = ['item', 'title', 'link', 'date', 'summary'] as const;

/** Parse a stored or submitted rule. Returns null for anything unusable. */
export function parseRule(json: string): ScrapeRule | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.item !== 'string') return null;
  const out: ScrapeRule = { item: '' };
  for (const key of RULE_KEYS) {
    const v = src[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.length > MAX_SELECTOR || !parseSelector(v)) return null;
    out[key] = v;
  }
  return out.item ? out : null;
}

/* ── fetching (mirrors fetchFeed, same FetchResult contract) ── */

function pageTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() || null : null;
}

/**
 * Decode the body honestly. Response.text() is UTF-8 whatever the page says, so
 * a windows-1252 or shift_jis page comes back as mojibake and silently poisons
 * every title it produces.
 */
async function readBody(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  const declared = ct.match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  // Refuse an oversized page before buffering it where the server says how big
  // it is; the check after the read is the fallback for a chunked response.
  const announced = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(announced) && announced > MAX_PAGE_BYTES) {
    throw new Error(`page announces ${Math.round(announced / 1e6)}MB, over the ${MAX_PAGE_BYTES / 1e6}MB scrape limit`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_PAGE_BYTES) throw new Error(`page is ${Math.round(buf.byteLength / 1e6)}MB, over the ${MAX_PAGE_BYTES / 1e6}MB scrape limit`);
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const charset = declared ?? utf8.slice(0, 2048).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  if (!charset || charset === 'utf-8' || charset === 'utf8') return utf8;
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return utf8;
  }
}

/**
 * Fetch a page as HTML, for the Add form's rule suggestion. Never throws: the
 * caller renders the error rather than failing the page it is drawn on.
 */
export async function fetchPageHtml(pageUrl: string): Promise<{ html: string | null; error: string | null }> {
  let res: Response;
  try {
    res = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { html: null, error: `Could not fetch that page: ${String(err)}` };
  }
  if (!res.ok) return { html: null, error: `That page answered HTTP ${res.status}.` };
  try {
    return { html: await readBody(res), error: null };
  } catch (err) {
    return { html: null, error: `Could not read that page: ${String(err)}` };
  }
}

/**
 * Fetch a page and apply its rule. Never throws. The error paths mirror
 * fetchFeed deliberately: a body that is not usable drops the stored cache
 * validators, because keeping them lets the next poll answer 304 and report a
 * healthy feed without a body ever being looked at again.
 */
export async function fetchScrape(
  pageUrl: string,
  rule: ScrapeRule,
  etag: string | null,
  lastModified: string | null,
): Promise<FetchResult> {
  const empty = { etag, lastModified, feedTitle: null, siteUrl: null, items: [] };
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  let res: Response;
  try {
    res = await fetch(pageUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { status: 'error', ...empty, error: `Network error: ${String(err)}` };
  }
  if (res.status === 304) return { status: 'not-modified', ...empty };
  if (!res.ok) return { status: 'error', ...empty, error: `HTTP ${res.status}` };

  const contentType = res.headers.get('content-type') ?? '';
  let body: string;
  try {
    body = await readBody(res);
  } catch (err) {
    return { status: 'error', ...empty, etag: null, lastModified: null, error: `Could not read the page: ${String(err)}` };
  }

  if (!/html/i.test(contentType) && !/^\s*<(!doctype|html)/i.test(body)) {
    return {
      status: 'error',
      ...empty,
      etag: null,
      lastModified: null,
      error: `Response was not an HTML page (HTTP ${res.status}, ${contentType || 'no content-type'})`,
    };
  }

  // Containment. Arbitrary HTML finds every latent bug in a parser, and this
  // function's callers are a poll loop that would otherwise log and leave the
  // feed's row untouched (stale status, no backoff, silent for ever) and a page
  // render that would otherwise 500. A throw here becomes the same loud, stored
  // error any other unusable body produces.
  let items: ParsedItem[];
  try {
    items = extractItems(body, res.url || pageUrl, rule);
  } catch (err) {
    return {
      status: 'error',
      ...empty,
      etag: null,
      lastModified: null,
      error: `The extractor failed on that page: ${String(err)}`,
    };
  }
  if (!items.length) {
    return {
      status: 'error',
      ...empty,
      etag: null,
      lastModified: null,
      error: `The scrape rule matched nothing on that page (item selector: ${rule.item})`,
    };
  }

  let siteUrl: string | null = null;
  try {
    siteUrl = new URL(res.url || pageUrl).origin;
  } catch {
    /* leave it null: a page we just fetched should parse, but the feed row does not need it */
  }

  return {
    status: 'ok',
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    feedTitle: pageTitle(body),
    siteUrl,
    items,
  };
}
