'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';

import {
  activateWorkspaceGuard,
  getBootedWorkspaceId,
  registerWorkspaceMismatchHandler,
  type WorkspaceMismatchPayload,
} from '@/lib/api/workspace-guard';
import { fetchWorkspaceSwitcherData, requestWorkspaceSwitch } from '@/lib/api/workspace';

/**
 * Client half of the stale-workspace interlock (plan Decision 2a, design Pass 3).
 * Mounted by the app shell ONLY when the flag is ON and the account has >1
 * active membership. Three jobs:
 *
 *  1. Arm the mutation guard at app load, pinning the workspace id this tab
 *     booted under (set-once). lib/api/http.ts then attaches that id to every
 *     state-changing request; the server 409s a write pinned to a stale
 *     workspace.
 *  2. Route EVERY `409 workspace_mismatch` response into this single shell-level
 *     blocking overlay (role="alertdialog", no dismiss) — never a toast, never
 *     an in-content banner. It NEVER auto-navigates, so a half-typed caption
 *     survives behind it and is recoverable via "Switch back".
 *  3. Detect the stale-READ case (polled screens repaint with new-workspace data
 *     under old-workspace chrome): on window focus, compare this tab's booted id
 *     against the session's current active workspace and raise the same interlock
 *     on divergence.
 */

interface InterlockState {
  activeWorkspaceId: string | null;
  requestedWorkspaceId: string | null;
  message?: string;
}

export interface WorkspaceGuardProps {
  /** The workspace id this tab booted under (the account's active workspace at load). */
  bootedWorkspaceId: string;
  /** Gate: flag ON && workspaceCount > 1. When false the whole guard is inert. */
  enabled: boolean;
}

export default function WorkspaceGuard({ bootedWorkspaceId, enabled }: WorkspaceGuardProps) {
  // Arm the guard during first render (before any child effect can fire a
  // mutation) so the header is attached from the very first write. Set-once.
  const [armed] = useState(() => {
    if (enabled) {
      activateWorkspaceGuard(bootedWorkspaceId);
    }
    return enabled;
  });

  const [interlock, setInterlock] = useState<InterlockState | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [switchingBack, setSwitchingBack] = useState(false);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const focusCheckInFlight = useRef(false);

  const raiseInterlock = useCallback((state: InterlockState) => {
    setInterlock((prev) => prev ?? state); // first trigger wins; don't thrash
    // Best-effort: resolve friendly workspace names for the dialog copy.
    void fetchWorkspaceSwitcherData()
      .then((data) => {
        const map: Record<string, string> = {};
        for (const w of data.workspaces) map[w.organizationId] = w.name;
        for (const p of data.pendingInvites) map[p.organizationId] = p.name;
        setNames(map);
      })
      .catch(() => undefined);
  }, []);

  // Job 2: route 409 workspace_mismatch responses into the interlock.
  useEffect(() => {
    if (!armed) return;
    return registerWorkspaceMismatchHandler((payload: WorkspaceMismatchPayload) => {
      raiseInterlock({
        activeWorkspaceId: payload.activeWorkspaceId,
        requestedWorkspaceId: payload.requestedWorkspaceId ?? getBootedWorkspaceId(),
        message: payload.message,
      });
    });
  }, [armed, raiseInterlock]);

  // Job 3: stale-read detector — on focus, compare booted id vs the session's
  // current active workspace. GET read, no guard header.
  useEffect(() => {
    if (!armed) return;

    async function checkOnFocus() {
      if (focusCheckInFlight.current) return;
      focusCheckInFlight.current = true;
      try {
        const response = await fetch('/api/auth/session', {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) return;
        const session = (await response.json()) as { user?: { tenantId?: string | number } };
        const sessionWorkspaceId = session?.user?.tenantId != null ? String(session.user.tenantId) : null;
        const booted = getBootedWorkspaceId();
        if (sessionWorkspaceId && booted && sessionWorkspaceId !== booted) {
          raiseInterlock({ activeWorkspaceId: sessionWorkspaceId, requestedWorkspaceId: booted });
        }
      } catch {
        // Network blip — leave the tab as-is; a real mutation will still 409.
      } finally {
        focusCheckInFlight.current = false;
      }
    }

    function onFocus() {
      void checkOnFocus();
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') void checkOnFocus();
    }

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [armed, raiseInterlock]);

  // Focus-trap the alertdialog while it is open (no dismiss — the only exits are
  // the two actions, both of which hard-navigate).
  useEffect(() => {
    if (!interlock) return;
    requestAnimationFrame(() => primaryButtonRef.current?.focus());
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [interlock]);

  const activeId = interlock?.activeWorkspaceId ?? null;
  const requestedId = interlock?.requestedWorkspaceId ?? null;
  const activeName = (activeId && names[activeId]) || 'your active workspace';
  const requestedName = (requestedId && names[requestedId]) || 'this tab’s workspace';

  const handleReload = useCallback(() => {
    // Reload re-boots the tab under the now-active workspace (Y) and lands on
    // its dashboard.
    window.location.href = '/dashboard';
  }, []);

  const handleSwitchBack = useCallback(async () => {
    if (!requestedId || switchingBack) return;
    setSwitchingBack(true);
    const result = await requestWorkspaceSwitch(requestedId);
    if (result.status === 'ok') {
      window.location.href = result.redirectTo;
      return;
    }
    // Switch-back failed (e.g. removed from X). Fall through to reload into Y.
    setSwitchingBack(false);
    window.location.href = '/dashboard';
  }, [requestedId, switchingBack]);

  if (!armed || !interlock || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      // No onClick-to-dismiss: the interlock is non-dismissible by design.
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="workspace-interlock-title"
        aria-describedby="workspace-interlock-body"
        className="w-full max-w-md overflow-hidden rounded-3xl border border-white/12 bg-neutral-950 p-6 shadow-[0_40px_120px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-amber-400/25 bg-amber-400/10 text-amber-200">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="workspace-interlock-title" className="text-base font-semibold text-white">
              Workspace changed
            </h2>
            <p id="workspace-interlock-body" className="mt-2 text-sm leading-6 text-white/70">
              This tab was working in <span className="font-medium text-white/90">{requestedName}</span>, but your account
              is now active in <span className="font-medium text-white/90">{activeName}</span>. Your last action was not
              performed. Reload to continue in <span className="font-medium text-white/90">{activeName}</span>, or switch
              back to <span className="font-medium text-white/90">{requestedName}</span> to finish what you were doing.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            ref={primaryButtonRef}
            type="button"
            onClick={handleReload}
            className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#11161c] transition hover:translate-y-[-1px]"
          >
            Reload into {activeName}
          </button>
          <button
            type="button"
            onClick={() => void handleSwitchBack()}
            disabled={switchingBack || !requestedId}
            className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-full border border-white/15 bg-white/5 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-60"
          >
            {switchingBack ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Switch back to {requestedName}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
