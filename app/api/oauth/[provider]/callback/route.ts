import { handleOauthCallbackHttp } from '../../../../../backend/integrations/callback';

export async function GET(req: Request, { params }: { params: { provider: string } }) {
  return handleOauthCallbackHttp(req, params.provider);
}
