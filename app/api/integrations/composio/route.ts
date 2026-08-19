import { handleComposioList } from './handlers';
import pool from '@/lib/db';

export async function GET() {
  return handleComposioList(undefined, undefined, pool);
}
