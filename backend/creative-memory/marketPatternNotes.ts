import type { MarketPatternNote } from '@/types/creative-memory';
import type { QueryClient } from './profileContext';
import { requireNumericTenantId, type TenantContext } from './tenant';
export async function listMarketPatternNotes(ctx: TenantContext, db: QueryClient): Promise<MarketPatternNote[]> { const tenantId=requireNumericTenantId(ctx); const r=await db.query<Record<string, unknown>>('SELECT * FROM market_pattern_notes WHERE tenant_id=$1 AND allowed_use=$2 ORDER BY created_at DESC LIMIT 50',[tenantId,'abstract_only']); return r.rows.map(row=>({id:String(row.id),sourceLabel:String(row.source_label ?? 'Market pattern'),pattern:String(row.pattern ?? ''),allowedUse:'abstract_only',selectionReason:'Abstract competitor-safe market pattern.'})); }
