/**
 * Read a request body as text without ever buffering more than `maxBytes`.
 * Counts the actual stream (so a missing/chunked Content-Length can't bypass
 * the cap) and aborts mid-read past the limit, returning the OVER_LIMIT
 * sentinel. Extracted from app/api/feedback/route.ts so both feedback
 * endpoints share one hardened reader.
 */

export const OVER_LIMIT = Symbol('over-limit');

export async function readBodyCapped(
  req: Request,
  maxBytes: number,
): Promise<string | typeof OVER_LIMIT> {
  // Fast path: an honest oversized Content-Length is rejected before reading.
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return OVER_LIMIT;

  const reader = req.body?.getReader();
  if (!reader) {
    const text = await req.text();
    return Buffer.byteLength(text) > maxBytes ? OVER_LIMIT : text;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return OVER_LIMIT;
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}
