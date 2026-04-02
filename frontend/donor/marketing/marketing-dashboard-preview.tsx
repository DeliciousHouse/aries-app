'use client';

import { startTransition, useEffect, useMemo, useState } from 'react';

import {
  CheckCheck,
  Globe2,
  Layers3,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '../lib/utils';

type DashboardSurface = {
  label: string;
  value: string;
  supporting: string;
  icon: LucideIcon;
  tone: string;
  glowClass: string;
};

const DASHBOARD_SURFACES: DashboardSurface[] = [
  {
    label: 'Campaigns',
    value: '12',
    supporting: 'Spring launch in review',
    icon: Layers3,
    tone: 'text-[#c6b1ff]',
    glowClass: 'shadow-[0_0_24px_rgba(123,97,255,0.32)]',
  },
  {
    label: 'Approvals',
    value: '3',
    supporting: 'Waiting on review',
    icon: CheckCheck,
    tone: 'text-[#f0d59d]',
    glowClass: 'shadow-[0_0_24px_rgba(229,192,123,0.26)]',
  },
  {
    label: 'Channels',
    value: '5',
    supporting: 'Publishing surfaces healthy',
    icon: Globe2,
    tone: 'text-[#7dd3fc]',
    glowClass: 'shadow-[0_0_24px_rgba(56,189,248,0.24)]',
  },
  {
    label: 'Profile',
    value: 'Ready',
    supporting: 'Business context grounded',
    icon: ShieldCheck,
    tone: 'text-[#86efac]',
    glowClass: 'shadow-[0_0_24px_rgba(52,211,153,0.24)]',
  },
  {
    label: 'Results',
    value: '1 step',
    supporting: 'Clear next action',
    icon: Sparkles,
    tone: 'text-[#f9a8d4]',
    glowClass: 'shadow-[0_0_24px_rgba(244,114,182,0.24)]',
  },
];

function orbitTranslation(index: number, activeIndex: number, radius = 112) {
  const angle = (-90 + ((index - activeIndex) * 360) / DASHBOARD_SURFACES.length) * (Math.PI / 180);
  const x = Math.round(Math.cos(angle) * radius);
  const y = Math.round(Math.sin(angle) * radius);
  return `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

export default function MarketingDashboardPreview() {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mediaQuery.matches || window.innerWidth < 1024) {
      return;
    }

    const intervalId = window.setInterval(() => {
      startTransition(() => {
        setActiveIndex((current) => (current + 1) % DASHBOARD_SURFACES.length);
      });
    }, 3800);

    return () => window.clearInterval(intervalId);
  }, []);

  const activeSurface = DASHBOARD_SURFACES[activeIndex];
  const positions = useMemo(
    () => DASHBOARD_SURFACES.map((_, index) => orbitTranslation(index, activeIndex)),
    [activeIndex],
  );

  return (
    <div className="marketing-dashboard-preview relative min-h-[18rem] overflow-hidden rounded-[1.75rem] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(123,97,255,0.18),transparent_38%),linear-gradient(180deg,rgba(18,18,26,0.96)_0%,rgba(5,5,5,0.98)_100%)] p-6">
      <div className="marketing-dashboard-preview__rings absolute inset-0" aria-hidden="true" />

      <div className="relative z-10 flex h-full items-center justify-center">
        <div className="marketing-dashboard-preview__core rounded-full border border-primary/30 bg-[#11131b]/92 px-7 py-8 text-center shadow-[0_0_42px_rgba(123,97,255,0.18)]">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white/35">Dashboard live view</p>
          <p className="mt-4 text-4xl font-bold tracking-tight text-white">{activeSurface.value}</p>
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.24em] text-white/45">{activeSurface.label}</p>
          <p className="mt-3 max-w-[12rem] text-sm leading-6 text-white/60">{activeSurface.supporting}</p>
        </div>

        <div className="pointer-events-none absolute inset-0 hidden lg:block">
          {DASHBOARD_SURFACES.map((surface, index) => {
            const Icon = surface.icon;
            const isActive = index === activeIndex;

            return (
              <div
                key={surface.label}
                className="marketing-dashboard-surface absolute left-1/2 top-1/2"
                style={{ transform: positions[index] }}
              >
                <div
                  className={cn(
                    'marketing-dashboard-surface__float flex h-[4.5rem] w-[4.5rem] flex-col items-center justify-center rounded-full border bg-[#12121a]/92 px-3 text-center backdrop-blur-sm transition-[border-color,background-color,box-shadow,opacity,transform] duration-700 ease-out',
                    isActive
                      ? cn('border-white/20 bg-[#171825]/96 opacity-100 scale-110', surface.glowClass)
                      : 'border-white/10 bg-[#12121a]/88 opacity-70 shadow-none',
                  )}
                  style={{ animationDelay: `${index * 140}ms` }}
                >
                  <Icon className={cn('h-5 w-5', surface.tone)} />
                  <p className="mt-2 text-sm font-bold tracking-tight text-white">{surface.value}</p>
                  <p className="mt-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-white/35">{surface.label}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
