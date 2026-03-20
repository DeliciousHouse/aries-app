import { NextRequest, NextResponse } from 'next/server';

const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const BLOCKLIST = ['localhost', '127.0.0.1', 'example.com', '0.0.0.0'];

function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'https:') return 'Only HTTPS URLs are allowed';

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKLIST.some((b) => hostname === b || hostname.endsWith('.' + b))) {
    return 'Domain not allowed';
  }

  if (IP_REGEX.test(hostname)) {
    return 'IP addresses are not allowed';
  }

  return null;
}

function extractMeta(html: string, baseUrl: string): {
  title: string;
  favicon: string;
  domain: string;
  description: string;
} {
  const domain = new URL(baseUrl).hostname;

  // Title
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : domain;

  // Description
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)
    || html.match(/<meta[^>]+content=["']([^"']*)[^>]+name=["']description["']/i)
    || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i);
  const description = descMatch ? descMatch[1].trim() : '';

  // Favicon — look for link rel=icon/shortcut icon, then og:image, then default /favicon.ico
  const faviconMatch = html.match(/<link[^>]+rel=["'](?:shortcut icon|icon)["'][^>]+href=["']([^"']+)/i)
    || html.match(/<link[^>]+href=["']([^"']+)[^>]+rel=["'](?:shortcut icon|icon)["']/i);

  let favicon = '';
  if (faviconMatch) {
    const raw = faviconMatch[1];
    if (raw.startsWith('http')) {
      favicon = raw;
    } else if (raw.startsWith('//')) {
      favicon = `https:${raw}`;
    } else {
      const origin = new URL(baseUrl).origin;
      favicon = `${origin}${raw.startsWith('/') ? raw : `/${raw}`}`;
    }
  } else {
    const origin = new URL(baseUrl).origin;
    favicon = `${origin}/favicon.ico`;
  }

  return { title, favicon, domain, description };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  const decodedUrl = decodeURIComponent(url);
  const validationError = validateUrl(decodedUrl);

  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(decodedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AriesBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return NextResponse.json({ error: `Site returned ${res.status}` }, { status: 422 });
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      // Return minimal metadata for non-HTML responses
      const domain = new URL(decodedUrl).hostname;
      return NextResponse.json({ title: domain, favicon: '', domain, description: '' });
    }

    // Read up to 50KB to find meta tags
    const reader = res.body?.getReader();
    let html = '';
    if (reader) {
      let done = false;
      while (!done && html.length < 50_000) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) html += new TextDecoder().decode(value);
      }
      reader.cancel().catch(() => {});
    }

    const meta = extractMeta(html, decodedUrl);
    return NextResponse.json(meta);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json({ error: 'Request timed out' }, { status: 504 });
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to fetch: ${msg}` }, { status: 502 });
  }
}
