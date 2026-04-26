import type { SelectedStyleCard } from '@/types/creative-memory';
import type { QueryClient } from './profileContext';
import { requireNumericTenantId, type TenantContext } from './tenant';

export async function listStyleCards(ctx: TenantContext, db: QueryClient): Promise<SelectedStyleCard[]> {
  const tenantId = requireNumericTenantId(ctx);
  const r = await db.query<Record<string, unknown>>(`SELECT * FROM style_cards WHERE tenant_id=$1 AND status = 'active' ORDER BY updated_at DESC LIMIT 50`, [tenantId]);
  return r.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    visualDna: String(row.visual_dna ?? ''),
    copyDna: String(row.copy_dna ?? ''),
    promptGuidance: String(row.prompt_guidance ?? ''),
    negativeGuidance: String(row.negative_guidance ?? ''),
    confidenceScore: Number(row.confidence_score ?? 0),
    selectionReason: 'Available active campaign learning pattern.',
  }));
}
