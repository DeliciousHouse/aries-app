import { handleOauthConnectHttp } from '../../../../../backend/integrations/connect';

export async function POST(req: Request, { params }: { params: { provider: string } }) {
  return handleOauthConnectHttp(req, params.provider);
}
