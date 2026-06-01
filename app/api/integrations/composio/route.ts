import { handleComposioList } from './handlers';

export async function GET() {
  return handleComposioList();
}
