import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { repairStaleMarketingOffer } from '../backend/marketing/brand-kit';

type Args = {
  apply: boolean;
  dataRoot: string;
  tenantId: string | null;
  jobId: string | null;
};

type RepairResult = {
  path: string;
  kind: 'business-profile' | 'workspace';
  before: string;
  after: string;
};

type OfferContext = {
  brandIdentitySummary?: string | null;
  brandIdentityOffer?: string | null;
  brandKitOfferSummary?: string | null;
  positioning?: string | null;
};

function parseArgs(argv: string[]): Args {
  let apply = false;
  let tenantId: string | null = null;
  let jobId: string | null = null;
  let dataRoot = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--data-root') {
      dataRoot = argv[i + 1] || dataRoot;
      i += 1;
      continue;
    }
    if (arg === '--tenant') {
      tenantId = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === '--job') {
      jobId = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: npx tsx scripts/repair-stale-brand-offers.ts [--apply] [--data-root <path>] [--tenant <id>] [--job <jobId>]',
          '',
          'Dry-run by default. Repairs stale product-offer text when the surrounding business context clearly describes a coaching/service brand.',
        ].join('\n'),
      );
      process.exit(0);
    }
  }

  return { apply, dataRoot, tenantId, jobId };
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: Record<string, unknown>): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function siblingOfferContext(filePath: string): OfferContext {
  const siblingBrandProfilePath = path.join(path.dirname(filePath), 'brand-profile.json');
  const siblingBrandProfile = readJson(siblingBrandProfilePath);
  if (!siblingBrandProfile) return {};
  return {
    brandIdentitySummary: stringValue(siblingBrandProfile.summary),
    brandIdentityOffer: stringValue(siblingBrandProfile.offer),
    brandKitOfferSummary: stringValue(siblingBrandProfile.offer_summary),
    positioning: stringValue(siblingBrandProfile.positioning),
  };
}

function tenantOfferContext(dataRoot: string, tenantId: string | null): OfferContext {
  if (!tenantId) return {};
  const siblingBrandProfilePath = path.join(dataRoot, 'generated', 'validated', tenantId, 'brand-profile.json');
  const siblingBrandProfile = readJson(siblingBrandProfilePath);
  if (!siblingBrandProfile) return {};
  return {
    brandIdentitySummary: stringValue(siblingBrandProfile.summary),
    brandIdentityOffer: stringValue(siblingBrandProfile.offer),
    brandKitOfferSummary: stringValue(siblingBrandProfile.offer_summary),
    positioning: stringValue(siblingBrandProfile.positioning),
  };
}

function repairBusinessProfile(filePath: string): RepairResult | null {
  const record = readJson(filePath);
  if (!record) return null;
  const context = siblingOfferContext(filePath);
  const before = stringValue(record.offer);
  const after = repairStaleMarketingOffer({
    offer: before,
    brandName: stringValue(record.business_name),
    businessType: stringValue(record.business_type),
    primaryGoal: stringValue(record.primary_goal),
    brandVoice: stringValue(record.brand_voice),
    notes: stringValue(record.notes),
    ...context,
  });
  if (!before || !after || before === after) return null;
  record.offer = after;
  record.updated_at = new Date().toISOString();
  return { path: filePath, kind: 'business-profile', before, after };
}

function repairWorkspace(filePath: string, dataRoot: string): RepairResult | null {
  const record = readJson(filePath);
  const brief = record?.brief;
  if (!record || !brief || typeof brief !== 'object' || Array.isArray(brief)) return null;
  const briefRecord = brief as Record<string, unknown>;
  const context = tenantOfferContext(dataRoot, stringValue(record.tenant_id));
  const before = stringValue(briefRecord.offer);
  const after = repairStaleMarketingOffer({
    offer: before,
    brandName: stringValue(briefRecord.businessName),
    businessType: stringValue(briefRecord.businessType),
    primaryGoal: stringValue(briefRecord.goal),
    brandVoice: stringValue(briefRecord.brandVoice),
    notes: stringValue(briefRecord.notes),
    ...context,
  });
  if (!before || !after || before === after) return null;
  briefRecord.offer = after;
  record.updated_at = new Date().toISOString();
  return { path: filePath, kind: 'workspace', before, after };
}

function businessProfilePaths(dataRoot: string, tenantId: string | null): string[] {
  const validatedRoot = path.join(dataRoot, 'generated', 'validated');
  if (tenantId) {
    return [path.join(validatedRoot, tenantId, 'business-profile.json')].filter((filePath) => existsSync(filePath));
  }
  if (!existsSync(validatedRoot)) return [];
  return readdirSync(validatedRoot)
    .map((entry) => path.join(validatedRoot, entry, 'business-profile.json'))
    .filter((filePath) => existsSync(filePath));
}

function workspacePaths(dataRoot: string, tenantId: string | null, jobId: string | null): string[] {
  const root = path.join(dataRoot, 'generated', 'draft', 'marketing-workspaces');
  if (jobId) {
    const filePath = path.join(root, jobId, 'workspace.json');
    return existsSync(filePath) ? [filePath] : [];
  }
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const dirPath = path.join(root, entry);
    let stat;
    try {
      stat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const filePath = path.join(dirPath, 'workspace.json');
    if (!existsSync(filePath)) continue;
    if (!tenantId) {
      out.push(filePath);
      continue;
    }
    const record = readJson(filePath);
    if (stringValue(record?.tenant_id) === tenantId) {
      out.push(filePath);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  process.env.DATA_ROOT = args.dataRoot;

  const results: RepairResult[] = [];

  for (const filePath of businessProfilePaths(args.dataRoot, args.tenantId)) {
    const repaired = repairBusinessProfile(filePath);
    if (!repaired) continue;
    results.push(repaired);
    if (args.apply) {
      const record = readJson(filePath);
      if (record) {
        record.offer = repaired.after;
        record.updated_at = new Date().toISOString();
        writeJson(filePath, record);
      }
    }
  }

  for (const filePath of workspacePaths(args.dataRoot, args.tenantId, args.jobId)) {
    const repaired = repairWorkspace(filePath, args.dataRoot);
    if (!repaired) continue;
    results.push(repaired);
    if (args.apply) {
      const record = readJson(filePath);
      const brief = record?.brief;
      if (record && brief && typeof brief === 'object' && !Array.isArray(brief)) {
        (brief as Record<string, unknown>).offer = repaired.after;
        record.updated_at = new Date().toISOString();
        writeJson(filePath, record);
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        apply: args.apply,
        dataRoot: args.dataRoot,
        tenantId: args.tenantId,
        jobId: args.jobId,
        repaired: results,
        repairedCount: results.length,
      },
      null,
      2,
    ),
  );
}

main();
