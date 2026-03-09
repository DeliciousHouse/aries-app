"use client";

import { useMemo, useState, type FormEvent } from 'react';

type TenantAdminSurfaceState = 'idle' | 'loading' | 'ready' | 'saving' | 'error';
type TenantRole = 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';
type MemberStatus = 'active' | 'invited' | 'suspended';
type TenantAdminErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'service_unavailable'
  | 'unknown';

type TenantMember = {
  user_id: string;
  email: string;
  role: TenantRole;
  status: MemberStatus;
};

type MembersLoadResponse = {
  status: 'ok';
  tenant_id: string;
  members: TenantMember[];
};

type InviteMemberRequest = {
  email: string;
  role: TenantRole;
};

type InviteMemberSuccess = {
  status: 'ok';
  invitation_id: string;
};

type UpdateMemberRoleRequest = {
  user_id: string;
  role: TenantRole;
};

type UpdateMemberRoleSuccess = {
  status: 'ok';
  user_id: string;
  role: TenantRole;
};

type TenantAdminError = {
  status: 'error';
  error: {
    code: TenantAdminErrorCode;
    message: string;
    field_errors?: Array<{
      field: string;
      reason: string;
    }>;
  };
};

const tenantRoles: TenantRole[] = ['tenant_admin', 'tenant_analyst', 'tenant_viewer'];

function isTenantAdminError(value: unknown): value is TenantAdminError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value as { status?: unknown }).status === 'error'
  );
}

export interface TenantUsersScreenProps {
  baseUrl?: string;
}

export default function TenantUsersScreen({ baseUrl = '' }: TenantUsersScreenProps): JSX.Element {
  const [tenantId, setTenantId] = useState('');
  const [surfaceState, setSurfaceState] = useState<TenantAdminSurfaceState>('idle');
  const [membersResult, setMembersResult] = useState<MembersLoadResponse | null>(null);
  const [lastError, setLastError] = useState<TenantAdminError | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TenantRole>('tenant_viewer');

  const [updateUserId, setUpdateUserId] = useState('');
  const [updateRole, setUpdateRole] = useState<TenantRole>('tenant_viewer');

  const [lastMutationResult, setLastMutationResult] = useState<
    InviteMemberSuccess | UpdateMemberRoleSuccess | null
  >(null);

  const canLoad = useMemo(() => tenantId.trim().length > 0, [tenantId]);

  async function handleLoadMembers(): Promise<void> {
    if (!canLoad) {
      return;
    }

    setSurfaceState('loading');
    setLastError(null);
    setLastMutationResult(null);

    try {
      const response = await fetch(
        `${baseUrl}/api/tenant-admin/members?tenant_id=${encodeURIComponent(tenantId.trim())}`,
        { method: 'GET' }
      );
      const body = (await response.json()) as MembersLoadResponse | TenantAdminError;

      if (!response.ok || isTenantAdminError(body)) {
        setMembersResult(null);
        setLastError(
          isTenantAdminError(body)
            ? body
            : {
                status: 'error',
                error: { code: 'unknown', message: 'Failed to load tenant members' }
              }
        );
        setSurfaceState('error');
        return;
      }

      setMembersResult(body);
      setSurfaceState('ready');
    } catch {
      setMembersResult(null);
      setLastError({
        status: 'error',
        error: { code: 'service_unavailable', message: 'Unable to reach tenant admin members endpoint' }
      });
      setSurfaceState('error');
    }
  }

  async function handleInviteMember(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSurfaceState('saving');
    setLastError(null);
    setLastMutationResult(null);

    const payload: InviteMemberRequest = {
      email: inviteEmail.trim(),
      role: inviteRole
    };

    try {
      const response = await fetch(`${baseUrl}/api/tenant-admin/members/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = (await response.json()) as InviteMemberSuccess | TenantAdminError;

      if (!response.ok || isTenantAdminError(body)) {
        setLastError(
          isTenantAdminError(body)
            ? body
            : {
                status: 'error',
                error: { code: 'unknown', message: 'Failed to invite tenant member' }
              }
        );
        setSurfaceState('error');
        return;
      }

      setLastMutationResult(body);
      setSurfaceState('ready');
    } catch {
      setLastError({
        status: 'error',
        error: { code: 'service_unavailable', message: 'Unable to reach invite member endpoint' }
      });
      setSurfaceState('error');
    }
  }

  async function handleUpdateRole(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSurfaceState('saving');
    setLastError(null);
    setLastMutationResult(null);

    const payload: UpdateMemberRoleRequest = {
      user_id: updateUserId.trim(),
      role: updateRole
    };

    try {
      const response = await fetch(`${baseUrl}/api/tenant-admin/members/role`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = (await response.json()) as UpdateMemberRoleSuccess | TenantAdminError;

      if (!response.ok || isTenantAdminError(body)) {
        setLastError(
          isTenantAdminError(body)
            ? body
            : {
                status: 'error',
                error: { code: 'unknown', message: 'Failed to update member role' }
              }
        );
        setSurfaceState('error');
        return;
      }

      setLastMutationResult(body);
      setSurfaceState('ready');
    } catch {
      setLastError({
        status: 'error',
        error: { code: 'service_unavailable', message: 'Unable to reach update role endpoint' }
      });
      setSurfaceState('error');
    }
  }

  return (
    <section>
      <h1>Tenant Admin Members</h1>
      <p>Route: /tenant-admin/members</p>

      <div>
        <label htmlFor="tenant_id">tenant_id</label>
        <input
          id="tenant_id"
          name="tenant_id"
          value={tenantId}
          onChange={(event) => setTenantId(event.target.value)}
        />
        <button type="button" onClick={handleLoadMembers} disabled={!canLoad || surfaceState === 'loading'}>
          {surfaceState === 'loading' ? 'Loading…' : 'Load members'}
        </button>
      </div>

      <h2>Invite member</h2>
      <form onSubmit={handleInviteMember}>
        <label htmlFor="invite_email">email</label>
        <input
          id="invite_email"
          name="invite_email"
          type="email"
          value={inviteEmail}
          onChange={(event) => setInviteEmail(event.target.value)}
          required
        />

        <label htmlFor="invite_role">role</label>
        <select
          id="invite_role"
          name="invite_role"
          value={inviteRole}
          onChange={(event) => setInviteRole(event.target.value as TenantRole)}
        >
          {tenantRoles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>

        <button type="submit" disabled={surfaceState === 'saving'}>
          {surfaceState === 'saving' ? 'Saving…' : 'Invite member'}
        </button>
      </form>

      <h2>Update member role</h2>
      <form onSubmit={handleUpdateRole}>
        <label htmlFor="update_user_id">user_id</label>
        <input
          id="update_user_id"
          name="update_user_id"
          value={updateUserId}
          onChange={(event) => setUpdateUserId(event.target.value)}
          required
        />

        <label htmlFor="update_role">role</label>
        <select
          id="update_role"
          name="update_role"
          value={updateRole}
          onChange={(event) => setUpdateRole(event.target.value as TenantRole)}
        >
          {tenantRoles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>

        <button type="submit" disabled={surfaceState === 'saving'}>
          {surfaceState === 'saving' ? 'Saving…' : 'Update role'}
        </button>
      </form>

      <h2>Surface state</h2>
      <p>{surfaceState}</p>

      {membersResult ? (
        <div>
          <h2>Members ({membersResult.members.length})</h2>
          <ul>
            {membersResult.members.map((member) => (
              <li key={member.user_id}>
                {member.user_id} · {member.email} · {member.role} · {member.status}
              </li>
            ))}
          </ul>
          <h3>Load response</h3>
          <pre>{JSON.stringify(membersResult, null, 2)}</pre>
        </div>
      ) : null}

      {lastMutationResult ? (
        <div>
          <h2>Mutation response</h2>
          <pre>{JSON.stringify(lastMutationResult, null, 2)}</pre>
        </div>
      ) : null}

      {lastError ? (
        <div>
          <h2>Error</h2>
          <pre>{JSON.stringify(lastError, null, 2)}</pre>
        </div>
      ) : null}
    </section>
  );
}
