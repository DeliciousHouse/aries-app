import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderSimpleMarkdown } from '../lib/simple-markdown';

describe('renderSimpleMarkdown', () => {
  it('renders ATX headings', () => {
    assert.equal(renderSimpleMarkdown('# Hello'), '<h1>Hello</h1>');
    assert.equal(renderSimpleMarkdown('### Third'), '<h3>Third</h3>');
  });

  it('wraps paragraph text', () => {
    assert.equal(renderSimpleMarkdown('Just a sentence.'), '<p>Just a sentence.</p>');
  });

  it('joins consecutive non-blank lines into one paragraph', () => {
    assert.equal(
      renderSimpleMarkdown('Line one\nLine two'),
      '<p>Line one Line two</p>',
    );
  });

  it('breaks on blank lines', () => {
    assert.equal(
      renderSimpleMarkdown('First.\n\nSecond.'),
      '<p>First.</p>\n<p>Second.</p>',
    );
  });

  it('renders unordered lists', () => {
    const out = renderSimpleMarkdown('- one\n- two\n- three');
    assert.ok(out.startsWith('<ul>'));
    assert.ok(out.includes('<li>one</li>'));
    assert.ok(out.includes('<li>two</li>'));
    assert.ok(out.endsWith('</ul>'));
  });

  it('renders ordered lists', () => {
    const out = renderSimpleMarkdown('1. first\n2. second');
    assert.ok(out.startsWith('<ol>'));
    assert.ok(out.includes('<li>first</li>'));
    assert.ok(out.includes('<li>second</li>'));
    assert.ok(out.endsWith('</ol>'));
  });

  it('renders bold and italic', () => {
    assert.equal(renderSimpleMarkdown('**bold**'), '<p><strong>bold</strong></p>');
    assert.equal(renderSimpleMarkdown('*italic*'), '<p><em>italic</em></p>');
  });

  it('renders inline code', () => {
    assert.equal(renderSimpleMarkdown('call `foo()`'), '<p>call <code>foo()</code></p>');
  });

  it('renders fenced code blocks', () => {
    const out = renderSimpleMarkdown('```ts\nconst x = 1;\n```');
    assert.ok(out.includes('<pre><code'));
    assert.ok(out.includes('const x = 1;'));
    assert.ok(out.includes('</code></pre>'));
  });

  it('escapes HTML in source before applying markdown rules', () => {
    const out = renderSimpleMarkdown('# <script>alert(1)</script>');
    assert.ok(out.includes('&lt;script&gt;'));
    assert.ok(!out.includes('<script>'));
  });

  it('rejects javascript: and data: link schemes while keeping the label visible', () => {
    const outJs = renderSimpleMarkdown('[click](javascript:alert)');
    assert.ok(outJs.includes('<span>click</span>'));
    assert.ok(!outJs.includes('javascript:'));

    const outData = renderSimpleMarkdown('[raw](data:text/plain,abc)');
    assert.ok(outData.includes('<span>raw</span>'));
    assert.ok(!outData.includes('data:'));
  });

  it('renders safe links with target=_blank rel=noopener', () => {
    const out = renderSimpleMarkdown('[docs](https://example.com/foo)');
    assert.ok(out.includes('href="https://example.com/foo"'));
    assert.ok(out.includes('target="_blank"'));
    assert.ok(out.includes('rel="noopener noreferrer"'));
    assert.ok(out.includes('>docs</a>'));
  });

  it('renders blockquotes', () => {
    assert.equal(renderSimpleMarkdown('> quoted'), '<blockquote>quoted</blockquote>');
  });

  it('renders horizontal rules', () => {
    assert.equal(renderSimpleMarkdown('---'), '<hr />');
  });

  it('handles a mixed document end-to-end', () => {
    const source = [
      '# Brand Bible',
      '',
      'This is our **core** message.',
      '',
      '## Voice',
      '',
      '- Confident',
      '- Curious',
      '- Clear',
      '',
      'See the [site](https://example.com) for more.',
    ].join('\n');
    const out = renderSimpleMarkdown(source);
    assert.ok(out.includes('<h1>Brand Bible</h1>'));
    assert.ok(out.includes('<strong>core</strong>'));
    assert.ok(out.includes('<h2>Voice</h2>'));
    assert.ok(out.includes('<ul>'));
    assert.ok(out.includes('<li>Confident</li>'));
    assert.ok(out.includes('href="https://example.com"'));
  });
});
