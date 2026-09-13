# Running this on Workers with static assets

Cloudflare now steers new projects to Workers with static assets rather than
Pages. This reader is written as Pages Functions, and Cloudflare ships a
supported path from one to the other. You do not need to rewrite anything.

## The short version

```bash
npx wrangler pages functions build --outdir=./dist/worker/
```

That compiles the whole `functions/` tree into a single Worker script, routing
included. Then in your Wrangler config:

```jsonc
{
  "main": "./dist/worker/index.js",
  "assets": { "directory": "./dist/client/" }
}
```

Keep the same `[[d1_databases]]` binding (`READER_DB`) and the same three Access
variables. Nothing else changes.

Verified against this repo: the compile emits routes for `/rss`, `/rss/watch`,
`/api/reader/action` and `/api/reader/status`, plus the assets fallback.

## What to know

- `wrangler pages functions build` is documented in Cloudflare's *Migrate from
  Pages* guide and remains available. In the same paragraph Cloudflare
  recommends considering a framework if you want to keep file-based routing long
  term, so treat the compile step as a supported bridge rather than a
  destination.
- The compiled `index.js` is a bundle. It is fine to deploy and awkward to read,
  so debug against the Pages layout (`wrangler pages dev`) and compile for
  deployment.
- Run the compile in CI rather than committing `dist/`; this repo gitignores it.
- `run_worker_first` can stay at its default. The reader's routes (`/rss`,
  `/api/reader/*`) never collide with a static asset path, so asset-first
  matching is correct here.

## The alternative

If you would rather not ship a compiled bundle, the four handlers are ordinary
functions with one signature:

```ts
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => { ... }
```

None of them reads `params`, `next`, `data` or anything else from the Pages
context, so a hand-written Worker `fetch` handler can dispatch to them directly
on pathname. Note that they are typed `PagesFunction<Env>`, whose context type
requires the full `EventContext` shape, so a shim must construct one (or the
handlers must be retyped) to satisfy `tsc`. This is a legibility preference, not
a requirement, and it costs you a route table that nothing in the verify suite
exercises.
