import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { safeHref } from '../lib/safe-href';

describe('safeHref', () => {
  it('accepts absolute http and https URLs', () => {
    assert.equal(safeHref('https://example.com/foo'), 'https://example.com/foo');
    assert.equal(safeHref('http://example.com/foo'), 'http://example.com/foo');
    assert.equal(
      safeHref('https://cdn.example.com/assets/abc.webp?v=1#x'),
      'https://cdn.example.com/assets/abc.webp?v=1#x',
    );
  });

  it('accepts same-origin relative paths and fragment/query-only refs', () => {
    assert.equal(safeHref('/assets/foo.png'), '/assets/foo.png');
    assert.equal(safeHref('./foo.png'), './foo.png');
    assert.equal(safeHref('../foo.png'), '../foo.png');
    assert.equal(safeHref('?search=x'), '?search=x');
    assert.equal(safeHref('#section'), '#section');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(safeHref('  https://example.com/foo  '), 'https://example.com/foo');
  });

  it('rejects javascript:, data:, vbscript:, and file: schemes', () => {
    assert.equal(safeHref('javascript:alert(1)'), null);
    assert.equal(safeHref('JavaScript:alert(1)'), null);
    assert.equal(safeHref('  javascript:alert(1)  '), null);
    assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), null);
    assert.equal(safeHref('vbscript:msgbox'), null);
    assert.equal(safeHref('file:///etc/passwd'), null);
  });

  it('rejects scheme-relative URLs', () => {
    assert.equal(safeHref('//evil.example.com/steal'), null);
    assert.equal(safeHref('//example.com'), null);
  });

  it('rejects mailto, tel, and other non-http(s) schemes', () => {
    assert.equal(safeHref('mailto:foo@example.com'), null);
    assert.equal(safeHref('tel:+1234567890'), null);
    assert.equal(safeHref('ftp://example.com/file'), null);
  });

  it('rejects empty / whitespace / non-string input', () => {
    assert.equal(safeHref(''), null);
    assert.equal(safeHref('   '), null);
    assert.equal(safeHref(null), null);
    assert.equal(safeHref(undefined), null);
    // @ts-expect-error -- intentionally passing wrong type at runtime
    assert.equal(safeHref(42), null);
    // @ts-expect-error -- intentionally passing wrong type at runtime
    assert.equal(safeHref({ href: 'https://example.com' }), null);
  });

  it('rejects malformed URLs that throw from the URL constructor', () => {
    assert.equal(safeHref('http:// not a url'), null);
    assert.equal(safeHref('https:'), null);
  });
});
