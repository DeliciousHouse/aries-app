import type { Metadata } from 'next';
import { Suspense } from 'react';
import SignUpPageClient from './page-client';

export const metadata: Metadata = {
  title: 'Create your account · Aries',
  description: 'Create an Aries account and set up your marketing workspace.',
};

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUpPageClient />
    </Suspense>
  );
}
