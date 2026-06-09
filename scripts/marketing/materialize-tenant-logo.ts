/**
 * Backfill the local brand-logo file (`logo_file_path`) for tenants whose
 * brand-kit.json was written before logo materialization shipped. New/re-enriched
 * kits get the logo automatically during enrichment; this CLI covers the
 * already-cached ones (the enrichment fast-path is deliberately network-free).
 *
 * Brand kits live as files under DATA_ROOT/generated/validated/<tenant>/, so
 * this is DB-free.
 *
 * Usage:
 *   # materialize the scraped logo for one tenant (skips if already present)
 *   tsx scripts/marketing/materialize-tenant-logo.ts --tenant 15
 *
 *   # re-materialize even if logo_file_path is already set
 *   tsx scripts/marketing/materialize-tenant-logo.ts --tenant 15 --force
 *
 *   # operator override: use a specific local image file as the logo
 *   tsx scripts/marketing/materialize-tenant-logo.ts --tenant 15 --logo-file /path/to/aries-logo.png
 *
 *   # backfill every tenant that has a brand-kit.json but no logo_file_path
 *   tsx scripts/marketing/materialize-tenant-logo.ts --all
 */
import 'dotenv/config';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { resolveDataPath } from '@/lib/runtime-paths';
import {
  downloadAndMaterializeLogo,
  loadTenantBrandKit,
  saveTenantBrandKit,
} from '@/backend/marketing/brand-kit';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const EXT_BY_EXT: Record<string, string> = {
  '.png': '.png',
  '.jpg': '.jpg',
  '.jpeg': '.jpg',
  '.webp': '.webp',
  '.gif': '.gif',
  '.svg': '.svg',
};

async function materializeFromLocalFile(tenantId: string, src: string): Promise<string> {
  const ext = EXT_BY_EXT[path.extname(src).toLowerCase()];
  if (!ext) throw new Error(`unsupported logo extension for ${src} (png/jpg/webp/gif/svg only)`);
  const dest = resolveDataPath('generated', 'validated', tenantId, `logo${ext}`);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
  return dest;
}

async function materializeOne(tenantId: string): Promise<'set' | 'skipped' | 'no-logo'> {
  const kit = await loadTenantBrandKit(tenantId);
  if (!kit) {
    console.warn(`[materialize-logo] tenant ${tenantId}: no brand-kit.json — skipping`);
    return 'skipped';
  }
  if (kit.logo_file_path && !flag('force')) {
    console.log(`[materialize-logo] tenant ${tenantId}: logo_file_path already set — skipping (use --force)`);
    return 'skipped';
  }
  const override = arg('logo-file');
  const logoPath = override
    ? await materializeFromLocalFile(tenantId, override)
    : await downloadAndMaterializeLogo({ tenantId, logoUrls: kit.logo_urls });
  if (!logoPath) {
    console.warn(`[materialize-logo] tenant ${tenantId}: no usable logo from ${kit.logo_urls.length} url(s)`);
    return 'no-logo';
  }
  kit.logo_file_path = logoPath;
  saveTenantBrandKit(tenantId, kit);
  console.log(`[materialize-logo] tenant ${tenantId}: logo_file_path = ${logoPath}`);
  return 'set';
}

async function main(): Promise<void> {
  if (flag('all')) {
    const validatedRoot = resolveDataPath('generated', 'validated');
    let entries: string[] = [];
    try {
      entries = await readdir(validatedRoot);
    } catch {
      console.error(`[materialize-logo] no validated dir at ${validatedRoot}`);
      process.exit(1);
    }
    const tenants: string[] = [];
    for (const entry of entries) {
      const s = await stat(path.join(validatedRoot, entry)).catch(() => null);
      if (s?.isDirectory()) tenants.push(entry);
    }
    let set = 0;
    for (const t of tenants) {
      if ((await materializeOne(t)) === 'set') set += 1;
    }
    console.log(`[materialize-logo] done: ${set}/${tenants.length} tenant(s) materialized`);
    return;
  }

  const tenant = arg('tenant');
  if (!tenant) {
    console.error('Usage: --tenant <id> [--force] [--logo-file <path>]  |  --all');
    process.exit(1);
  }
  await materializeOne(tenant);
}

main().catch((err) => {
  console.error('[materialize-logo] failed:', err);
  process.exit(1);
});
