/**
 * Deployment-specific constants. These are the only values a new deployment is
 * expected to change; everything else in the reader is behaviour, not identity.
 */

/**
 * Sent as User-Agent on every outbound feed and scrape fetch.
 *
 * Change the domain to your own before deploying. Some publishers block unknown
 * agents and some ask that a crawler be reachable, so a contactable URL here is
 * courtesy rather than decoration. The verify suite asserts that this value is
 * what actually reaches the wire, so it must stay a single literal string.
 */
export const DEFAULT_UA = 'feed-reader (+https://example.com)';

/**
 * The poller's cron cadence in minutes. MUST match the `crons` entry in
 * feed-poller/wrangler.toml; it is duplicated rather than derived because a
 * Pages Function cannot read another Worker's triggers. Only the "next pull"
 * countdown depends on it, so drift here misleads a clock, it does not break
 * polling.
 */
export const POLL_INTERVAL_MIN = 20;
