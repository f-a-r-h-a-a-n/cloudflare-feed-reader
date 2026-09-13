# cloudflare-feed-reader

A private RSS/Atom/JSON feed reader that runs entirely on Cloudflare: a Pages
Function for the reading surface, D1 for storage, and a companion Worker on a
cron for polling. No third-party service, no JavaScript framework, and nothing
leaves your account.

It is built for one person: yours, behind an owner gate, not a multi-user app.

## What you get

- **Subscribe by URL.** Paste a feed or an ordinary site URL and it discovers the
  feed. OPML import for a bulk move off another reader.
- **Read, star, search.** Full-text search over stored items via SQLite FTS.
- **Scrape-as-feed.** For sites that publish no feed at all: give it a CSS rule
  and it synthesises one, with a suggestion engine that proposes rules from the
  page.
- **YouTube without the Shorts.** Channel feeds are classified and Shorts are
  excluded, with or without a Data API key.
- **Works with JavaScript off.** Links and `<form method=post>` throughout; the
  keyboard layer is one small first-party script under a per-request CSP nonce.
- **A verify suite.** 257 checks over the feed parser, the scraper, the poller,
  the page and the action route. `npm run verify`.

## How it fits together

Two deployables, because Pages cannot run on a schedule.

| | |
|---|---|
| **The reader** | `functions/` — the page (`/rss`), the watch view (`/rss/watch`) and two API routes (`/api/reader/action`, `/api/reader/status`). Ships with your Pages deploy. |
| **The poller** | `feed-poller/` — a standalone Worker on a 20-minute cron, bound to the **same** D1 database, that fetches feeds and inserts new items. Deployed separately. |

Both bind one D1 database as `READER_DB`. The shared id is what connects them,
and a mismatch is silent: the reader simply shows no items.

## Integrating it into an existing site

Copy `functions/`, `feed-poller/` and `db/` into your project, add the two
dependencies (`fast-xml-parser`, `jose`), and merge the `[[d1_databases]]` block
from `wrangler.toml` into yours. Pages routes `functions/` by filename, so the
four routes appear as soon as they are in the tree.

If you already have your own `functions/api/_lib.ts` or an auth helper, note that
this repo keeps its `Env` in `functions/_lib.ts` and its gate in
`functions/_auth.ts`; point the four imports at yours instead.

**On Workers with static assets rather than Pages?** See
[docs/WORKERS.md](docs/WORKERS.md). The Functions are unchanged; you compile them
with one wrangler command and set two config keys.

## Setting it up from scratch

### 1. Create the D1 database

```bash
npx wrangler d1 create my-reader
```

Copy the printed `database_id` over `PLACEHOLDER_SET_AFTER_D1_CREATE` in **both**
`wrangler.toml` and `feed-poller/wrangler.toml`, and put your database name over
`PLACEHOLDER_YOUR_D1_DATABASE_NAME` in both. They must match.

Also fill in `PLACEHOLDER_YOUR_PAGES_PROJECT_NAME` and
`PLACEHOLDER_YOUR_POLLER_WORKER_NAME`.

### 2. Apply the schema

```bash
npx wrangler d1 execute my-reader --local  --file=db/schema.sql   # local dev
npx wrangler d1 execute my-reader --remote --file=db/schema.sql   # production
```

`db/migration-scrape.sql` is only for upgrading a database created before the
scrape feature; a fresh `schema.sql` already includes it.

### 3. Put an owner gate in front of it

As shipped the gate is Cloudflare Access, on the Zero Trust free tier.

1. Zero Trust dashboard, **Access, Applications, Add an application**,
   self-hosted.
2. Paths: `yourdomain.com/rss` and `yourdomain.com/api/reader`.
3. Add a policy immediately, **Allow**, Emails = your address. An application
   with no policy gates the path with nothing behind it.
4. Copy the application's **Audience (AUD) tag**.
5. Set three variables on the Pages project (Settings, Variables and Secrets):

   | Variable | Value |
   |---|---|
   | `CF_ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` |
   | `CF_ACCESS_AUD` | the AUD tag from step 4 |
   | `READER_ALLOWED_EMAILS` | your address, comma-separated for more than one |

6. **Redeploy.** Pages binds variables at build time, so setting them is not
   enough on its own; push a commit, an empty one will do.

Sequence matters. The moment the application exists it issues tokens carrying
the new AUD while the deployed code still has none, so a fresh login 403s until
the variable is set *and* a build has bound it. Run application, policy,
variables, rebuild back to back and the window is a minute or two.

Throughout, the gate fails closed: `functions/_auth.ts` refuses any request
carrying no valid owner identity, so the reader is never exposed at any point in
the sequence.

**Want a different gate?** Replace `functions/_auth.ts` with your own
implementation of `requireOwner(request, env)`. The contract is documented at the
top of that file and nothing else in the reader touches authentication.

### 4. Deploy the reader

Push to your Pages project's production branch. Visit `/rss`, paste a feed URL in
the Add box, and it subscribes. Items appear after the poller's next run.

### 5. Deploy and schedule the poller

```bash
cd feed-poller
npx wrangler deploy
npx wrangler secret put POLL_TRIGGER_SECRET   # a long random string
npx wrangler secret put YOUTUBE_API_KEY       # optional, see below
```

The cron is registered from `feed-poller/wrangler.toml` on deploy; confirm it
under the Worker's **Triggers** tab. To force a poll instead of waiting:

```bash
curl "https://<your-worker>.workers.dev/?secret=$POLL_TRIGGER_SECRET"
```

The Worker needs no public route: that URL does nothing without the secret.

**The YouTube key** is only needed if you subscribe to YouTube channels and want
Shorts excluded. Google Cloud console, enable **YouTube Data API v3**,
Credentials, Create credentials, API key. The free quota (10,000 units/day) is
ample at 1 unit per feed per poll. Without it the poller falls back to a keyless
redirect probe, which works but re-probes stored videos and is subject to
rate-limiting.

## Local development

Point both dev servers at one shared local database:

```bash
# Terminal 1 — the reader:
npx wrangler pages dev --persist-to .wrangler/state

# Terminal 2 — the poller:
cd feed-poller
echo 'POLL_TRIGGER_SECRET = "dev-secret"' > .dev.vars   # gitignored
npx wrangler dev --persist-to ../.wrangler/state --port 8788
```

On `localhost` the reader shows a red "auth not enforced" bar and bypasses the
gate, because there is no Access in front of it. That bypass is conditional on
the gate being *unconfigured*, not on the Host header, so a production request
carrying `Host: localhost` cannot take it.

Add a feed in the UI, then trigger a poll:

```bash
curl "http://localhost:8788/?secret=dev-secret"
```

## Verifying

```bash
npm run verify
```

Typecheck plus five harnesses, 257 checks, run against the real modules with
stubbed D1 and `fetch`. There is no test runner here by design: these are
behaviour harnesses that bundle the shipped code, so what they assert is what the
browser gets. Run it before you deploy; `wrangler deploy --dry-run` is not a
gate, because esbuild bundles happily past a free identifier.

## Things worth knowing before you rely on it

- **Mounted at `/rss`.** The path is hard-coded in links and form targets. If
  your site already uses `/rss`, you will need to change those occurrences and
  the Access application paths together.
- **Retention.** The poller keeps the latest 100 items per feed and never deletes
  read items; starring exempts an item from the cap.
- **Item counts.** The poller's `inserted` figure is D1's total `changes` count,
  which the FTS triggers inflate. Trust the `items` table, not that number.
- **Feed content is escaped, not trusted.** Feed-supplied strings are
  tag-stripped then HTML-escaped, the reading view keeps only safe http(s) links,
  and remote images are never rendered.
- **Fonts.** `public/fonts/` ships Archivo and Newsreader under the SIL Open Font
  License 1.1, with their licences beside them. Keep those files together if you
  redistribute. Every CSS stack falls back to system faces, so deleting them
  degrades the typography and breaks nothing.

## Author

Built by **Farhaan Ahmed** ([farhaanahmed.com](https://farhaanahmed.com),
[@f-a-r-h-a-a-n](https://github.com/f-a-r-h-a-a-n)), extracted from the reader
running on his own site.

Issues and pull requests are welcome. This is a personal tool published in case
it is useful, not a supported product: there is no roadmap, and it is maintained
as the upstream reader changes.

## Licence

MIT. See [LICENSE](LICENSE).

**Except the fonts.** `public/fonts/` ships Archivo and Newsreader under the SIL
Open Font License 1.1, not under the MIT licence above. Their licences travel
with them as `public/fonts/OFL-Archivo.txt` and `public/fonts/OFL-Newsreader.txt`
and must be kept alongside the files if you redistribute them. Deleting the four
files removes the obligation and costs you only the typography, since every CSS
stack falls back to system faces.
