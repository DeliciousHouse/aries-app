/**
 * Stubs `globalThis.fetch` for https://brand.example so marketing orchestration tests
 * can run without network access after `startMarketingJob` extracts a tenant brand kit.
 */
export function installMarketingBrandExampleFetchMock(): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url === 'https://brand.example' || url.startsWith('https://brand.example/')) {
      if (/\.css(\?|$)/i.test(url)) {
        return new Response(`body { font-family: Arial, sans-serif; color: #111111; }`, {
          status: 200,
          headers: { 'content-type': 'text/css; charset=utf-8' },
        });
      }
      if (!/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)(\?|$)/i.test(url)) {
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>Brand Example</title><meta property="og:site_name" content="Brand Example"/></head><body><h1>Brand Example</h1></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
    }

    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}
