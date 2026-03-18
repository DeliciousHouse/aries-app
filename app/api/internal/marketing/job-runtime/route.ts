import { NextResponse } from "next/server";
import {
  createMarketingJobRuntime,
  type CreateMarketingJobRuntimePayload
} from "../../../../../backend/marketing/jobs-start";

/**
 * Internal endpoint for creating marketing job runtime artifacts from a
 * trusted workflow runner. Secured by INTERNAL_API_SECRET.
 */
export async function POST(req: Request) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret?.trim()) {
    return NextResponse.json(
      { error: "INTERNAL_API_SECRET not configured" },
      { status: 503 }
    );
  }
  const headerSecret = req.headers.get("x-internal-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (headerSecret !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const payload = body as CreateMarketingJobRuntimePayload;
  try {
    const result = createMarketingJobRuntime(payload);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("missing_required_fields:")) {
      return NextResponse.json(
        { status: "error", reason: "invalid_input", code: message, required: message.replace("missing_required_fields:", "").split(",") },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { status: "hard_failure", reason: "create_failed", code: "internal_error", message },
      { status: 500 }
    );
  }
}
