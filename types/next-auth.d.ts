import type { DefaultSession } from 'next-auth';
import type { TenantRole } from '@/lib/tenant-context';

declare module 'next-auth' {
  interface Session {
    user: DefaultSession['user'] & {
      id: string;
      tenantId?: string;
      tenantSlug?: string;
      role?: TenantRole;
      timezone?: string;
      /**
       * Count of the user's ACTIVE workspace memberships. Present only when
       * multi-workspace membership resolution is enabled
       * (ARIES_MULTI_WORKSPACE_ENABLED); rides the same claims query — the
       * shell uses it to decide whether a switcher renders without an extra
       * fetch (multi-workspace plan, Phase 1).
       */
      workspaceCount?: number;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId?: string;
    tenantId?: string;
    tenantSlug?: string;
    tenantRole?: TenantRole;
    timezone?: string;
    /** See Session.user.workspaceCount — stamped by the jwt hydrate (flag ON). */
    workspaceCount?: number;
  }
}
