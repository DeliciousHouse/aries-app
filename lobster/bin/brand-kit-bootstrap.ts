#!/usr/bin/env -S npx tsx
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { extractAndSaveTenantBrandKit, loadTenantBrandKit } from '@/backend/marketing/brand-kit';
import { resolveDataRoot } from '@/lib/runtime-paths';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);
  const pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/, '') || '/';
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${pathname}${parsed.search}`;
}

function assertValidatedPersistenceRoot(): string {
  const resolved = path.resolve(resolveDataRoot());
  if (resolved === '/tmp' || resolved.startsWith('/tmp/')) {
    throw new Error('runtime_persistence_unavailable:data_root_tmp');
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error('runtime_persistence_unavailable:data_root_missing');
  }
  return resolved;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = typeof args['tenant-id'] === 'string' ? args['tenant-id'].trim() : '';
  const brandUrl = normalizeUrl(typeof args['brand-url'] === 'string' ? args['brand-url'] : '');

  if (!tenantId) {
    throw new Error('runtime_persistence_unavailable:tenant_id_missing');
  }
  if (!brandUrl) {
    throw new Error('runtime_persistence_unavailable:website_url_missing');
  }

  const dataRoot = assertValidatedPersistenceRoot();
  const existing = await loadTenantBrandKit(tenantId);
  const existingMatches = !!existing && normalizeUrl(existing.source_url) === brandUrl;
  const { brandKit, filePath } = await extractAndSaveTenantBrandKit({
    tenantId,
    brandUrl,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        type: 'brand_kit_bootstrap',
        mode: 'runtime_validated_store',
        tenant_id: tenantId,
        brand_url: brandUrl,
        data_root: dataRoot,
        validated_brand_kit_path: filePath,
        bootstrap_action: existingMatches ? 'reused_existing_validated_brand_kit' : 'extracted_or_refreshed_validated_brand_kit',
        brand_kit: {
          brand_name: brandKit.brand_name,
          source_url: brandKit.source_url,
          canonical_url: brandKit.canonical_url,
          colors: brandKit.colors,
          font_families: brandKit.font_families,
          extracted_at: brandKit.extracted_at,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
