export async function POST(req: Request) {
  const body = await req.json();
  return new Response(JSON.stringify({ status: 'ok', platform: body.platform, dispatched_to: 'n8n/publish-dispatch.workflow.json' }), {
    status: 202,
    headers: { 'content-type': 'application/json' }
  });
}
