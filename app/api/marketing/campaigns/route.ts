import { permanentRedirect } from 'next/navigation';

export async function GET() {
  permanentRedirect('/api/social-content/posts');
}
