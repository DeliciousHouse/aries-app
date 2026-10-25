import { handleMetaAds } from '@/backend/integrations/meta/ads';

export const GET = (req: Request) => handleMetaAds(req);
export const POST = (req: Request) => handleMetaAds(req);
