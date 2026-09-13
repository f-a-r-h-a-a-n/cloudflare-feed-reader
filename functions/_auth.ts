/**
 * The owner gate. THIS IS THE FILE YOU REPLACE.
 *
 * As shipped it verifies a Cloudflare Access JWT: issuer, audience (AUD) and
 * signature against the team's rotating public keys, then checks the email
 * against a mandatory allowlist. Access enforces identity at the edge; this is
 * the in-function belt and braces, so a request that somehow reaches the
 * Function without a valid identity is still refused.
 *
 * To use a different gate, replace this file with your own implementation of
 * the same contract and change nothing else:
 *
 *   requireOwner(request: Request, env: Env): Promise<OwnerAuth | OwnerDenied>
 *
 * Return `{ ok: true, email, dev }` to admit the request, or `{ ok: false,
 * response }` with a ready-to-return Response to refuse it. All four routes
 * call it the same way and none of them inspects anything else.
 *
 * Two rules any replacement should keep. Fail CLOSED: refuse when the gate is
 * misconfigured rather than admitting the request, because a reader holds
 * whatever its owner subscribes to. And keep the localhost bypass conditional
 * on the absence of gate configuration, not on the Host header, so a production
 * request carrying `Host: localhost` cannot take the development path.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './_lib';

export interface OwnerAuth {
  ok: true;
  email: string;
  /** True when running under local dev with no Access enforcement. */
  dev: boolean;
}
export interface OwnerDenied {
  ok: false;
  response: Response;
}

// Module-scope cache of the JWKS; survives warm invocations, re-created if the
// team domain ever changes.
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksTeam: string | null = null;

function isLocalhost(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

function allowlist(env: Env): string[] {
  return (env.READER_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function deny(status: number, detail: string): Response {
  const doc =
    `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>Not available</title></head>` +
    `<body style="margin:0;background:oklch(0.973 0 0);color:#1A1A1A;font:1.0625rem/1.7 Georgia,serif">` +
    `<main style="max-width:34rem;margin:0 auto;padding:5rem 2rem">` +
    `<div style="border-top:2px solid #1C1C1C;padding-top:1.25rem">` +
    `<h1 style="font-weight:400;font-size:1.5rem;color:#1A1A1A;margin:0 0 1rem">Not available</h1>` +
    `<p style="margin:0">${detail}</p></div></main></body></html>`;
  return new Response(doc, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Gate an owner-only request. Returns the verified identity, or a ready-to-return
 * Response (403/500) that the caller returns as-is.
 *
 * `audience` defaults to CF_ACCESS_AUD. Pass one explicitly only if you gate
 * several areas with separate Access applications and want this one to accept a
 * different application's token.
 */
export async function requireOwner(
  request: Request,
  env: Env,
  audience: string | undefined = env.CF_ACCESS_AUD,
): Promise<OwnerAuth | OwnerDenied> {
  const url = new URL(request.url);
  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = audience;

  // Local dev only: bypass when Access is not configured (genuine `wrangler pages
  // dev`). Gating on the absence of Access env means a production request carrying
  // a spoofed `Host: localhost` cannot take this path, because production sets
  // aud/team. Fail closed otherwise: never serve the reader unprotected.
  if (!team || !aud) {
    if (isLocalhost(url)) return { ok: true, email: 'dev@localhost', dev: true };
    return { ok: false, response: deny(500, 'This area is not configured (Cloudflare Access is not set up on this deployment).') };
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? readCookie(request, 'CF_Authorization');
  if (!token) {
    return { ok: false, response: deny(403, 'No Cloudflare Access identity was presented for this request.') };
  }

  const issuer = `https://${team}`;
  if (!jwksCache || jwksTeam !== team) {
    jwksCache = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksTeam = team;
  }

  let email: string;
  try {
    const { payload } = await jwtVerify(token, jwksCache, { issuer, audience: aud });
    email = String(payload.email ?? '').toLowerCase();
  } catch {
    return { ok: false, response: deny(403, 'The Cloudflare Access token failed verification.') };
  }

  // The in-function allowlist is mandatory: the reader must not rest on the edge
  // Access policy alone. Fail closed if it is unset, deny if not on it.
  const allowed = allowlist(env);
  if (allowed.length === 0) {
    return { ok: false, response: deny(500, 'The owner allowlist (READER_ALLOWED_EMAILS) is not configured.') };
  }
  if (!allowed.includes(email)) {
    return { ok: false, response: deny(403, 'This identity is not on the owner allowlist.') };
  }

  return { ok: true, email, dev: false };
}
