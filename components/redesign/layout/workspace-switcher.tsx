'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, Loader2, Settings } from 'lucide-react';

import type { TenantRole } from '@/lib/tenant-context';
import type { WorkspaceSwitcherData } from '@/backend/tenant/workspace-switcher';
import { fetchWorkspaceSwitcherData, requestWorkspaceSwitch } from '@/lib/api/workspace';

// Invite-aware chooser destination for the pending-invite Accept affordance.
// Mirrors WORKSPACE_CHOOSER_PATH in backend/tenant/workspace-chooser.ts —
// inlined (not imported) to keep this client bundle free of any backend import.
const WORKSPACE_CHOOSER_PATH = '/workspace/choose';

/**
 * App-shell workspace switcher (multi-workspace plan Phase 3). Rendered ONLY
 * when the flag is ON and the account has >1 active membership (the shell gates
 * this). Placement: rail-top under the Aries mark (desktop) + mobile header
 * (design OQ3 / Pass 1). Menu order: current (check + role) → other active
 * memberships (MRU) → pending invited rows (disabled + Accept) → divider →
 * workspace settings. "Create workspace" is deliberately absent (Phase 4 puts
 * it in the account menu).
 */

function roleLabel(role: TenantRole | null): string {
  if (role === 'tenant_admin') return 'Admin';
  if (role === 'tenant_analyst') return 'Editor';
  if (role === 'tenant_viewer') return 'Viewer';
  return 'Member';
}

// Dark-theme-safe accent chips; text colors clear WCAG 4.5:1 on #050505.
const CHIP_PALETTES = [
  'bg-violet-500/25 text-violet-50',
  'bg-sky-500/25 text-sky-50',
  'bg-emerald-500/25 text-emerald-50',
  'bg-amber-500/25 text-amber-50',
  'bg-rose-500/25 text-rose-50',
  'bg-teal-500/25 text-teal-50',
];

function chipPalette(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return CHIP_PALETTES[hash % CHIP_PALETTES.length];
}

function initialFor(name: string): string {
  const trimmed = name.trim();
  return (trimmed ? trimmed[0] : 'W').toUpperCase();
}

function ColorChip(props: { name: string; seed: string; size?: 'sm' | 'md' }) {
  const dim = props.size === 'md' ? 'h-9 w-9 text-sm' : 'h-7 w-7 text-xs';
  return (
    <span
      aria-hidden
      className={[
        'flex shrink-0 items-center justify-center rounded-lg font-semibold',
        dim,
        chipPalette(props.seed),
      ].join(' ')}
    >
      {initialFor(props.name)}
    </span>
  );
}

function RoleBadge(props: { role: TenantRole | null; tone?: 'default' | 'invited' }) {
  const invited = props.tone === 'invited';
  return (
    <span
      className={[
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-[0.02em]',
        invited
          ? 'border-amber-400/30 bg-amber-400/10 text-amber-100'
          : 'border-white/15 bg-white/10 text-white/80',
      ].join(' ')}
    >
      {invited ? 'Invited' : roleLabel(props.role)}
    </span>
  );
}

type ActionItem =
  | { id: string; kind: 'switch'; orgId: string; name: string }
  | { id: string; kind: 'manage' };

export interface WorkspaceSwitcherProps {
  variant: 'rail' | 'mobile';
  /** Rail only: whether the rail is visually expanded (controls label visibility). */
  railExpanded?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialData: WorkspaceSwitcherData;
  /** Settings destination for the workspace-management entry. */
  settingsHref: string;
}

export default function WorkspaceSwitcher({
  variant,
  railExpanded = false,
  open,
  onOpenChange,
  initialData,
  settingsHref,
}: WorkspaceSwitcherProps) {
  const [data, setData] = useState<WorkspaceSwitcherData>(initialData);
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [announcement, setAnnouncement] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  const current = useMemo(
    () => data.workspaces.find((w) => w.current) ?? data.workspaces[0] ?? null,
    [data.workspaces],
  );
  const currentName = current?.name ?? 'Workspace';

  // Ordered actionable descendants for roving focus (aria-activedescendant).
  // The current workspace row and pending-invite rows are shown but the current
  // row is not actionable; each pending row's Accept link is a real anchor and
  // stays keyboard-reachable via Tab, kept out of this roving set to keep the
  // menu model simple.
  const actionItems = useMemo<ActionItem[]>(() => {
    const items: ActionItem[] = [];
    for (const w of data.workspaces) {
      if (!w.current) {
        items.push({ id: `${baseId}-ws-${w.organizationId}`, kind: 'switch', orgId: w.organizationId, name: w.name });
      }
    }
    items.push({ id: `${baseId}-manage`, kind: 'manage' });
    return items;
  }, [data.workspaces, baseId]);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await fetchWorkspaceSwitcherData();
      setData(fresh);
    } catch {
      // Keep the last-known list; surface a soft inline error.
      setError('Could not refresh your workspaces.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch on open so a membership added/removed while the tab was idle is
  // reflected (design: stale membership list → refetch on open).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setActiveIndex(0);
    void refetch();
  }, [open, refetch]);

  // Move real focus to the menu on open; return focus to the trigger on close.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      requestAnimationFrame(() => menuRef.current?.focus());
    } else if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // Close on outside pointer down.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onOpenChange(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, onOpenChange]);

  const announce = useCallback((message: string) => setAnnouncement(message), []);

  const handleSwitch = useCallback(
    async (orgId: string, name: string) => {
      if (switchingId) return; // guard double-fire / slow switch
      setSwitchingId(orgId);
      setError(null);
      announce(`Switching to ${name}`);
      const result = await requestWorkspaceSwitch(orgId);
      if (result.status === 'ok') {
        announce(`Now in ${result.workspace.name ?? name}`);
        // Menu closes only after the confirmed navigation. Keep switchingId set
        // so the row spinner persists through the hard-navigate.
        window.location.href = result.redirectTo;
        return;
      }
      setSwitchingId(null);
      setError(result.message);
      if (result.code === 'not_a_member' || result.code === 'invitation_pending') {
        // Membership changed while the menu was open — refresh the list.
        void refetch();
      }
    },
    [switchingId, announce, refetch],
  );

  const activateItem = useCallback(
    (item: ActionItem) => {
      if (item.kind === 'switch') {
        void handleSwitch(item.orgId, item.name);
      } else {
        onOpenChange(false);
        window.location.href = settingsHref;
      }
    },
    [handleSwitch, onOpenChange, settingsHref],
  );

  const onMenuKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (actionItems.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % actionItems.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + actionItems.length) % actionItems.length);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setActiveIndex(actionItems.length - 1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const item = actionItems[activeIndex];
        if (item) activateItem(item);
      }
    },
    [actionItems, activeIndex, activateItem, onOpenChange],
  );

  const activeDescendantId = actionItems[activeIndex]?.id;

  // ── Trigger ────────────────────────────────────────────────────────────────
  const triggerLabel = `Current workspace: ${currentName}. Switch workspace`;
  const showRailLabel = variant === 'mobile' || railExpanded;

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => onOpenChange(!open)}
      onKeyDown={(event) => {
        if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpenChange(true);
        }
      }}
      title={currentName}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={triggerLabel}
      className={[
        'group/ws relative flex min-h-[44px] w-full items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.05] text-left transition-colors hover:bg-white/[0.09]',
        variant === 'rail'
          ? showRailLabel
            ? 'px-2.5 py-2'
            : 'justify-center px-0 py-2'
          : 'px-3 py-2',
      ].join(' ')}
    >
      <ColorChip name={currentName} seed={current?.organizationId ?? currentName} size={variant === 'mobile' ? 'md' : 'sm'} />
      {showRailLabel ? (
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-semibold text-white">{currentName}</span>
          <span className="truncate text-[11px] font-medium text-white/55">{roleLabel(current?.role ?? null)}</span>
        </span>
      ) : null}
      {showRailLabel ? (
        <ChevronDown
          className={['h-4 w-4 shrink-0 text-white/50 transition-transform', open ? 'rotate-180' : ''].join(' ')}
          aria-hidden
        />
      ) : null}
    </button>
  );

  // ── Menu ─────────────────────────────────────────────────────────────────
  const menuPositionClass =
    variant === 'rail'
      ? 'left-[calc(100%+10px)] top-0 w-72'
      : 'left-0 right-0 top-[calc(100%+8px)]';

  const menu = (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          aria-label="Workspaces"
          aria-activedescendant={activeDescendantId}
          onKeyDown={onMenuKeyDown}
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          className={[
            'absolute z-[130] overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 shadow-[0_28px_90px_rgba(0,0,0,0.45)] focus:outline-none',
            menuPositionClass,
          ].join(' ')}
        >
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/55">Workspaces</span>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-white/40" aria-hidden /> : null}
          </div>

          <div className="max-h-[60vh] space-y-1 overflow-y-auto p-2">
            {data.workspaces.map((workspace) => {
              const item = actionItems.find(
                (candidate) => candidate.kind === 'switch' && candidate.orgId === workspace.organizationId,
              );
              const isActive = item != null && item.id === activeDescendantId;
              const isSwitching = switchingId === workspace.organizationId;
              const commonClass = [
                'flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                isActive ? 'bg-white/[0.1]' : 'hover:bg-white/[0.06]',
              ].join(' ');

              if (workspace.current) {
                return (
                  <div
                    key={workspace.organizationId}
                    id={`${baseId}-current`}
                    role="menuitemradio"
                    aria-checked
                    aria-current="true"
                    className={['flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5', 'bg-white/[0.05]'].join(' ')}
                  >
                    <ColorChip name={workspace.name} seed={workspace.organizationId} />
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-sm font-semibold text-white" title={workspace.name}>
                        {workspace.name}
                      </span>
                    </span>
                    <RoleBadge role={workspace.role} />
                    <Check className="h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
                  </div>
                );
              }

              return (
                <button
                  key={workspace.organizationId}
                  id={item?.id}
                  role="menuitem"
                  type="button"
                  disabled={Boolean(switchingId)}
                  aria-disabled={Boolean(switchingId)}
                  onMouseEnter={() => {
                    const idx = actionItems.findIndex((candidate) => candidate.id === item?.id);
                    if (idx >= 0) setActiveIndex(idx);
                  }}
                  onClick={() => void handleSwitch(workspace.organizationId, workspace.name)}
                  className={[commonClass, switchingId && !isSwitching ? 'opacity-50' : ''].join(' ')}
                >
                  <ColorChip name={workspace.name} seed={workspace.organizationId} />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-sm font-medium text-white/90" title={workspace.name}>
                      {workspace.name}
                    </span>
                  </span>
                  <RoleBadge role={workspace.role} />
                  {isSwitching ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-white/70" aria-hidden /> : null}
                </button>
              );
            })}

            {data.pendingInvites.length > 0 ? (
              <>
                <div className="my-1 h-px bg-white/8" />
                <div className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.16em] text-white/40">
                  Pending invites
                </div>
                {data.pendingInvites.map((invite) => (
                  <div
                    key={invite.organizationId}
                    role="menuitem"
                    aria-disabled
                    className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 opacity-90"
                  >
                    <ColorChip name={invite.name} seed={invite.organizationId} />
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-sm font-medium text-white/70" title={invite.name}>
                        {invite.name}
                      </span>
                      <span className="truncate text-[11px] text-white/40">Invited as {roleLabel(invite.role)}</span>
                    </span>
                    <Link
                      href={WORKSPACE_CHOOSER_PATH}
                      role="menuitem"
                      onClick={() => onOpenChange(false)}
                      className="inline-flex shrink-0 items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-400/20"
                    >
                      Accept
                    </Link>
                  </div>
                ))}
              </>
            ) : null}

            <div className="my-1 h-px bg-white/8" />
            <Link
              id={`${baseId}-manage`}
              role="menuitem"
              href={settingsHref}
              onMouseEnter={() => setActiveIndex(actionItems.length - 1)}
              onClick={() => onOpenChange(false)}
              className={[
                'flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-white/75 transition-colors',
                actionItems[activeIndex]?.kind === 'manage' ? 'bg-white/[0.1] text-white' : 'hover:bg-white/[0.06] hover:text-white',
              ].join(' ')}
            >
              <Settings className="h-4 w-4 shrink-0 text-white/60" aria-hidden />
              Workspace settings
            </Link>

            {error ? (
              <div className="mt-1 rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return (
    <div ref={containerRef} className="relative">
      {trigger}
      {menu}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
