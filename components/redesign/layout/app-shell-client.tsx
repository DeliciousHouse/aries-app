'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import {
  BarChart3,
  Calendar,
  CheckCheck,
  FileStack,
  LayoutDashboard,
  LogOut,
  Rocket,
  Settings,
  User,
  X as CloseIcon,
} from 'lucide-react';

import { AriesMark } from '@/frontend/donor/ui';
import { getRouteById, getSectionRoutes, type AppRouteId } from '@/frontend/app-shell/routes';

const ICONS: Record<AppRouteId, typeof LayoutDashboard> = {
  home: LayoutDashboard,
  posts: FileStack,
  campaigns: Rocket,
  calendar: Calendar,
  results: BarChart3,
  review: CheckCheck,
  settings: Settings,
};

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
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const primaryRoutes = getSectionRoutes('primary');
  const utilityRoutes = getSectionRoutes('utility');

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target as Node)) {
        setIsMobileMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setIsDropdownOpen(false);
    setIsMobileMenuOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen bg-[#050505] text-white selection:bg-primary/30">
      <div className="fixed inset-0 bg-[radial-gradient(circle_at_20%_18%,rgba(124,58,237,0.16),transparent_28%),radial-gradient(circle_at_82%_10%,rgba(255,255,255,0.08),transparent_18%),linear-gradient(180deg,#050505_0%,#090910_100%)]" />

      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="sticky top-0 z-[60] flex h-16 items-center justify-between border-b border-white/[0.05] bg-[#050505]/80 px-4 backdrop-blur-xl md:h-20 md:px-8">
          <Link href="/dashboard" className="flex items-center gap-4 md:w-64">
            <AriesMark sizeClassName="h-10 w-10 md:h-12 md:w-12" />
            <div className="flex flex-col">
              <span className="text-base font-bold uppercase leading-none tracking-[0.15em] text-white md:text-lg">
                Aries AI
              </span>
              <span className="text-[10px] font-medium text-white/50 md:text-xs">
                Marketing operating system
              </span>
            </div>
          </Link>

          <nav className="hidden items-center gap-2 rounded-xl border border-primary/10 bg-primary/5 p-1 lg:flex">
            {primaryRoutes.map((route) => {
              const Icon = ICONS[route.id];
              const isActive = currentRouteId === route.id;
              return (
                <Link
                  key={route.id}
                  href={route.href}
                  className={`
                    relative flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium transition-all duration-200
                    ${isActive ? 'text-white' : 'text-white/70 hover:text-white'}
                  `}
                >
                  {isActive ? (
                    <motion.div
                      layoutId="activeNavPill"
                      className="absolute inset-0 rounded-lg border border-primary/30 bg-primary/20 shadow-[0_0_15px_rgba(123,97,255,0.15)]"
                      initial={false}
                      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                    />
                  ) : null}
                  <Icon className="relative z-10 h-4 w-4" />
                  <span className="relative z-10">{route.title}</span>
                </Link>
              );
            })}
          </nav>

          <div className="relative flex items-center justify-end gap-2 md:w-64 md:gap-4" ref={dropdownRef}>
            <Link
              href={getRouteById('review').href}
              className="hidden items-center gap-2 rounded-full border border-[#4a4025] bg-[#2a2515] px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#352e18] lg:inline-flex"
            >
              <CheckCheck className="h-4 w-4 text-[#e5c07b]" />
              <span>Review Queue</span>
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-white/10 px-1.5 text-xs font-bold text-white">
                {reviewCount}
              </span>
            </Link>

            <div className="hidden md:block">
              <button
                type="button"
                onClick={() => setIsDropdownOpen((open) => !open)}
                className={`flex items-center gap-3 rounded-full border py-1.5 pl-1.5 pr-5 transition-colors ${
                  isDropdownOpen
                    ? 'border-primary/30 bg-primary/10'
                    : 'border-primary/10 bg-primary/5 hover:border-primary/20 hover:bg-primary/10'
                }`}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-sm font-bold text-primary">
                  {(user.name || user.email || 'A').slice(0, 1).toUpperCase()}
                </div>
                <span className="text-sm font-medium tracking-wide text-white/90">
                  {user.name || 'User'}
                </span>
              </button>

              <AnimatePresence>
                {isDropdownOpen ? (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                    className="absolute right-0 top-full z-[70] mt-4 w-72 overflow-hidden rounded-2xl border border-primary/20 bg-[#0a0a0f] shadow-[0_10px_40px_-10px_rgba(123,97,255,0.15)]"
                  >
                    <div className="border-b border-primary/10 bg-primary/5 px-6 py-5">
                      <div className="mb-1 text-lg font-semibold text-white">{user.name || 'User'}</div>
                      <div className="text-sm text-white/60">{user.email}</div>
                    </div>
                    <div className="flex flex-col py-2">
                      <Link
                        href={getRouteById('settings').href}
                        onClick={() => setIsDropdownOpen(false)}
                        className="flex items-center gap-3 px-6 py-3 text-base text-white transition-colors hover:bg-primary/10"
                      >
                        <Settings className="h-4 w-4 text-white/50" />
                        Settings
                      </Link>
                      <Link
                        href={getRouteById('review').href}
                        onClick={() => setIsDropdownOpen(false)}
                        className="flex items-center gap-3 px-6 py-3 text-base text-white transition-colors hover:bg-primary/10"
                      >
                        <User className="h-4 w-4 text-white/50" />
                        Review queue
                      </Link>
                      <div className="mx-4 my-1 h-px bg-primary/10" />
                      <form action={logoutAction}>
                        <button
                          type="submit"
                          className="flex w-full items-center gap-3 px-6 py-3 text-left text-base text-red-400 transition-colors hover:bg-red-400/10"
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

            <button
              type="button"
              onClick={() => setIsMobileMenuOpen((open) => !open)}
              className="rounded-xl border border-white/10 bg-white/5 p-2 text-white transition-colors hover:bg-white/10 lg:hidden"
            >
              {isMobileMenuOpen ? <CloseIcon className="h-6 w-6" /> : <LayoutDashboard className="h-6 w-6" />}
            </button>
          </div>
        </header>

        <AnimatePresence>
          {isMobileMenuOpen ? (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsMobileMenuOpen(false)}
                className="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm lg:hidden"
              />
              <motion.div
                ref={mobileMenuRef}
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="fixed right-0 top-16 bottom-0 z-[56] flex w-full max-w-[300px] flex-col border-l border-white/10 bg-[#0a0a0f] lg:hidden"
              >
                <div className="flex-1 overflow-y-auto p-6">
                  <div className="space-y-2">
                    {primaryRoutes.map((route) => {
                      const Icon = ICONS[route.id];
                      const isActive = currentRouteId === route.id;
                      return (
                        <Link
                          key={route.id}
                          href={route.href}
                          className={`
                            flex items-center gap-4 rounded-xl p-4 text-lg font-medium transition-all
                            ${isActive ? 'border border-primary/20 bg-primary/10 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'}
                          `}
                        >
                          <Icon className="h-5 w-5" />
                          {route.title}
                        </Link>
                      );
                    })}
                  </div>

                  <div className="mt-8 space-y-2 border-t border-white/5 pt-8">
                    {utilityRoutes.map((route) => {
                      const Icon = ICONS[route.id];
                      const isActive = currentRouteId === route.id;
                      return (
                        <Link
                          key={route.id}
                          href={route.href}
                          className={`
                            flex items-center justify-between rounded-xl p-4 text-lg font-medium transition-all
                            ${isActive ? 'border border-primary/20 bg-primary/10 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'}
                          `}
                        >
                          <span className="flex items-center gap-4">
                            <Icon className="h-5 w-5" />
                            {route.title}
                          </span>
                          {route.id === 'review' ? (
                            <span className="rounded-full bg-white/10 px-2 py-0.5 text-sm text-white">
                              {reviewCount}
                            </span>
                          ) : null}
                        </Link>
                      );
                    })}
                    <form action={logoutAction}>
                      <button
                        type="submit"
                        className="flex w-full items-center gap-4 rounded-xl p-4 text-lg font-medium text-red-400 transition-all hover:bg-red-400/10"
                      >
                        <LogOut className="h-5 w-5" />
                        Logout
                      </button>
                    </form>
                  </div>
                </div>

                <div className="border-t border-white/5 bg-white/[0.02] p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20 font-bold text-primary">
                      {(user.name || user.email || 'A').slice(0, 1).toUpperCase()}
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold text-white">{user.name || 'User'}</span>
                      <span className="text-xs text-white/40">{user.email}</span>
                    </div>
                  </div>
                </div>
              </motion.div>
            </>
          ) : null}
        </AnimatePresence>

        <main className="relative flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col overflow-auto p-4 md:p-8">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${pathname}:${currentRouteId ?? 'workspace'}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
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
