import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const ddl = readFileSync(path.join(PROJECT_ROOT, 'scripts/init-db.js'), 'utf8');

test('Creative Memory DDL creates required tables without redefining business_profiles', () => {
  for (const table of ['creative_assets','creative_analyses','style_cards','style_card_examples','style_card_source_analyses','market_pattern_notes','prompt_recipes','prompt_recipe_assets','prompt_recipe_style_cards','generated_assets','campaign_learning_labels']) assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.equal((ddl.match(/CREATE TABLE IF NOT EXISTS business_profiles/g) ?? []).length, 1);
});
test('Creative Memory DDL uses pgcrypto and tenant-safe constraints', () => { assert.match(ddl,/CREATE EXTENSION IF NOT EXISTS pgcrypto/); assert.match(ddl,/tenant_id INTEGER NOT NULL REFERENCES organizations\(id\)/); assert.match(ddl,/UNIQUE \(tenant_id, id\)/); });
test('Creative Memory DDL includes provenance joins and indexes', () => { assert.match(ddl,/FOREIGN KEY \(tenant_id, style_card_id\) REFERENCES style_cards\(tenant_id, id\)/); assert.match(ddl,/FOREIGN KEY \(tenant_id, creative_analysis_id\) REFERENCES creative_analyses\(tenant_id, id\)/); assert.match(ddl,/idx_campaign_learning_labels_tenant_label_created/); const labelsSection = ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS campaign_learning_labels')); assert.doesNotMatch(labelsSection,/ON DELETE SET NULL/); assert.match(labelsSection,/CHECK \(prompt_recipe_id IS NOT NULL OR generated_asset_id IS NOT NULL\)/); });
test('Creative Memory DDL gates exact image text to generation-ready image assets', () => { assert.match(ddl,/creative_assets_exact_image_text_generation_check/); assert.match(ddl,/media_type <> 'image' OR usable_for_generation = FALSE OR learning_lifecycle <> 'approved_for_generation'/); });
test('Creative Memory DDL label enum matches API labels', () => { assert.doesNotMatch(ddl,/regenerated/); assert.doesNotMatch(ddl,/edited_by_user/); });
test('init-db failures fail hard', () => { assert.match(ddl,/process\.exitCode = 1/); assert.match(ddl,/throw err/); });
