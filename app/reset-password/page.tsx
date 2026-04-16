import type { Metadata } from 'next';

import ResetPasswordPageClient from './page-client';

export const metadata: Metadata = {
  title: 'Reset password · Aries',
  description: 'Set a new password for your Aries account.',
};

export default function ResetPasswordPage() {
  return <ResetPasswordPageClient />;
}
