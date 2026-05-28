import { redirect } from 'next/navigation';

export async function GET() {
  redirect('/api/social-content/posts');
}
