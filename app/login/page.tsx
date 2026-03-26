import { Suspense } from 'react';

import AuthLayout from '../../frontend/auth/auth-layout';
import LoginPageClient from './page-client';

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <AuthLayout>
          <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-center text-white/70">
            Loading sign-in…
          </div>
        </AuthLayout>
      }
    >
      <LoginPageClient />
    </Suspense>
  );
}
