import type { DefaultSession } from 'next-auth';
import type { TenantRole } from '@/lib/tenant-context';

declare module 'next-auth' {
  interface Session {
    user: DefaultSession['user'] & {
      id: string;
      tenantId?: string;
      tenantSlug?: string;
      role?: TenantRole;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId?: string;
    tenantId?: string;
    tenantSlug?: string;
    tenantRole?: TenantRole;
  }
}
