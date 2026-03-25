# Meta Ad Library DOM Selectors

Use these browser-evaluate snippets when extracting assets from Meta Ad Library pages.

## 1) Extract the correct Ad Library page id

```javascript
(() => {
  const html = document.documentElement.innerHTML;
  const delegate = html.match(/"delegate_page":\{[^}]*"id":"(\d+)"/);
  const androidUrl = document.querySelector('meta[property="al:android:url"]')?.content || "";
  const profile = androidUrl.match(/fb:\/\/profile\/(\d+)/);

  const delegate_page_id = delegate?.[1] || null;
  const fallback_profile_id = profile?.[1] || null;

  return JSON.stringify(
    {
      delegate_page_id,
      fallback_profile_id,
      recommended_page_id: delegate_page_id || fallback_profile_id || null,
    },
    null,
    2,
  );
})();
```

## 2) Extract image/video assets and CTA urls

```javascript
(() => {
  const normalize = (url) => (url || "").replace(/&amp;/g, "&").trim();

  const dedupeBy = (items, keyFn) => {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const key = keyFn(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };

  const images = dedupeBy(
    [...document.querySelectorAll("img")]
      .map((img, index) => ({
        index: index + 1,
        url: normalize(img.currentSrc || img.src),
        alt: (img.alt || "").trim(),
        width: img.naturalWidth || null,
        height: img.naturalHeight || null,
      }))
      .filter(
        (item) =>
          /fbcdn\.net/i.test(item.url) &&
          /(s600x600|s\d+x\d+|p\d+x\d+)/i.test(item.url),
      ),
    (item) => item.url,
  );

  const videos = dedupeBy(
    [...document.querySelectorAll("video")]
      .map((video, index) => ({
        index: index + 1,
        url: normalize(video.currentSrc || video.src),
        poster: normalize(video.poster || ""),
        muted: !!video.muted,
        autoplay: !!video.autoplay,
        controls: !!video.controls,
      }))
      .filter(
        (item) =>
          /fbcdn\.net/i.test(item.url || "") ||
          /fbcdn\.net/i.test(item.poster || ""),
      ),
    (item) => item.url || item.poster,
  );

  const ctaRegex =
    /^(Learn More|Shop Now|Sign Up|Download|Get Offer|Book Now|Apply Now|Contact Us|Subscribe|Watch More|See More)$/i;

  const ctas = dedupeBy(
    [...document.querySelectorAll("a")]
      .map((a) => ({
        text: (a.textContent || "").trim(),
        url: normalize(a.href || ""),
      }))
      .filter(
        (item) =>
          ctaRegex.test(item.text) &&
          item.url &&
          !/facebook\.com\/ads\/library/i.test(item.url),
      ),
    (item) => `${item.text}::${item.url}`,
  );

  return JSON.stringify({ images, videos, ctas }, null, 2);
})();
```

## 3) Scroll helper for lazy-loaded ads

```javascript
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 8; i += 1) {
    window.scrollTo(0, document.body.scrollHeight);
    await wait(1500);
  }
  return JSON.stringify({
    ok: true,
    scrollY: window.scrollY,
    pageHeight: document.body.scrollHeight,
  });
})();
```

## Notes

- Prefer `delegate_page_id` over fallback profile id whenever it exists.
- Re-run the asset extraction after each scroll batch; the library lazy-loads more ad cards.
- Download assets promptly after extraction because `fbcdn.net` URLs can expire.
