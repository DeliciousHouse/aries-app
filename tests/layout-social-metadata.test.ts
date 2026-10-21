import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// app/layout.tsx imports globals.css, which tsx cannot load, so assert on the source.
const layout = fs.readFileSync(path.join(process.cwd(), 'app', 'layout.tsx'), 'utf8');

test('root layout ships openGraph, twitter and theme-color metadata', () => {
  assert.match(layout, /openGraph:\s*\{/);
  assert.match(layout, /card:\s*'summary_large_image'/);
  assert.match(layout, /themeColor:\s*'#050505'/);
  assert.match(layout, /width:\s*1200,\s*\n\s*height:\s*630/);
  assert.match(layout, /metadataBase:\s*new URL\(metadataSiteOrigin\(\)\)/);
});

test('og image is a 1200x630 PNG in public/', () => {
  const png = fs.readFileSync(path.join(process.cwd(), 'public', 'og-image.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});
