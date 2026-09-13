/**
 * POST /api/reader/action — every mutation for the /rss reader, one endpoint.
 *
 * Owner-gated by requireOwner against the reader's OWN Access application
 * (CF_ACCESS_AUD). Plain form posts, no
 * client script, so each handler ends in a 303 redirect back to a validated
 * in-app path (open-redirect safe: only /rss targets are honoured).
 *
 *   do=add-feed     url=<feed or site URL>      → discover + subscribe
 *   do=scrape-preview url=<page URL>            → skip discovery, offer rules for the page
 *   do=add-scrape   url=<page URL> rule=<JSON>  → subscribe to a page with no feed
 *   do=delete-feed  feed_id=<id>                → unsubscribe (cascades items)
 *   do=mark-read    item_id=<id> state=0|1      → set read flag
 *   do=star         item_id=<id> state=0|1      → set starred flag
 *   do=mark-all     [feed_id=<id>]              → mark unread items read
 */
import type { Env } from '../../_lib';
import { requireOwner } from '../../_auth';
import { discoverFeed, parseOpml } from '../../_shared/feed';
import type { OpmlFeed } from '../../_shared/feed';
import { fetchScrape, parseRule } from '../../_shared/scrape';

/** 303 back to a safe in-app path. Anything not under /rss falls back to /rss. */
function backTo(origin: string, ret: string | null, extra: Record<string, string> = {}): Response {
  let path = '/rss';
  if (ret && ret.startsWith('/rss')) path = ret;
  const url = new URL(path, origin);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return new Response(null, { status: 303, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
}

/**
 * The in-place path's success signal, and deliberately NOT a redirect. To
 * `fetch` with `redirect: 'manual'` an Access 302 and this endpoint's own 303
 * are the same opaque response, so a client that accepts a redirect accepts a
 * lapsed Access session as a write that never happened: the row paints read and
 * nothing reaches D1, which is indistinguishable from the retention bug closed
 * on 29 August 2026. A 204 can only have been answered here, past the gate.
 */
function ok204(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

function intField(form: FormData, name: string): number | null {
  const n = parseInt(String(form.get(name) ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The one wording for 'you already have this feed', so both paths to it agree. */
function alreadyMsg(title: string | null, folder: string | null, feedUrl: string): string {
  const where = (folder ?? '').trim();
  return `Already subscribed: ${(title || '').slice(0, 200) || feedUrl}${
    where ? ` (in ${where})` : ' (ungrouped)'
  }. Change its folder from Manage feeds.`;
}

/**
 * The folder a form is asking for. Every folder control on the reader posts two
 * fields: `folder` from the <select> of existing names (empty = Ungrouped) and
 * `folder_new` from the box beside it. A non-empty new name always wins, which
 * is what lets one form both file into a group and create one. Null means
 * ungrouped. Older forms that post only `folder` keep working unchanged.
 *
 * A typed name that differs from an existing folder only in case or accent IS
 * that folder, and adopts its stored spelling: 'news - bangladesh' files into
 * 'News - Bangladesh' rather than opening a sibling beside it. That is the half
 * the <select> cannot cover, since only choosing is closed-vocabulary; an
 * outright misspelling still creates a new folder, as any free-text create must.
 * The lookup is skipped when nothing was typed, so the ordinary path costs no
 * extra query.
 */
async function folderFrom(form: FormData, db: Env['READER_DB']): Promise<string | null> {
  const created = String(form.get('folder_new') ?? '').trim();
  const chosen = String(form.get('folder') ?? '').trim();
  const want = (created || chosen).slice(0, 100);
  if (!want || !created) return want || null;
  const rows = await db.prepare('SELECT DISTINCT folder FROM feeds WHERE folder IS NOT NULL').all<{ folder: string }>();
  const hit = (rows.results ?? [])
    .map((r) => (r.folder ?? '').trim())
    .filter(Boolean)
    .find((n) => n.localeCompare(want, 'en', { sensitivity: 'base' }) === 0);
  return hit ?? want;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // The reader has its own Access application; fall back to the studio AUD
  const auth = await requireOwner(request, env);
  if (!auth.ok) return auth.response;

  const origin = new URL(request.url).origin;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return backTo(origin, null, { err: 'That form submission could not be read.' });
  }

  const action = String(form.get('do') ?? '');
  const ret = form.get('return') ? String(form.get('return')) : null;
  const db = env.READER_DB;
  // Set only by the reader's own in-place fetch. A plain form post carries no
  // such header and still gets its 303, so the no-script path is unchanged.
  const inPlace = request.headers.get('x-reader-action') === '1';

  switch (action) {
    case 'add-feed': {
      const raw = String(form.get('url') ?? '').trim();
      if (!/^https?:\/\//i.test(raw)) {
        return backTo(origin, ret, { err: 'Enter a full http(s) URL to a feed or site.' });
      }
      let discovered;
      try {
        discovered = await discoverFeed(raw);
      } catch (err) {
        // No feed does not mean no articles. Hand the URL to the scrape preview,
        // which re-fetches the page and offers to build a feed from its list;
        // it reports its own failure honestly if the page cannot be read either,
        // so this path never has to guess which half of discovery failed.
        return backTo(origin, ret, {
          err: err instanceof Error ? err.message : 'Could not find a feed there.',
          scrape: raw,
        });
      }
      const existing = await db
        .prepare('SELECT id, title, folder FROM feeds WHERE feed_url = ?')
        .bind(discovered.feedUrl)
        .first<{ id: number; title: string | null; folder: string | null }>();
      // Naming the existing feed and its group answers the question the message
      // used to leave open: whether the subscription you already have is filed
      // where you were about to file it. It is not moved: re-pasting a URL is
      // not an instruction to regroup a feed you subscribed to months ago.
      if (existing) {
        return backTo(origin, ret, { msg: alreadyMsg(existing.title, existing.folder, discovered.feedUrl) });
      }
      // Optional folder from the Add form: the chooser files it into an existing
      // group, the box beside it creates a new one. Neither means ungrouped.
      const folder = await folderFrom(form, db);
      // Capped to match update-feed's 200: a feed is free to ship a title of any
      // length, and it travels from here into a redirect's query string.
      const title = (discovered.title || '').slice(0, 200);
      // OR IGNORE, not a plain INSERT: `feed_url` is UNIQUE, and discovery sits
      // between the check above and this line for as long as it takes to fetch
      // the URL and then guess up to seven common feed paths, each with its own
      // ten-second timeout. Two overlapping submissions of one URL (the second
      // click a silent form invites) therefore both pass the check, and with a
      // plain INSERT the loser threw a constraint error and the form got a 500.
      // One atomic statement has no window to lose instead of catching what
      // losing it throws.
      const res = await db
        .prepare('INSERT OR IGNORE INTO feeds (feed_url, site_url, title, folder) VALUES (?, ?, ?, ?)')
        .bind(discovered.feedUrl, discovered.siteUrl, title, folder)
        .run();
      if (!res.meta?.changes) {
        // Ignored means a constraint stopped it, and on this row `feed_url` is
        // the only one that can: the feed is already there, either from before
        // or from the request that beat us. Say so in the same words the check
        // uses. If it is somehow NOT there, something else failed and saying
        // 'already subscribed' would be a lie, so that fails loudly.
        const won = await db
          .prepare('SELECT title, folder FROM feeds WHERE feed_url = ?')
          .bind(discovered.feedUrl)
          .first<{ title: string | null; folder: string | null }>();
        if (!won) throw new Error(`Subscribing to ${discovered.feedUrl} wrote no row and left none behind.`);
        return backTo(origin, ret, { msg: alreadyMsg(won.title, won.folder, discovered.feedUrl) });
      }
      return backTo(origin, ret, { added: `${title || discovered.feedUrl}${folder ? ` → ${folder}` : ''}` });
    }

    case 'scrape-preview': {
      // 'From page' on the Add form. It only validates and hands the URL to the
      // preview panel, which does the fetching. Its whole purpose is to skip
      // discovery: a site whose feed exists but has stopped carrying its news
      // resolves to that feed for ever, so without this there is no route from
      // the interface to the page's own list.
      const raw = String(form.get('url') ?? '').trim();
      if (!/^https?:\/\//i.test(raw)) {
        return backTo(origin, ret, { err: 'Enter a full http(s) URL to a page.' });
      }
      // `via` is what stops the panel opening with 'No feed at …' on the one
      // route built for sites that do have one.
      return backTo(origin, ret, { scrape: raw, via: 'page' });
    }

    case 'add-scrape': {
      // The rule comes back from the preview panel, so it is re-validated here
      // rather than trusted: parseRule accepts only the five known keys and only
      // selectors it can parse, and the page is fetched once more so a rule that
      // matches nothing is refused at the door instead of becoming a red feed.
      const raw = String(form.get('url') ?? '').trim();
      if (!/^https?:\/\//i.test(raw)) {
        return backTo(origin, ret, { err: 'Enter a full http(s) URL to a page.' });
      }
      const rule = parseRule(String(form.get('rule') ?? ''));
      if (!rule) return backTo(origin, ret, { err: 'That extraction rule could not be read.' });

      const existing = await db
        .prepare('SELECT id, title, folder FROM feeds WHERE feed_url = ?')
        .bind(raw)
        .first<{ id: number; title: string | null; folder: string | null }>();
      if (existing) return backTo(origin, ret, { msg: alreadyMsg(existing.title, existing.folder, raw) });

      const probe = await fetchScrape(raw, rule, null, null);
      if (probe.status !== 'ok') {
        return backTo(origin, ret, { err: `That page could not be turned into a feed: ${probe.error ?? probe.status}` });
      }
      const folder = await folderFrom(form, db);
      const title = (probe.feedTitle || raw).slice(0, 200);
      const res = await db
        .prepare(
          `INSERT OR IGNORE INTO feeds (feed_url, site_url, title, folder, kind, scrape_rule)
           VALUES (?, ?, ?, ?, 'scrape', ?)`,
        )
        .bind(raw, probe.siteUrl, title, folder, JSON.stringify(rule))
        .run();
      if (!res.meta?.changes) {
        const won = await db
          .prepare('SELECT title, folder FROM feeds WHERE feed_url = ?')
          .bind(raw)
          .first<{ title: string | null; folder: string | null }>();
        if (!won) throw new Error(`Subscribing to ${raw} wrote no row and left none behind.`);
        return backTo(origin, ret, { msg: alreadyMsg(won.title, won.folder, raw) });
      }
      return backTo(origin, ret, { added: `${title}${folder ? ` → ${folder}` : ''}` });
    }

    case 'import-opml': {
      const file = form.get('opml');
      if (!(file instanceof File) || file.size === 0) {
        return backTo(origin, ret, { err: 'Choose an OPML file to import.' });
      }
      let xml: string;
      try {
        xml = await file.text();
      } catch {
        return backTo(origin, ret, { err: 'That file could not be read.' });
      }
      let parsed: OpmlFeed[];
      try {
        parsed = parseOpml(xml);
      } catch {
        parsed = [];
      }
      if (!parsed.length) return backTo(origin, ret, { err: 'No feeds were found in that OPML file.' });
      let added = 0;
      let skipped = 0;
      for (const f of parsed) {
        if (!/^https?:\/\//i.test(f.feedUrl)) {
          skipped++;
          continue;
        }
        // Same caps as every form path. An uncapped OPML folder label over 100
        // characters would be stored in full and then be unreachable: the folder
        // view truncates its query to 100, so `WHERE folder = ?` never matches
        // and the header counts feeds above an empty list.
        const folder = (f.folder ?? '').trim().slice(0, 100) || null;
        const res = await db
          .prepare('INSERT OR IGNORE INTO feeds (feed_url, site_url, title, folder) VALUES (?, ?, ?, ?)')
          .bind(f.feedUrl, f.siteUrl, (f.title || '').slice(0, 200), folder)
          .run();
        if (res.meta?.changes) added++;
        else skipped++;
      }
      return backTo(origin, ret, {
        msg: `Imported ${added} feed${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already-known or invalid` : ''}. Items appear after the next poll.`,
      });
    }

    case 'update-feed': {
      const id = intField(form, 'feed_id');
      if (id) {
        const title = String(form.get('title') ?? '').trim().slice(0, 200);
        const folder = await folderFrom(form, db);
        await db.prepare('UPDATE feeds SET title = ?, folder = ? WHERE id = ?').bind(title, folder, id).run();
      }
      return backTo(origin, ret, { msg: 'Feed updated.' });
    }

    case 'set-folder': {
      // Folder only — never touches the title (so the inline mover can't wipe it).
      const id = intField(form, 'feed_id');
      if (id) {
        const folder = await folderFrom(form, db);
        await db.prepare('UPDATE feeds SET folder = ? WHERE id = ?').bind(folder, id).run();
      }
      return backTo(origin, ret, { msg: 'Folder updated.' });
    }

    case 'delete-feed': {
      const id = intField(form, 'feed_id');
      if (id) await db.prepare('DELETE FROM feeds WHERE id = ?').bind(id).run();
      return backTo(origin, ret, { msg: 'Feed removed.' });
    }

    case 'mark-read': {
      const id = intField(form, 'item_id');
      const read = String(form.get('state') ?? '1') === '1';
      if (id) {
        await db
          .prepare(
            read
              ? "UPDATE items SET is_read = 1, read_at = datetime('now') WHERE id = ?"
              : 'UPDATE items SET is_read = 0, read_at = NULL WHERE id = ?',
          )
          .bind(id)
          .run();
      }
      return inPlace ? ok204() : backTo(origin, ret);
    }

    case 'star': {
      const id = intField(form, 'item_id');
      const state = String(form.get('state') ?? '1') === '1' ? 1 : 0;
      if (id) await db.prepare('UPDATE items SET is_starred = ? WHERE id = ?').bind(state, id).run();
      return inPlace ? ok204() : backTo(origin, ret);
    }

    case 'mark-all': {
      const feedId = intField(form, 'feed_id');
      const folder = String(form.get('folder') ?? '').trim();
      if (feedId) {
        await db.prepare("UPDATE items SET is_read = 1, read_at = datetime('now') WHERE feed_id = ? AND is_read = 0").bind(feedId).run();
      } else if (folder) {
        await db
          .prepare("UPDATE items SET is_read = 1, read_at = datetime('now') WHERE is_read = 0 AND feed_id IN (SELECT id FROM feeds WHERE folder = ?)")
          .bind(folder)
          .run();
      } else {
        await db.prepare("UPDATE items SET is_read = 1, read_at = datetime('now') WHERE is_read = 0").run();
      }
      return backTo(origin, ret, { msg: 'Marked read.' });
    }

    default:
      return backTo(origin, ret, { err: 'Unknown action.' });
  }
};
