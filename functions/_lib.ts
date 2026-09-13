/**
 * The reader's environment bindings.
 *
 * Every binding the reader actually reads is listed here and nothing else. The
 * page, the two API routes and the owner gate share this one type; the poller
 * Worker declares its own in feed-poller/src/index.ts, because it is deployed
 * separately and binds a different set.
 *
 * The Access variables are optional at the type level and mandatory in practice:
 * _auth.ts fails closed when they are unset rather than falling open, so a
 * half-configured deployment refuses to serve instead of exposing the reader.
 * See the gate's own header for the one exception, local development.
 */
export interface Env {
  /** D1 database holding feeds, items and poll runs. Schema: db/schema.sql. */
  READER_DB: D1Database;

  /* ── Cloudflare Access (the owner gate) ──────────────────────
   * All three are required in production. Provisioning: README, step 3. */

  /** Zero Trust team domain, e.g. `your-team.cloudflareaccess.com`. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Audience (AUD) tag of the Access application gating /rss and /api/reader. */
  CF_ACCESS_AUD?: string;
  /**
   * Comma-separated email allowlist, checked inside the Function on top of the
   * edge Access policy. Mandatory: the gate refuses to serve when it is unset,
   * so the reader never rests on the edge policy alone.
   */
  READER_ALLOWED_EMAILS?: string;
}
