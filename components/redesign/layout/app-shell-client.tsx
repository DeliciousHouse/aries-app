'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { createPortal } from 'react-dom';
import {
  BarChart3,
  Calendar,
  CheckCheck,
  ChevronDown,
  ClipboardCheck,
  FileStack,
  Layers3,
  LayoutDashboard,
  Menu,
  LogOut,
  PenSquare,
  Send,
  Rocket,
  Settings,
  Sparkles,
} from 'lucide-react';

import { AriesMark } from '@/frontend/donor/ui';
import { getRouteById, type AppRouteId } from '@/frontend/app-shell/routes';

const ICONS: Record<AppRouteId, typeof LayoutDashboard> = {
  home: LayoutDashboard,
  newCampaign: PenSquare,
  brandReview: Layers3,
  strategyReview: ClipboardCheck,
  creativeReview: Sparkles,
  publishStatus: Send,
  campaigns: Rocket,
  posts: FileStack,
  calendar: Calendar,
  results: BarChart3,
  review: CheckCheck,
  businessProfile: Settings,
  channelIntegrations: Rocket,
  settings: Settings,
};

type SidebarItem =
  | { type: 'link'; routeId: AppRouteId; badge?: number }
  | { type: 'reviewDropdown' };

interface AppShellClientProps {
  children: React.ReactNode;
  currentRouteId?: AppRouteId;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
  reviewCount: number;
  user: {
    name?: string | null;
    email?: string | null;
  };
  logoutAction: (formData: FormData) => void | Promise<void>;
}

export default function AppShellClient({
  children,
  currentRouteId,
  reviewCount,
  user,
  logoutAction,
}: AppShellClientProps) {
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isReviewMenuOpen, setIsReviewMenuOpen] = useState(false);
  const [isMobileReviewMenuOpen, setIsMobileReviewMenuOpen] = useState(false);
  const [isMobileAccountMenuOpen, setIsMobileAccountMenuOpen] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const reviewCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const primaryItems: SidebarItem[] = useMemo(
    () => [
      { type: 'link', routeId: 'home' },
      { type: 'link', routeId: 'newCampaign' },
      { type: 'reviewDropdown' },
      { type: 'link', routeId: 'publishStatus' },
    ],
    [],
  );

  const utilityItems: SidebarItem[] = useMemo(
    () => [
      { type: 'link', routeId: 'campaigns' },
      { type: 'link', routeId: 'posts' },
      { type: 'link', routeId: 'calendar' },
      { type: 'link', routeId: 'results' },
    ],
    [],
  );

  const reviewChildren = useMemo(
    () =>
      (['brandReview', 'strategyReview', 'creativeReview'] as const).map((routeId) => ({
        routeId,
        route: getRouteById(routeId),
        Icon: ICONS[routeId],
      })),
    [],
  );

  const isReviewSectionActive = Boolean(
    currentRouteId && ['brandReview', 'strategyReview', 'creativeReview'].includes(currentRouteId),
  );
  const keepSidebarExpanded = isReviewMenuOpen || isAccountMenuOpen;

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target as Node)) {
        setIsMobileMenuOpen(false);
        setIsMobileReviewMenuOpen(false);
        setIsMobileAccountMenuOpen(false);
      }
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setIsAccountMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (reviewCloseTimeoutRef.current) {
        clearTimeout(reviewCloseTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setIsMobileMenuOpen(false);
    setIsReviewMenuOpen(false);
    setIsMobileReviewMenuOpen(false);
    setIsMobileAccountMenuOpen(false);
    setIsAccountMenuOpen(false);
    if (reviewCloseTimeoutRef.current) {
      clearTimeout(reviewCloseTimeoutRef.current);
      reviewCloseTimeoutRef.current = null;
    }
  }, [pathname]);

  const accountLabel = user.email || user.name || '';
  const avatarLetter = (user.email || user.name || 'U').slice(0, 1).toUpperCase();

  function openDesktopReviewMenu() {
    if (reviewCloseTimeoutRef.current) {
      clearTimeout(reviewCloseTimeoutRef.current);
      reviewCloseTimeoutRef.current = null;
    }
    setIsReviewMenuOpen(true);
  }

  function closeDesktopReviewMenu() {
    if (reviewCloseTimeoutRef.current) {
      clearTimeout(reviewCloseTimeoutRef.current);
    }
    reviewCloseTimeoutRef.current = setTimeout(() => {
      setIsReviewMenuOpen(false);
      reviewCloseTimeoutRef.current = null;
    }, 140);
  }

  function NavLink(props: {
    routeId: AppRouteId;
    variant: 'desktop' | 'mobile';
    badge?: number;
  }) {
    const route = getRouteById(props.routeId);
    const Icon = ICONS[props.routeId];
    const isActive = currentRouteId === props.routeId;

    const base =
      'group/nav-item relative flex items-center rounded-2xl text-sm font-medium tracking-wide transition-colors';
    const active = 'text-white';
    const inactive = 'text-white/60 hover:text-white';

    const desktop = keepSidebarExpanded
      ? 'h-11 justify-start px-3.5'
      : 'h-11 justify-center px-0 group-hover/sidebar:justify-start group-hover/sidebar:px-3.5';
    const mobile = 'min-h-[44px] justify-start px-4 py-3 text-base';
    const desktopLabelVisibility = keepSidebarExpanded
      ? 'w-auto translate-x-0 opacity-100'
      : 'pointer-events-none w-0 translate-x-2 overflow-hidden opacity-0 group-hover/sidebar:w-auto group-hover/sidebar:translate-x-0 group-hover/sidebar:opacity-100';
    const desktopBadgeVisibility = keepSidebarExpanded
      ? 'w-auto opacity-100'
      : 'pointer-events-none w-0 overflow-hidden opacity-0 group-hover/sidebar:w-auto group-hover/sidebar:opacity-100';

    return (
      <Link
        href={route.href}
        className={[
          base,
          isActive ? active : inactive,
          props.variant === 'desktop' ? desktop : `${mobile} w-full text-left`,
          isActive ? 'bg-white/[0.07]' : 'hover:bg-white/[0.06]',
        ].join(' ')}
        aria-current={isActive ? 'page' : undefined}
        onClick={props.variant === 'mobile' ? () => setIsMobileMenuOpen(false) : undefined}
      >
        {isActive ? (
          <motion.div
            layoutId={props.variant === 'desktop' ? 'activeSidebarPill' : undefined}
            className="absolute inset-0 rounded-2xl border border-white/12 bg-white/[0.06]"
            initial={false}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
          />
        ) : null}

        <span
          className={[
            'relative z-10 flex w-full min-w-0 items-center gap-3',
            props.variant === 'mobile'
              ? 'justify-start'
              : keepSidebarExpanded
                ? 'justify-start'
                : 'justify-center group-hover/sidebar:justify-start',
          ].join(' ')}
        >
          <Icon className="h-5 w-5 shrink-0 text-white/85" />
          <span
            className={[
              'relative z-10 whitespace-nowrap text-white/90',
              props.variant === 'desktop'
                ? `transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${desktopLabelVisibility}`
                : 'opacity-100',
            ].join(' ')}
          >
            {route.title}
          </span>
        </span>

        {typeof props.badge === 'number' ? (
          <span
            className={[
              'relative z-10 ml-auto inline-flex items-center justify-center rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold text-white/90',
              props.variant === 'desktop'
                ? `transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${desktopBadgeVisibility}`
                : '',
            ].join(' ')}
          >
            {props.badge}
          </span>
        ) : null}
      </Link>
    );
  }

  function ReviewDropdown(props: { variant: 'desktop' | 'mobile' }) {
    const isOpen = props.variant === 'desktop' ? isReviewMenuOpen : isMobileReviewMenuOpen;
    const setIsOpen = props.variant === 'desktop' ? setIsReviewMenuOpen : setIsMobileReviewMenuOpen;
    const triggerRef = useRef<HTMLDivElement>(null);
    const desktopMenuRef = useRef<HTMLDivElement>(null);
    const outsideHoverCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [desktopMenuPosition, setDesktopMenuPosition] = useState<{ top: number; left: number } | null>(null);

    const buttonBase =
      'group/nav-item relative flex w-full items-center rounded-2xl text-sm font-medium tracking-wide transition-colors';
    const desktop = keepSidebarExpanded
      ? 'h-11 justify-start px-3.5'
      : 'h-11 justify-center px-0 group-hover/sidebar:justify-start group-hover/sidebar:px-3.5';
    const mobile = 'min-h-[44px] justify-start px-4 py-3 text-base';
    const desktopLabelVisibility = keepSidebarExpanded
      ? 'w-auto translate-x-0 opacity-100'
      : 'pointer-events-none w-0 translate-x-2 overflow-hidden opacity-0 group-hover/sidebar:w-auto group-hover/sidebar:translate-x-0 group-hover/sidebar:opacity-100';
    const desktopChevronVisibility = keepSidebarExpanded
      ? 'w-auto opacity-100'
      : 'pointer-events-none w-0 overflow-hidden opacity-0 group-hover/sidebar:w-auto group-hover/sidebar:opacity-100';

    useEffect(() => {
      if (props.variant !== 'desktop' || !isOpen) {
        return;
      }

      let rafId: number | null = null;

      const updatePosition = () => {
        const trigger = triggerRef.current;
        const rect = trigger?.getBoundingClientRect();
        if (!rect) return;
        const sidebarRect = trigger?.closest('aside')?.getBoundingClientRect();
        const leftEdge = sidebarRect ? Math.max(rect.right, sidebarRect.right) : rect.right;
        setDesktopMenuPosition({
          top: rect.top,
          left: leftEdge + 4,
        });
      };

      updatePosition();

      // Track position while the sidebar animates from collapsed -> expanded.
      const animatePosition = (startTime: number) => {
        updatePosition();
        if (performance.now() - startTime < 520) {
          rafId = window.requestAnimationFrame(() => animatePosition(startTime));
        }
      };
      rafId = window.requestAnimationFrame(() => animatePosition(performance.now()));

      window.addEventListener('resize', updatePosition);
      window.addEventListener('scroll', updatePosition, true);
      return () => {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
        }
        window.removeEventListener('resize', updatePosition);
        window.removeEventListener('scroll', updatePosition, true);
      };
    }, [isOpen, props.variant]);

    useEffect(() => {
      if (props.variant !== 'desktop' || !isOpen) {
        return;
      }

      const handlePointerMove = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        const inTrigger = !!triggerRef.current?.contains(target);
        const inMenu = !!desktopMenuRef.current?.contains(target);
        if (inTrigger || inMenu) {
          if (outsideHoverCloseTimeoutRef.current) {
            clearTimeout(outsideHoverCloseTimeoutRef.current);
            outsideHoverCloseTimeoutRef.current = null;
          }
          return;
        }

        if (!outsideHoverCloseTimeoutRef.current) {
          outsideHoverCloseTimeoutRef.current = setTimeout(() => {
            setIsReviewMenuOpen(false);
            outsideHoverCloseTimeoutRef.current = null;
          }, 180);
        }
      };

      window.addEventListener('pointermove', handlePointerMove, { passive: true });
      return () => {
        if (outsideHoverCloseTimeoutRef.current) {
          clearTimeout(outsideHoverCloseTimeoutRef.current);
          outsideHoverCloseTimeoutRef.current = null;
        }
        window.removeEventListener('pointermove', handlePointerMove);
      };
    }, [isOpen, props.variant]);

    return (
      <div
        ref={triggerRef}
        className={props.variant === 'desktop' ? 'group/review relative' : 'relative'}
        onMouseEnter={props.variant === 'desktop' ? openDesktopReviewMenu : undefined}
        onMouseLeave={props.variant === 'desktop' ? closeDesktopReviewMenu : undefined}
      >
        <button
          type="button"
          onClick={() => {
            if (props.variant === 'desktop') {
              if (isOpen) {
                closeDesktopReviewMenu();
              } else {
                openDesktopReviewMenu();
              }
              return;
            }
            setIsMobileAccountMenuOpen(false);
            setIsOpen((open) => !open);
          }}
          className={[
            buttonBase,
            props.variant === 'desktop' ? desktop : `${mobile} w-full text-left`,
            isReviewSectionActive ? 'text-white bg-white/[0.07]' : 'text-white/60 hover:text-white hover:bg-white/[0.06]',
          ].join(' ')}
          aria-expanded={isOpen}
          aria-controls={props.variant === 'desktop' ? 'sidebar-review-menu' : 'mobile-sidebar-review-menu'}
        >
          {isReviewSectionActive ? (
            <div className="absolute inset-0 rounded-2xl border border-white/12 bg-white/[0.06]" />
          ) : null}

          <span
            className={[
              'relative z-10 flex w-full min-w-0 items-center gap-3',
              props.variant === 'mobile'
                ? 'justify-start'
                : keepSidebarExpanded
                  ? 'justify-start'
                  : 'justify-center group-hover/sidebar:justify-start',
            ].join(' ')}
          >
            <Layers3 className="h-5 w-5 shrink-0 text-white/85" />
            <span
              className={[
                'min-w-0 whitespace-nowrap text-white/90',
                props.variant === 'desktop'
                  ? `transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${desktopLabelVisibility}`
                  : '',
              ].join(' ')}
            >
              Review
            </span>
          </span>

          <span
            className={[
              'relative z-10 ml-auto shrink-0',
              props.variant === 'desktop'
                ? `transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${desktopChevronVisibility}`
                : '',
            ].join(' ')}
          >
            <ChevronDown
              className={[
                'h-4 w-4 text-white/55 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                isOpen ? 'rotate-180' : 'rotate-0',
              ].join(' ')}
            />
          </span>
        </button>

        {props.variant === 'desktop' ? (
          typeof window !== 'undefined'
            ? createPortal(
                <AnimatePresence>
                  {isOpen && desktopMenuPosition ? (
                    <motion.div
                      ref={desktopMenuRef}
                      id="sidebar-review-menu"
                      initial={{ opacity: 0, y: 8, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.98 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                      onMouseEnter={openDesktopReviewMenu}
                      onMouseLeave={closeDesktopReviewMenu}
                      className="fixed z-[120] w-64 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06] shadow-[0_28px_90px_rgba(0,0,0,0.38)] backdrop-blur-xl"
                      style={{ top: desktopMenuPosition.top, left: desktopMenuPosition.left }}
                    >
                      <div className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.24em] text-white/40">
                        Review
                      </div>
                      <div className="space-y-1 p-2">
                        {reviewChildren.map(({ routeId, route, Icon }) => {
                          const isActive = currentRouteId === routeId;
                          return (
                            <Link
                              key={routeId}
                              href={route.href}
                              className={[
                                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                                isActive ? 'bg-white/[0.08] text-white' : 'text-white/70 hover:bg-white/[0.06] hover:text-white',
                              ].join(' ')}
                              aria-current={isActive ? 'page' : undefined}
                            >
                              <Icon className="h-4 w-4 text-white/70" />
                              {route.title}
                            </Link>
                          );
                        })}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>,
                document.body,
              )
            : null
        ) : (
          <AnimatePresence initial={false}>
            {isOpen ? (
              <motion.div
                id="mobile-sidebar-review-menu"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <div className="mt-2 space-y-1 border-l border-white/10 pl-3 ml-1">
                  {reviewChildren.map(({ routeId, route, Icon }) => {
                    const isActive = currentRouteId === routeId;
                    return (
                      <Link
                        key={routeId}
                        href={route.href}
                        className={[
                          'flex min-h-[44px] items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors',
                          isActive ? 'bg-white/[0.08] text-white' : 'text-white/70 hover:bg-white/[0.06] hover:text-white',
                        ].join(' ')}
                        aria-current={isActive ? 'page' : undefined}
                        onClick={() => setIsMobileMenuOpen(false)}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-white/70" />
                        {route.title}
                      </Link>
                    );
                  })}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-white selection:bg-primary/30">
      <div className="fixed inset-0 bg-[radial-gradient(circle_at_20%_18%,rgba(124,58,237,0.16),transparent_28%),radial-gradient(circle_at_82%_10%,rgba(255,255,255,0.08),transparent_18%),linear-gradient(180deg,#050505_0%,#090910_100%)]" />

      {/* flex-col: mobile header must stack above main; default flex-row squeezed main beside the header */}
      <div className="relative z-10 flex min-h-screen flex-col">
        {/* Desktop sidebar */}
        <aside
          className={[
            'group/sidebar fixed left-4 top-4 bottom-4 z-[70] hidden flex-col overflow-visible rounded-[2rem] border border-white/10 bg-white/[0.06] shadow-[0_28px_90px_rgba(0,0,0,0.38)] backdrop-blur-xl lg:flex',
            keepSidebarExpanded ? 'w-[280px]' : 'w-[72px] hover:w-[280px]',
            'transition-[width] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
          ].join(' ')}
        >
          <Link href="/dashboard" className="flex items-center justify-start gap-3 px-3 pt-5 pb-4">
            <AriesMark sizeClassName="h-10 w-10" />
            <div
              className={[
                'transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                keepSidebarExpanded
                  ? 'w-auto opacity-100'
                  : 'w-0 overflow-hidden opacity-0 group-hover/sidebar:w-auto group-hover/sidebar:opacity-100',
              ].join(' ')}
            >
              <div className="text-sm font-bold uppercase tracking-[0.15em] text-white">Aries AI</div>
              <div className="text-[10px] font-medium text-white/45">Marketing OS</div>
            </div>
          </Link>

          <div className="px-2 pb-2">
            <div className="h-px bg-white/8" />
          </div>

          <nav className="flex flex-1 flex-col gap-1 px-2 py-2">
            {primaryItems.map((item) =>
              item.type === 'link' ? (
                <NavLink key={item.routeId} routeId={item.routeId} badge={item.badge} variant="desktop" />
              ) : (
                <ReviewDropdown key="review-dropdown" variant="desktop" />
              ),
            )}

            <div className="my-2 px-2">
              <div className="h-px bg-white/8" />
            </div>

            {utilityItems.map((item) =>
              item.type === 'link' ? (
                <NavLink key={item.routeId} routeId={item.routeId} badge={item.badge} variant="desktop" />
              ) : null,
            )}
          </nav>

          <div className="relative px-2 pb-3" ref={accountMenuRef}>
            <button
              type="button"
              onClick={() => setIsAccountMenuOpen((open) => !open)}
              className={[
                'group/nav-item relative flex h-11 w-full items-center rounded-2xl text-left text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.06] hover:text-white',
                keepSidebarExpanded
                  ? 'justify-start px-3.5'
                  : 'justify-center px-0 group-hover/sidebar:justify-start group-hover/sidebar:px-3.5',
              ].join(' ')}
              aria-expanded={isAccountMenuOpen}
              aria-controls="sidebar-account-menu"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-sm font-semibold text-white">
                {avatarLetter}
              </span>
              <span
                className={[
                  'ml-3 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                  keepSidebarExpanded
                    ? 'w-auto translate-x-0 opacity-100'
                    : 'pointer-events-none w-0 translate-x-2 overflow-hidden opacity-0 group-hover/sidebar:w-auto group-hover/sidebar:translate-x-0 group-hover/sidebar:opacity-100',
                ].join(' ')}
              >
                <span className="block max-w-[170px] truncate text-sm font-medium text-white/90">{accountLabel}</span>
              </span>
            </button>

            <AnimatePresence>
              {isAccountMenuOpen ? (
                <motion.div
                  id="sidebar-account-menu"
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.98 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                  className="absolute bottom-14 left-0 z-[90] w-[280px] overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06] shadow-[0_28px_90px_rgba(0,0,0,0.38)] backdrop-blur-xl"
                >
                  <div className="space-y-1 p-2">
                    <Link
                      href={getRouteById('businessProfile').href}
                      className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
                      onClick={() => setIsAccountMenuOpen(false)}
                    >
                      <Settings className="h-4 w-4 text-white/60" />
                      Business profile
                    </Link>
                    <Link
                      href={getRouteById('channelIntegrations').href}
                      className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
                      onClick={() => setIsAccountMenuOpen(false)}
                    >
                      <Rocket className="h-4 w-4 text-white/60" />
                      Channel integrations
                    </Link>
                    <Link
                      href={getRouteById('review').href}
                      className="flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
                      onClick={() => setIsAccountMenuOpen(false)}
                    >
                      <span className="flex items-center gap-3">
                        <CheckCheck className="h-4 w-4 text-white/60" />
                        Review queue
                      </span>
                      <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold text-white/90">
                        {reviewCount}
                      </span>
                    </Link>
                    <div className="my-1 h-px bg-white/8" />
                    <form action={logoutAction}>
                      <button
                        type="submit"
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-rose-200/90 transition-colors hover:bg-rose-500/10 hover:text-rose-100"
                      >
                        <LogOut className="h-4 w-4" />
                        Logout
                      </button>
                    </form>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </aside>

        {/* Mobile top bar */}
        <header className="sticky top-0 z-[65] flex h-16 w-full shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#050505]/70 px-4 backdrop-blur-xl lg:hidden">
          <Link href="/dashboard" className="flex items-center gap-3">
            <AriesMark sizeClassName="h-9 w-9" />
            <div className="flex flex-col leading-none">
              <span className="text-sm font-bold uppercase tracking-[0.15em] text-white">Aries AI</span>
              <span className="mt-1 text-[10px] font-medium text-white/45">Marketing OS</span>
            </div>
          </Link>
          <button
            type="button"
            onClick={() => {
              setIsMobileMenuOpen((wasOpen) => {
                const next = !wasOpen;
                if (next) {
                  setIsMobileReviewMenuOpen(false);
                  setIsMobileAccountMenuOpen(false);
                }
                return next;
              });
            }}
            className="rounded-2xl border border-white/10 bg-white/5 p-2.5 text-white transition-colors hover:bg-white/10"
            aria-expanded={isMobileMenuOpen}
            aria-controls="mobile-sidebar"
          >
            <Menu className="h-5 w-5" />
          </button>
        </header>

        {/* Mobile sidebar drawer */}
        <AnimatePresence>
          {isMobileMenuOpen ? (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsMobileMenuOpen(false)}
                className="fixed inset-0 z-[68] bg-black/60 backdrop-blur-sm lg:hidden"
              />
              <motion.aside
                id="mobile-sidebar"
                ref={mobileMenuRef}
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ type: 'spring', damping: 28, stiffness: 240 }}
                className="fixed left-0 top-0 bottom-0 z-[69] flex w-[86vw] max-w-[320px] flex-col items-stretch border-r border-white/10 bg-[#07070b]/85 shadow-[0_28px_90px_rgba(0,0,0,0.45)] backdrop-blur-xl lg:hidden"
              >
                <div className="flex items-center justify-between px-4 pt-4 pb-3">
                  <Link href="/dashboard" className="flex min-w-0 items-center gap-3 text-left" onClick={() => setIsMobileMenuOpen(false)}>
                    <AriesMark sizeClassName="h-10 w-10 shrink-0" />
                    <div className="flex min-w-0 flex-col leading-none">
                      <span className="text-sm font-bold uppercase tracking-[0.15em] text-white">Aries AI</span>
                      <span className="mt-1 text-[10px] font-medium text-white/45">Marketing OS</span>
                    </div>
                  </Link>
                  <button
                    type="button"
                    onClick={() => setIsMobileMenuOpen(false)}
                    className="shrink-0 rounded-2xl border border-white/10 bg-white/5 p-2.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                    aria-label="Close menu"
                  >
                    <span className="text-lg leading-none">x</span>
                  </button>
                </div>

                <div className="px-4 pb-3">
                  <div className="h-px bg-white/8" />
                </div>

                <nav className="flex w-full min-w-0 flex-1 flex-col items-stretch gap-1 overflow-y-auto overflow-x-hidden px-4 pb-4 text-left">
                  {primaryItems.map((item) =>
                    item.type === 'link' ? (
                      <NavLink
                        key={item.routeId}
                        routeId={item.routeId}
                        badge={item.badge}
                        variant="mobile"
                      />
                    ) : (
                      <ReviewDropdown key="mobile-review-dropdown" variant="mobile" />
                    ),
                  )}

                  <div className="my-3">
                    <div className="h-px bg-white/8" />
                  </div>

                  {utilityItems.map((item) =>
                    item.type === 'link' ? (
                      <NavLink
                        key={item.routeId}
                        routeId={item.routeId}
                        badge={item.badge}
                        variant="mobile"
                      />
                    ) : null,
                  )}
                </nav>

                <div className="border-t border-white/8 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileReviewMenuOpen(false);
                      setIsMobileAccountMenuOpen((open) => !open);
                    }}
                    className="flex min-h-[44px] w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.05] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.08]"
                    aria-expanded={isMobileAccountMenuOpen}
                    aria-controls="mobile-drawer-account-menu"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-sm font-semibold text-white">
                      {avatarLetter}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-white/45">Account</span>
                      <span className="mt-0.5 block truncate text-sm font-medium text-white/90">{accountLabel || 'Account'}</span>
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-white/50 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                        isMobileAccountMenuOpen ? 'rotate-180' : 'rotate-0'
                      }`}
                      aria-hidden
                    />
                  </button>

                  <AnimatePresence initial={false}>
                    {isMobileAccountMenuOpen ? (
                      <motion.div
                        id="mobile-drawer-account-menu"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="mt-2 space-y-1 rounded-2xl border border-white/10 bg-white/[0.06] p-2 shadow-[0_12px_40px_rgba(0,0,0,0.25)] backdrop-blur-xl">
                          <Link
                            href={getRouteById('businessProfile').href}
                            className="flex min-h-[44px] items-center justify-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.06] hover:text-white"
                            onClick={() => {
                              setIsMobileMenuOpen(false);
                              setIsMobileAccountMenuOpen(false);
                            }}
                          >
                            <Settings className="h-4 w-4 shrink-0 text-white/60" />
                            Business profile
                          </Link>
                          <Link
                            href={getRouteById('channelIntegrations').href}
                            className="flex min-h-[44px] items-center justify-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.06] hover:text-white"
                            onClick={() => {
                              setIsMobileMenuOpen(false);
                              setIsMobileAccountMenuOpen(false);
                            }}
                          >
                            <Rocket className="h-4 w-4 shrink-0 text-white/60" />
                            Channel integrations
                          </Link>
                          <Link
                            href={getRouteById('review').href}
                            className="flex min-h-[44px] items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.06] hover:text-white"
                            onClick={() => {
                              setIsMobileMenuOpen(false);
                              setIsMobileAccountMenuOpen(false);
                            }}
                          >
                            <span className="flex items-center gap-3">
                              <CheckCheck className="h-4 w-4 shrink-0 text-white/60" />
                              Review queue
                            </span>
                            <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold text-white/90">
                              {reviewCount}
                            </span>
                          </Link>
                          <div className="my-1 h-px bg-white/8" />
                          <form action={logoutAction}>
                            <button
                              type="submit"
                              className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-rose-200/90 transition-colors hover:bg-rose-500/10 hover:text-rose-100"
                              onClick={() => {
                                setIsMobileMenuOpen(false);
                                setIsMobileAccountMenuOpen(false);
                              }}
                            >
                              <LogOut className="h-4 w-4 shrink-0" />
                              Logout
                            </button>
                          </form>
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              </motion.aside>
            </>
          ) : null}
        </AnimatePresence>

        <main className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden lg:min-h-screen lg:pl-[104px]">
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pb-4 pt-5 md:px-8 md:pb-8 md:pt-5 lg:pl-6">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${pathname}:${currentRouteId ?? 'workspace'}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                className="flex w-full flex-1 flex-col"
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}
