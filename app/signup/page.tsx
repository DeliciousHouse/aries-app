import { Suspense } from 'react';
import SignUpPageClient from './page-client';

export const metadata = {
  title: 'Create your account — Aries AI',
};

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUpPageClient />
    </Suspense>
  );
}
