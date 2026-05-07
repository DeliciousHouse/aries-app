import { handleMetaSelectPageHttp } from '../../../../../backend/integrations/meta/select-page';

export async function POST(req: Request) {
  return handleMetaSelectPageHttp(req);
}
