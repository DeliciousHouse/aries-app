import { diffLines } from 'diff';

export function createDiff(oldText, newText) {
  const changes = diffLines(oldText, newText);
  const lines = [];

  for (const part of changes) {
    const prefix = part.added ? '+' : part.removed ? '-' : ' ';
    const partLines = part.value.split('\n').filter(l => l.length > 0);
    for (const line of partLines) {
      lines.push(`${prefix} ${line}`);
    }
  }

  return lines.join('\n');
}

export function createHtmlDiff(oldText, newText) {
  const changes = diffLines(oldText, newText);
  const html = [];

  for (const part of changes) {
    const escaped = escapeHtml(part.value);
    if (part.added) {
      html.push(`<ins>${escaped}</ins>`);
    } else if (part.removed) {
      html.push(`<del>${escaped}</del>`);
    } else {
      html.push(`<span>${escaped}</span>`);
    }
  }

  return html.join('');
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
