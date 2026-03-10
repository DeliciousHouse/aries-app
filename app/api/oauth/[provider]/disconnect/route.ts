import { handleOauthDisconnectHttp } from '../../../../../backend/integrations/disconnect';

export async function POST(req: Request, { params }: { params: { provider: string } }) {
  return handleOauthDisconnectHttp(req, params.provider);
}
