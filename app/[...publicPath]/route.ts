import { resolvePublicMarketingArtifact } from '@/backend/marketing/public-pages';

export const dynamic = 'force-dynamic';

// Minimal branded 404 HTML served directly from the catch-all. The catch-all
// matches every unmatched path including any would-be redirect target, so a
// 302 back into this same handler creates an infinite loop. Route handlers
// also can't render the app-level not-found.tsx (that's a page concept, not
// a route-handler concept). Mirroring the not-found.tsx copy inline keeps
// the UX branded without a redirect.
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Page not found — Aries AI</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        background: #0a0a0f;
        color: #fff;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      .card {
        max-width: 640px;
        padding: 3rem 2.5rem;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 2.5rem;
        text-align: center;
      }
      .eyebrow {
        font-size: 0.75rem;
        letter-spacing: 0.3em;
        text-transform: uppercase;
        color: #a96cff;
        margin: 0 0 1rem;
      }
      h1 { font-size: 2.5rem; margin: 0 0 1.25rem; line-height: 1.1; }
      p { color: rgba(255, 255, 255, 0.6); font-size: 1.05rem; margin: 0 0 2rem; }
      .actions { display: flex; flex-wrap: wrap; gap: 1rem; justify-content: center; }
      a {
        padding: 0.875rem 2rem;
        border-radius: 999px;
        text-decoration: none;
        font-weight: 600;
        transition: background 0.15s ease, transform 0.1s ease;
      }
      .primary {
        background: linear-gradient(90deg, #a96cff, #7c3aed);
        color: #fff;
        box-shadow: 0 12px 32px rgba(124, 58, 237, 0.25);
      }
      .primary:hover { transform: translateY(-1px); }
      .secondary {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      .secondary:hover { background: rgba(255, 255, 255, 0.1); }
    </style>
  </head>
  <body>
    <main class="card">
      <p class="eyebrow">404</p>
      <h1>This route doesn&rsquo;t exist in the Aries runtime</h1>
      <p>Head back to the homepage or go to login.</p>
      <div class="actions">
        <a class="primary" href="/">Back to home</a>
        <a class="secondary" href="/login">Go to login</a>
      </div>
    </main>
  </body>
</html>
`;

function responseForPath(pathname: string, headOnly = false): Response {
  const artifact = resolvePublicMarketingArtifact(pathname);
  if (!artifact) {
    // Return a 404 directly with branded HTML. Do NOT redirect to another path
    // — the catch-all pattern matches every URL including the redirect target,
    // which would create an infinite 302 loop. Keeping the response as a 404
    // Response with inlined HTML preserves the branded UX without needing a
    // route-handler-to-page bridge (route handlers can't trigger not-found.tsx).
    return new Response(headOnly ? null : NOT_FOUND_HTML, {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  return new Response(headOnly ? null : artifact.body, {
    status: 200,
    headers: {
      'content-type': artifact.contentType,
      'cache-control': artifact.cacheControl,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  return responseForPath(new URL(request.url).pathname);
}

export async function HEAD(request: Request): Promise<Response> {
  return responseForPath(new URL(request.url).pathname, true);
}
