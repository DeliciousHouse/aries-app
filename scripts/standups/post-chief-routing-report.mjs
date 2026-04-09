#!/usr/bin/env node
import fs from 'node:fs/promises';

const inputPath = process.argv[2];
const endpoint = process.env.MISSION_CONTROL_ROUTING_ENDPOINT || 'http://127.0.0.1:4174/api/routing-requests/from-chief-report';

if (!inputPath) {
  console.error('Usage: node team/standups/post-chief-routing-report.mjs <report.json>');
  process.exit(1);
}

const raw = await fs.readFile(inputPath, 'utf8');
const payload = JSON.parse(raw);
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
  },
  body: JSON.stringify(payload),
});

const body = await response.text();
if (!response.ok) {
  console.error(body);
  process.exit(response.status || 1);
}

console.log(body);
