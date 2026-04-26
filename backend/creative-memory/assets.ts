import type { SelectedCreativeExample } from '@/types/creative-memory';
import { assertFrontendSafeResponse } from './errors';
import type { QueryClient } from './profileContext';
import { requireNumericTenantId, type TenantContext } from './tenant';
import { sanitizeServedAssetRef } from '@/validators/creative-memory';

const directGenerationPermissionScopes = new Set(['owned', 'generated']);
const directGenerationSourceTypes = new Set(['owned_instagram', 'owned_facebook', 'owned_meta_ad', 'generated_by_aries']);

function normalizedString(value: unknown): string {
  return String(value ?? '').trim();
}

function parseExactImageText(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 6);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function isCreativeAssetEligibleForDirectGeneration(row: Record<string, unknown>): boolean {
  const sourceType = normalizedString(row.source_type);
  const permissionScope = normalizedString(row.permission_scope);
  const lifecycle = normalizedString(row.learning_lifecycle || 'observed');
  const usable = row.usable_for_generation === true || row.usable_for_generation === 'true';
  if (!usable) return false;
  if (sourceType === 'competitor_meta_ad' || permissionScope === 'public_ad_library') return false;
  if (!directGenerationSourceTypes.has(sourceType)) return false;
  if (!directGenerationPermissionScopes.has(permissionScope)) return false;
  return lifecycle === 'approved_for_generation';
}

export async function listCreativeAssets(ctx: TenantContext, db: QueryClient): Promise<SelectedCreativeExample[]> {
  const tenantId = requireNumericTenantId(ctx);
  const rows = await db.query<Record<string, unknown>>(`SELECT * FROM creative_assets WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`, [tenantId]);
  return rows.rows.map((row) => projectSafeCreativeAsset(row)).filter((asset): asset is SelectedCreativeExample => Boolean(asset));
}

export function projectSafeCreativeAsset(row: Record<string, unknown>): SelectedCreativeExample | null {
  if (!isCreativeAssetEligibleForDirectGeneration(row)) return null;
  const servedAssetRef = sanitizeServedAssetRef(row.served_asset_ref);
  const mediaType = normalizedString(row.media_type || 'image');
  if (mediaType === 'image' && !servedAssetRef) return null;
  const exactImageText = parseExactImageText(row.exact_image_text);
  const projected: SelectedCreativeExample = {
    id: normalizedString(row.id),
    sourceType: normalizedString(row.source_type),
    permissionScope: normalizedString(row.permission_scope),
    mediaType,
    servedAssetRef,
    exactImageText,
    learningLifecycle: normalizedString(row.learning_lifecycle || 'approved_for_generation'),
    selectionReason: 'Approved owned/generated reference matched this run.',
    rank: Number(row.rank ?? 0),
  };
  return assertFrontendSafeResponse(projected);
}
