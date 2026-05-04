import { NextResponse } from 'next/server';

import {
  handleHermesRunCallback,
  parseHermesRunCallbackPayload,
} from '@/backend/execution/hermes-callbacks';
import { verifyInternalCallbackRequest } from '@/lib/internal-callback-auth';

function errorStatus(reason: string): 400 | 404 | 409 {
  if (reason === 'execution_run_not_found') return 404;
  if (reason === 'execution_run_locked') return 409;
  return 400;
}

export async function POST(req: Request) {
  const auth = verifyInternalCallbackRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ status: 'error', reason: auth.reason }, { status: auth.status });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: 'error', reason: 'invalid_json' }, { status: 400 });
  }

  const payload = parseHermesRunCallbackPayload(body);
  if (!payload) {
    return NextResponse.json({ status: 'error', reason: 'invalid_hermes_callback_payload' }, { status: 400 });
  }

  const result = await handleHermesRunCallback(payload);
  if (result.status === 'error') {
    return NextResponse.json(result, { status: errorStatus(result.reason) });
  }

  return NextResponse.json({
    status: result.status,
    ariesRunId: result.ariesRunId,
    duplicate: result.duplicate,
  });
}
