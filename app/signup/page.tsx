import { Suspense } from 'react';
import SignUpPageClient from './page-client';

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUpPageClient />
    </Suspense>
  );
}
