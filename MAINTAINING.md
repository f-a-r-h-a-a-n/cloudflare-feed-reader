# Maintaining this repo

This is an extraction. The reader is developed in a private site repo and ported
here, so every update is a re-port rather than a merge. This file is the record
of how the two trees differ, so a port is mechanical and cannot leak by accident.

## Before every publish

```bash
npm run verify                      # typecheck + 257 checks, must exit 0
grep -rniE "your-domain|your-name|your-employer|real-feed-names" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude=package-lock.json .
```

The sweep must come back empty apart from the copyright line in `LICENSE`.

Two traps worth naming, both of which have already bitten once:

- **Encoded variants hide from a plain search.** A string replaced everywhere it
  appears as `General News` can survive as `General+News` in a URL assertion and
  `General%20News` in a query string. Search for the encoded forms too, or trust
  the suite to catch it.
- **Regex-escaped variants hide as well.** `example.com` in prose is
  `example\.com` inside a test regex, and a literal replace misses it.

## How this tree differs from upstream

Port changes with these in mind; each one is a place where a straight copy
reintroduces something that does not belong here.

### Layout

| Upstream | Here |
|---|---|
| `functions/api/_lib.ts` (shared with the newsletter) | `functions/_lib.ts`, reader bindings only |
| `functions/studio/_auth.ts` | `functions/_auth.ts` |
| `db/reader-schema.sql` | `db/schema.sql` |
| `scripts/rss-verify/` | `scripts/verify/` |

The four route files import `../_lib` / `../../_lib` and `../_auth` /
`../../_auth` accordingly.

### Removed

- **The Gap Radar leg and its `RADAR_DB` binding**, out of `feed-poller/src/index.ts`
  entirely: the archive section, the two `RADAR_*` constants, the `rs: RadarStats`
  parameter on `pollFeed`, the archive mirror inside it, the radar half of
  `pollAll`'s return, and the radar tallies in both handlers of the default
  export. `grep -i radar` must come back empty.
- **The `/studio` footer link** from the page.
- The five `radar leg:` checks, the `radar_feeds` fixture rows and the `RADAR_DB`
  test binding from `scripts/verify/verify-poller.mjs`.

### Changed

- **One Access application, not two.** Upstream calls
  `requireOwner(request, env, env.CF_ACCESS_AUD_READER ?? env.CF_ACCESS_AUD)`
  because it gates two areas separately. Here every call is
  `requireOwner(request, env)` and the gate defaults to `CF_ACCESS_AUD`.
- **`STUDIO_ALLOWED_EMAILS` is `READER_ALLOWED_EMAILS`**, and the two refusal
  strings naming 'studio' are reworded.
- **Deployment constants live in `functions/_shared/config.ts`.** The hard-coded
  User-Agent becomes `DEFAULT_UA`; `POLL_INTERVAL_MIN`, which upstream duplicates
  in the page, is imported from there.
- **`scripts/verify/verify-page.mjs` and `verify-action.mjs` stub the gate by
  esbuild plugin, matched on `/_auth$/`.** Upstream matches `/studio\/_auth$/`.
  Get this wrong and twenty checks fail with a 500 that looks like a code bug.
- **`verify-feed.mjs` asserts `DEFAULT_UA`**, bundled from `config.ts`, rather
  than a hard-coded domain, so changing the User-Agent cannot turn it red.

### Scrubbed

Real organisations named in comments and fixtures are generalised: the scrape
ranking note, the stale-feed worked example in the page, the `verify-page.mjs`
feed fixtures and folder names, and the aggregator named in `verify-scrape.mjs`.
None of it was load-bearing; the measurements and shapes they described are kept.

## Keeping it in sync

There is no exporter. The extraction rules above are mechanical but touch hand
edits, so the port is done by hand and gated by the suite. If porting starts
costing more than the reader changes do, the answer is a script that applies this
file's rules, not a looser checklist.
