#!/usr/bin/env node
const baseUrl = process.env.APP_BASE_URL || 'http://127.0.0.1:3000';
const res = await fetch(`${baseUrl}/creative-memory`);
if (!res.ok) throw new Error(`Creative Memory UI smoke failed: ${res.status}`);
const html = await res.text();
for (const needle of ['Campaign Learning', 'Baseline vs memory-assisted', 'Prompt Preview']) {
  if (!html.includes(needle)) throw new Error(`Creative Memory UI missing ${needle}`);
}
console.log(JSON.stringify({ status: 'ok', baseUrl }, null, 2));
