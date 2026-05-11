import { Suspense } from 'react';
import { cookies } from 'next/headers';

import { partnerAttributionEnabled } from '@/lib/partner-attribution-env';
import {
  isValidPartnerRefFormat,
  PARTNER_REF_COOKIE_NAME,
  serializePartnerRefCookie,
} from '@/lib/partner-ref-cookie';
import SignUpPageClient from './page-client';

export const metadata = {
  title: 'Create your account — Aries AI',
};

export const dynamic = 'force-dynamic';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const sp = await searchParams;
  const ref = typeof sp.ref === 'string' ? sp.ref.trim() : '';
  if (ref && partnerAttributionEnabled() && isValidPartnerRefFormat(ref)) {
    try {
      const cookieStore = await cookies();
      cookieStore.set(PARTNER_REF_COOKIE_NAME, serializePartnerRefCookie(ref), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 90 * 24 * 60 * 60,
        path: '/',
      });
    } catch (err) {
      console.error('partner_ref_cookie_set_failed', err);
    }
  }

  return (
    <Suspense>
      <SignUpPageClient />
    </Suspense>
  );
}
