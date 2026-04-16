import type { Metadata } from 'next';

import ForgotPasswordPageClient from './page-client';

export const metadata: Metadata = {
  title: 'Forgot password · Aries',
  description: 'Request a recovery code to reset your Aries password.',
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordPageClient />;
}
