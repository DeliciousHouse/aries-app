#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ host: process.env.DB_HOST, port: Number.parseInt(process.env.DB_PORT || '5432', 10), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const tenantId = Number.parseInt(process.env.CREATIVE_MEMORY_TENANT_ID || process.argv[2] || '1', 10);
if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error('Set CREATIVE_MEMORY_TENANT_ID or pass a numeric tenant id.');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [tenantId, 'Creative Memory Demo', `creative-memory-demo-${tenantId}`]);
  const checksum = `creative-memory-demo-${tenantId}-operator-note`;
  await client.query("INSERT INTO creative_assets (tenant_id, source_type, permission_scope, media_type, source_job_id, source_asset_id, served_asset_ref, storage_kind, exact_image_text, aspect_ratio, checksum, usable_for_generation, learning_lifecycle) VALUES ($1,'generated_by_aries','generated','image','demo-job','demo-asset','/api/marketing/jobs/demo-job/assets/demo-asset','runtime_asset',$2,'4:5',$3,true,'approved_for_generation') ON CONFLICT (tenant_id, checksum) WHERE checksum IS NOT NULL DO UPDATE SET served_asset_ref = EXCLUDED.served_asset_ref, usable_for_generation = true, learning_lifecycle = 'approved_for_generation'", [tenantId, ['Your AI tools aren’t the problem.','Your workflows are.'], checksum]);
  await client.query("INSERT INTO style_cards (tenant_id, name, visual_dna, copy_dna, prompt_guidance, negative_guidance, status, confidence_score) VALUES ($1,'Native educational operator note','Cream card on dark operator UI, navy/cream contrast, sparse accent color.','Contrarian first line, practical second line, helpful CTA.','Create a native educational ad that feels like a saved operator note, not a banner.','No robots, no fake dashboards, no purple gradients, no competitor logos.','active',0.7) ON CONFLICT (tenant_id, name) DO UPDATE SET visual_dna=EXCLUDED.visual_dna, copy_dna=EXCLUDED.copy_dna, prompt_guidance=EXCLUDED.prompt_guidance, negative_guidance=EXCLUDED.negative_guidance, status='active', confidence_score=EXCLUDED.confidence_score", [tenantId]);
  await client.query("INSERT INTO market_pattern_notes (tenant_id, source_label, pattern, allowed_use) VALUES ($1,'Meta Ad Library abstraction','Winning competitors use contrarian operator pain hooks, but Aries must not imitate layouts or brand marks.','abstract_only') ON CONFLICT (tenant_id, source_label, pattern) DO UPDATE SET allowed_use='abstract_only'", [tenantId]);
  await client.query('COMMIT');
  console.log(JSON.stringify({ status: 'ok', tenantId }, null, 2));
} catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); await pool.end(); }
