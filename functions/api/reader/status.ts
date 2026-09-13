/**
 * GET /api/reader/status — cheap liveness probe behind the reader's auto-refresh.
 *
 * Owner-gated by the same Access application as the reader page,
 * exactly like the page and the action endpoint; the Access application already
 * covers the `api/reader` path prefix, so this route is gated the moment it ships.
 *
 * Returns the newest `poll_runs` row plus the unread total, which is all the
 * client layer needs to answer "has a pull landed since this page was rendered?".
 * No item data crosses the wire, and the response is never cached.
 *
 * `poll_runs` may be absent on an unmigrated database (the /studio Reader panel
 * tolerates the same), so a failed read degrades to `poll: null` rather than a 500:
 * the client then simply never sees a new run and leaves the page alone.
 */
import type { Env } from '../../_lib';
import { requireOwner } from '../../_auth';

interface RunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireOwner(request, env);
  if (!auth.ok) return auth.response;

  const db = env.READER_DB;
  const [run, unread] = await Promise.all([
    db
      .prepare('SELECT id, started_at, finished_at FROM poll_runs ORDER BY id DESC LIMIT 1')
      .first<RunRow>()
      .catch(() => null),
    db
      .prepare('SELECT COUNT(*) AS n FROM items WHERE is_read = 0')
      .first<{ n: number }>()
      .catch(() => null),
  ]);

  return new Response(
    JSON.stringify({
      poll: run?.id ?? null,
      started_at: run?.started_at ?? null,
      finished_at: run?.finished_at ?? null,
      unread: unread?.n ?? 0,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
};
