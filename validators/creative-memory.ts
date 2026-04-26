import { creativeAssetPermissionScopes, creativeAssetSourceTypes, type CreativeMemoryBrief } from '@/types/creative-memory';

export class CreativeMemoryValidationError extends Error {
  constructor(readonly reason: string, message: string, readonly field?: string) { super(message); this.name = 'CreativeMemoryValidationError'; }
}

const sensitiveResponseKeys = new Set([
  'tenantId','tenant_id','storageKey','storage_key','fileUrl','file_url','absolutePath','absolute_path','path','host','hostname','sourceUrl','source_url','canonicalUrl','canonical_url'
]);

const maxFieldLengths: Record<string, number> = {
  objective: 240,
  platform: 48,
  placement: 80,
  aspectRatio: 24,
  funnelStage: 32,
  offer: 240,
  audience: 240,
  creativeType: 120,
  cta: 160,
};

export function assertValidPermissionScope(scope: string): void {
  if (!(creativeAssetPermissionScopes as readonly string[]).includes(scope)) throw new CreativeMemoryValidationError('invalid_permission_scope', `Invalid permission scope: ${scope}`, 'permissionScope');
}
export function assertValidSourceType(sourceType: string): void {
  if (!(creativeAssetSourceTypes as readonly string[]).includes(sourceType)) throw new CreativeMemoryValidationError('invalid_source_type', `Invalid source type: ${sourceType}`, 'sourceType');
}
export function assertNoCompetitorDirectExample(input: { sourceType?: string | null; permissionScope?: string | null; directExample?: boolean }): void {
  const isCompetitor = input.sourceType === 'competitor_meta_ad' || input.permissionScope === 'public_ad_library';
  if (input.directExample && isCompetitor) throw new CreativeMemoryValidationError('competitor_direct_example_forbidden','Competitor material can only inform abstract market patterns, never direct visual examples.');
}
export function assertExactImageTextRequired(brief: Pick<CreativeMemoryBrief,'imageText'|'creativeType'>): void {
  if (!Array.isArray(brief.imageText) || brief.imageText.filter((line) => line.trim()).length === 0) throw new CreativeMemoryValidationError('exact_image_text_required','Image generation requires exact image text.','imageText');
}
export function validatePromptContextBudget(input: { tokenEstimate: number; maxTokens: number }): void {
  if (!Number.isFinite(input.tokenEstimate) || input.tokenEstimate > input.maxTokens) throw new CreativeMemoryValidationError('context_budget_exceeded','Creative Memory context pack exceeds the prompt budget.');
}

const safeAssetSegment = /^[A-Za-z0-9._~-]+$/;

export function sanitizeServedAssetRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  if (!ref || !ref.startsWith('/') || ref.startsWith('//')) return null;
  if (ref.includes('?') || ref.includes('#') || ref.includes('\\')) return null;
  if (/^\/(?:home|mnt|tmp|var|etc|root)\b/i.test(ref)) return null;
  const segments = ref.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..' || !safeAssetSegment.test(segment))) return null;
  const apiAssetRef = segments.length === 6 && segments[0] === 'api' && segments[1] === 'marketing' && segments[2] === 'jobs' && segments[4] === 'assets';
  const materialRef = segments.length === 3 && segments[0] === 'materials';
  if (!apiAssetRef && !materialRef) return null;
  return `/${segments.join('/')}`;
}

export function assertFrontendSafeValue(value: unknown): void {
  const seen = new Set<unknown>();
  const visit = (v: unknown, key?: string): void => {
    if (key && sensitiveResponseKeys.has(key)) throw new CreativeMemoryValidationError('unsafe_response', `Creative Memory response contains unsafe key: ${key}`);
    if (typeof v === 'string') {
      if (/\b[A-Za-z]:\\/.test(v) || v.includes('/home/') || v.includes('/mnt/') || v.includes('file://')) throw new CreativeMemoryValidationError('unsafe_response','Creative Memory response contains a raw filesystem path.');
      if (/^\/\//.test(v) || /s3\.amazonaws\.com|amazonaws\.com|storage\.googleapis\.com|blob\.core\.windows\.net/i.test(v)) throw new CreativeMemoryValidationError('unsafe_response','Creative Memory response contains a raw external asset URL.');
      return;
    }
    if (Array.isArray(v)) { v.forEach((item) => visit(item)); return; }
    if (v && typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      Object.entries(v as Record<string, unknown>).forEach(([childKey, childValue]) => visit(childValue, childKey));
    }
  };
  visit(value);
}

function boundedString(record: Record<string, unknown>, field: keyof CreativeMemoryBrief & string): string {
  const max = maxFieldLengths[field] ?? 200;
  const value = String(record[field] ?? '').trim();
  if (!value) throw new CreativeMemoryValidationError('invalid_request', `${field} is required.`, field);
  if (value.length > max) throw new CreativeMemoryValidationError('invalid_request', `${field} is too long.`, field);
  return value;
}
function boundedStringArray(record: Record<string, unknown>, field: string, maxItems: number, maxChars: number, required = false): string[] {
  const raw = record[field];
  if (!Array.isArray(raw)) {
    if (required) throw new CreativeMemoryValidationError('invalid_request', `${field} is required.`, field);
    return [];
  }
  if (raw.length > maxItems) throw new CreativeMemoryValidationError('invalid_request', `${field} has too many items.`, field);
  const values = raw.map((item, index) => {
    const value = String(item ?? '').trim();
    if (value.length > maxChars) throw new CreativeMemoryValidationError('invalid_request', `${field}[${index}] is too long.`, field);
    return value;
  }).filter(Boolean);
  if (required && values.length === 0) throw new CreativeMemoryValidationError('invalid_request', `${field} is required.`, field);
  return values;
}
export function parseCreativeMemoryBrief(input: unknown): CreativeMemoryBrief {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CreativeMemoryValidationError('invalid_request', 'JSON object body is required.');
  const obj = input as Record<string, unknown>;
  const brief = (obj.brief && typeof obj.brief === 'object' && !Array.isArray(obj.brief) ? obj.brief : obj) as Record<string, unknown>;
  const imageText = boundedStringArray(brief, 'imageText', 6, 120, false);
  if (imageText.length === 0) throw new CreativeMemoryValidationError('exact_image_text_required','Image generation requires exact image text.','imageText');
  const parsed: CreativeMemoryBrief = {
    objective: boundedString(brief, 'objective'),
    platform: boundedString(brief, 'platform'),
    placement: boundedString(brief, 'placement'),
    aspectRatio: boundedString(brief, 'aspectRatio'),
    funnelStage: boundedString(brief, 'funnelStage'),
    offer: boundedString(brief, 'offer'),
    audience: boundedString(brief, 'audience'),
    creativeType: boundedString(brief, 'creativeType'),
    cta: boundedString(brief, 'cta'),
    imageText,
    mustUseCopy: boundedStringArray(brief, 'mustUseCopy', 8, 160),
    mustAvoidAesthetics: boundedStringArray(brief, 'mustAvoidAesthetics', 12, 120)
  };
  assertExactImageTextRequired(parsed);
  return parsed;
}

export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new CreativeMemoryValidationError('invalid_request', 'Malformed JSON body.');
  }
}
