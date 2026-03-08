import * as fs from 'node:fs';
import * as path from 'node:path';

type StatusState = 'validated' | 'needs_repair' | 'in_progress' | 'duplicate' | 'not_found';

type StatusResult = {
  status: 'ok' | 'error';
  tenant_id?: string;
  signup_event_id?: string;
  state?: StatusState;
  validation_status?: 'pass' | 'fail' | 'unknown';
  paths?: {
    draft?: string;
    validated?: string;
    validation_report?: string;
    idempotency_marker?: string;
  };
  reason?: string;
};

function projectRoot(): string {
  return process.env.PROJECT_ROOT || path.resolve(__dirname, '../..');
}

function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

function readJsonSafe(p: string): unknown {
  if (!fileExists(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function inferState(args: {
  hasDraft: boolean;
  hasValidated: boolean;
  validationPass: boolean;
  validationFail: boolean;
  duplicateMarker: boolean;
}): StatusState {
  if (args.hasValidated || args.validationPass) return 'validated';
  if (args.validationFail) return 'needs_repair';
  if (args.duplicateMarker) return 'duplicate';
  if (args.hasDraft) return 'in_progress';
  return 'not_found';
}

export function getOnboardingStatus(input: { tenant_id?: string; signup_event_id?: string }): StatusResult {
  const tenantId = input.tenant_id;
  if (!tenantId) {
    return { status: 'error', reason: 'missing_required_query:tenant_id' };
  }

  const root = projectRoot();
  const draftPath = path.join(root, 'generated/draft', tenantId);
  const validatedPath = path.join(root, 'generated/validated', tenantId);
  const reportPath = path.join(root, 'generated/draft', `${tenantId}-validation-result.json`);

  const markerPath = input.signup_event_id
    ? path.join(root, 'generated/draft/idempotency', `${input.signup_event_id}.json`)
    : undefined;

  const report = readJsonSafe(reportPath) as { status?: string } | null;
  const marker = markerPath ? readJsonSafe(markerPath) as { duplicate?: boolean } | null : null;

  const hasDraft = fileExists(draftPath);
  const hasValidated = fileExists(validatedPath);
  const validationPass = report?.status === 'pass';
  const validationFail = report?.status === 'fail';
  const duplicateMarker = Boolean(marker?.duplicate);

  const state = inferState({ hasDraft, hasValidated, validationPass, validationFail, duplicateMarker });

  return {
    status: 'ok',
    tenant_id: tenantId,
    signup_event_id: input.signup_event_id,
    state,
    validation_status: validationPass ? 'pass' : (validationFail ? 'fail' : 'unknown'),
    paths: {
      draft: hasDraft ? draftPath : undefined,
      validated: hasValidated ? validatedPath : undefined,
      validation_report: fileExists(reportPath) ? reportPath : undefined,
      idempotency_marker: markerPath && fileExists(markerPath) ? markerPath : undefined
    }
  };
}

export async function handleStatusHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const result = getOnboardingStatus({
    tenant_id: url.searchParams.get('tenant_id') || undefined,
    signup_event_id: url.searchParams.get('signup_event_id') || undefined
  });

  const code = result.status === 'ok' ? 200 : 400;
  return new Response(JSON.stringify(result), {
    status: code,
    headers: { 'content-type': 'application/json' }
  });
}
