/**
 * GET /rss/watch?v=<videoId> — owner-only in-app player for a YouTube video.
 *
 * The reader links video posts here rather than straight to
 * youtube-nocookie.com/embed/<id>: that embed endpoint is meant to be framed by
 * a first-party page, and opening it as a top-level document fails with "Error
 * 153". This page provides that first-party frame. It hosts the nocookie iframe
 * only, so no cookies are set until you press play, and the reader list stays
 * free of remote content. All player JavaScript runs inside YouTube's iframe on
 * its own origin, so this page itself still ships zero first-party script.
 */
import type { Env } from '../_lib';
import { requireOwner } from '../_auth';

function esc(v: unknown): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function html(body: string, status: number): Response {
  const doc = `<!doctype html>
<html lang="en-GB"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Watch – Reader</title>
<style>
  html, body { margin:0; height:100%; background:#000; }
  body { display:flex; flex-direction:column; font:.9rem/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  .bar { flex:0 0 auto; display:flex; justify-content:space-between; align-items:center;
         gap:1rem; padding:.55rem .9rem; background:#111; color:#eee; }
  .bar a { color:#eee; text-decoration:none; }
  .bar a:hover { text-decoration:underline; }
  .player { flex:1 1 auto; position:relative; min-height:0; }
  .player iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
  .msg { color:#eee; padding:3rem 1.5rem; max-width:34rem; margin:0 auto; }
  .msg a { color:#7fd8cc; }
</style></head>
<body>${body}</body></html>`;
  return new Response(doc, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Only the nocookie player may be framed; this page runs no first-party script.
      'Content-Security-Policy':
        "default-src 'none'; frame-src https://www.youtube-nocookie.com; style-src 'unsafe-inline'; font-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin',
    },
  });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireOwner(request, env);
  if (!auth.ok) return auth.response;

  const v = new URL(request.url).searchParams.get('v') ?? '';
  if (!/^[\w-]{11}$/.test(v)) {
    return html('<div class="msg"><p>That is not a valid video id.</p><p><a href="/rss">‹ Back to Reader</a></p></div>', 400);
  }

  const embed = `https://www.youtube-nocookie.com/embed/${v}?autoplay=1&rel=0&modestbranding=1`;
  const watch = `https://www.youtube.com/watch?v=${esc(v)}`;
  const body = `
  <div class="bar">
    <a href="/rss">‹ Back to Reader</a>
    <a href="${watch}" target="_blank" rel="noopener noreferrer nofollow">Watch on YouTube ↗</a>
  </div>
  <div class="player">
    <iframe src="${esc(embed)}" title="YouTube video"
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
  </div>`;
  return html(body, 200);
};
