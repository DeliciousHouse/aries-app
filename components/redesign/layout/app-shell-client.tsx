'use client';

import React, { useState, useRef, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Settings, 
  LogOut, 
  LayoutDashboard, 
  Calendar, 
  Rocket, 
  BarChart3,
  User,
  X as CloseIcon
} from 'lucide-react';
import { AriesMark } from '@/frontend/donor/ui';

const navItems = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/dashboard/calendar', label: 'Calendar', icon: Calendar },
  { path: '/dashboard/campaigns', label: 'Campaigns', icon: Rocket },
  { path: '/dashboard/results', label: 'Results', icon: BarChart3 },
];

interface AppShellClientProps {
  children: React.ReactNode;
  user: {
    name?: string | null;
    email?: string | null;
  };
  logoutAction: () => Promise<void>;
}

export default function AppShellClient({ children, user, logoutAction }: AppShellClientProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target as Node)) {
        setIsMobileMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  const handleSignOut = async () => {
    await logoutAction();
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#050505] text-white font-sans selection:bg-primary/30">
      
      {/* Top Navbar */}
      <header className="h-16 md:h-20 flex items-center justify-between px-4 md:px-8 sticky top-0 z-[60] bg-[#050505]/80 backdrop-blur-xl border-b border-white/[0.05]">
        {/* Logo */}
        <Link href="/dashboard" className="flex items-center gap-4 w-auto md:w-64">
          <AriesMark sizeClassName="h-10 w-10 md:h-12 md:w-12" />
          <div className="flex flex-col">
            <span className="font-bold text-base md:text-lg tracking-[0.15em] uppercase text-white leading-none">Aries AI</span>
            <span className="text-[10px] md:text-xs text-white/50 font-medium">Marketing operating system</span>
          </div>
        </Link>

        {/* Center Navigation (Pills) - Desktop Only */}
        <nav className="hidden lg:flex items-center gap-2 p-1 bg-primary/5 border border-primary/10 rounded-xl">
          {navItems.map((item) => {
            const isActive = pathname === item.path;
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`
                  relative px-5 py-2 rounded-lg text-sm font-medium transition-all duration-200 flex items-center gap-2
                  ${isActive ? 'text-white' : 'text-white/70 hover:text-white'}
                `}
              >
                {isActive && (
                  <motion.div
                    layoutId="activeNavPill"
                    className="absolute inset-0 bg-primary/20 rounded-lg border border-primary/30 shadow-[0_0_15px_rgba(123,97,255,0.15)]"
                    initial={false}
                    transition={{ type: "spring", stiffness: 400, damping: 35 }}
                  />
                )}
                <Icon className="w-4 h-4 relative z-10" />
                <span className="relative z-10">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Right Actions */}
        <div className="flex items-center justify-end gap-2 md:gap-4 w-auto md:w-64 relative">
          {/* User Profile - Desktop Only */}
          <div className="hidden md:block relative" ref={dropdownRef}>
            <button 
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className={`flex items-center gap-3 pl-1.5 pr-5 py-1.5 rounded-full border transition-colors ${isDropdownOpen ? 'bg-primary/10 border-primary/30' : 'bg-primary/5 border-primary/10 hover:bg-primary/10 hover:border-primary/20'}`}
            >
              <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">
                {(user.name || user.email || 'A').slice(0, 1).toUpperCase()}
              </div>
              <span className="text-sm font-medium text-white/90 tracking-wide">{user.name || 'User'}</span>
            </button>

            {/* Dropdown Menu */}
            <AnimatePresence>
              {isDropdownOpen && (
                <motion.div 
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  className="absolute top-full mt-4 right-0 w-72 rounded-2xl bg-[#0a0a0f] border border-primary/20 shadow-[0_10px_40px_-10px_rgba(123,97,255,0.15)] z-[70] overflow-hidden"
                >
                  <div className="px-6 py-5 border-b border-primary/10 bg-primary/5">
                    <div className="text-lg font-semibold text-white mb-1">{user.name || 'User'}</div>
                    <div className="text-sm text-white/60">{user.email}</div>
                  </div>
                  <div className="flex flex-col py-2">
                    <Link 
                      href="/dashboard/settings"
                      onClick={() => setIsDropdownOpen(false)}
                      className="w-full text-left px-6 py-3 text-base text-white hover:bg-primary/10 transition-colors flex items-center gap-3"
                    >
                      <Settings className="w-4 h-4 text-white/50" />
                      Settings
                    </Link>
                    <button className="w-full text-left px-6 py-3 text-base text-white hover:bg-primary/10 transition-colors flex items-center gap-3">
                      <User className="w-4 h-4 text-white/50" />
                      Review queue
                    </button>
                    <div className="h-px bg-primary/10 my-1 mx-4" />
                    <button 
                      onClick={handleSignOut}
                      className="w-full text-left px-6 py-3 text-base text-red-400 hover:bg-red-400/10 transition-colors flex items-center gap-3"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign Out
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Mobile Menu Toggle */}
          <button 
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="lg:hidden p-2 rounded-xl bg-white/5 border border-white/10 text-white hover:bg-white/10 transition-colors"
          >
            {isMobileMenuOpen ? <CloseIcon className="w-6 h-6" /> : <LayoutDashboard className="w-6 h-6" />}
          </button>
        </div>
      </header>

      {/* Mobile Navigation Menu */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileMenuOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[55] lg:hidden"
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed top-16 right-0 bottom-0 w-full max-w-[300px] bg-[#0a0a0f] border-l border-white/10 z-[56] lg:hidden flex flex-col"
              ref={mobileMenuRef}
            >
              <div className="p-6 flex-1 overflow-y-auto">
                <div className="space-y-2">
                  {navItems.map((item) => {
                    const isActive = pathname === item.path;
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.path}
                        href={item.path}
                        className={`
                          flex items-center gap-4 p-4 rounded-xl text-lg font-medium transition-all
                          ${isActive ? 'bg-primary/10 border border-primary/20 text-white' : 'text-white/60 hover:text-white hover:bg-white/5'}
                        `}
                      >
                        <Icon className="w-5 h-5" />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>

                <div className="mt-8 pt-8 border-t border-white/5 space-y-2">
                  <Link
                    href="/dashboard/settings"
                    className={`
                      flex items-center gap-4 p-4 rounded-xl text-lg font-medium transition-all
                      ${pathname === '/dashboard/settings' ? 'bg-primary/10 border border-primary/20 text-white' : 'text-white/60 hover:text-white hover:bg-white/5'}
                    `}
                  >
                    <Settings className="w-5 h-5" />
                    Settings
                  </Link>
                  <button 
                    onClick={handleSignOut}
                    className="w-full flex items-center gap-4 p-4 rounded-xl text-lg font-medium text-red-400 hover:bg-red-400/10 transition-all"
                  >
                    <LogOut className="w-5 h-5" />
                    Sign Out
                  </button>
                </div>
              </div>
              
              <div className="p-6 border-t border-white/5 bg-white/[0.02]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
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
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Page Content */}
        <div className="flex-1 overflow-auto p-4 md:p-8 flex flex-col">
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="w-full flex-1 flex flex-col"
          >
            {children}
          </motion.div>
        </div>
      </main>
    </div>
  );
}
