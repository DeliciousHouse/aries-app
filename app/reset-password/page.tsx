import { Suspense } from 'react';

import AuthLayout from '../../frontend/auth/auth-layout';
import ResetPasswordPageClient from './page-client';

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <AuthLayout>
          <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-10 text-center text-white/70">
            Loading password reset…
          </div>
        </AuthLayout>
      }
    >
      <ResetPasswordPageClient />
    </Suspense>
  );
}
