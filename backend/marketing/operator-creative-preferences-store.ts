import pool from '@/lib/db';

type Queryable = Pick<typeof pool, 'query'>;

export type OperatorCreativePreferencesRow = {
  always_match_creative_voice: boolean;
  voice_style_label: string | null;
  updated_at: string;
};

function parseTenantId(tenantId: string): number | null {
  const n = Number.parseInt(String(tenantId).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseUserId(userId: string): number | null {
  const n = Number.parseInt(String(userId).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function getOperatorCreativePreferences(
  tenantId: string,
  userId: string,
  client: Queryable = pool,
): Promise<OperatorCreativePreferencesRow | null> {
  const tid = parseTenantId(tenantId);
  const uid = parseUserId(userId);
  if (tid === null || uid === null) return null;

  const r = await client.query<{
    always_match_creative_voice: boolean;
    voice_style_label: string | null;
    updated_at: Date;
  }>(
    `SELECT always_match_creative_voice, voice_style_label, updated_at
     FROM marketing_operator_creative_preferences
     WHERE tenant_id = $1 AND user_id = $2`,
    [tid, uid],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    always_match_creative_voice: row.always_match_creative_voice,
    voice_style_label: row.voice_style_label,
    updated_at: row.updated_at.toISOString(),
  };
}

export async function upsertOperatorCreativePreferences(
  input: {
    tenantId: string;
    userId: string;
    always_match_creative_voice: boolean;
    voice_style_label: string | null;
  },
  client: Queryable = pool,
): Promise<OperatorCreativePreferencesRow> {
  const tid = parseTenantId(input.tenantId);
  const uid = parseUserId(input.userId);
  if (tid === null || uid === null) {
    throw new Error('[operator-creative-preferences] invalid tenant_id or user_id');
  }

  const r = await client.query<{
    always_match_creative_voice: boolean;
    voice_style_label: string | null;
    updated_at: Date;
  }>(
    `INSERT INTO marketing_operator_creative_preferences (
        tenant_id, user_id, always_match_creative_voice, voice_style_label, updated_at
      ) VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET
        always_match_creative_voice = EXCLUDED.always_match_creative_voice,
        voice_style_label = EXCLUDED.voice_style_label,
        updated_at = now()
      RETURNING always_match_creative_voice, voice_style_label, updated_at`,
    [tid, uid, input.always_match_creative_voice, input.voice_style_label],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error('[operator-creative-preferences] upsert returned no row');
  }
  return {
    always_match_creative_voice: row.always_match_creative_voice,
    voice_style_label: row.voice_style_label,
    updated_at: row.updated_at.toISOString(),
  };
}
