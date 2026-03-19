'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { BrandLogo } from '@/components/redesign/brand/logo';
import { ButtonLink } from '@/components/redesign/primitives/button';

import { usePrefersReducedMotion, useSectionScrollProgress } from './use-scroll-progress';

const STAGE_SIZE = 800;
const STAGE_CENTER = STAGE_SIZE / 2;
const TAU = Math.PI * 2;

interface HeroAction {
  href: string;
  label: string;
  id?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
}

export interface LandingHeroOrbitSectionProps {
  eyebrow: string;
  title: ReactNode;
  description: ReactNode;
  primaryAction: HeroAction;
  secondaryAction?: HeroAction;
  badges?: string[];
  centerMark?: ReactNode;
}

interface OrbitItemDefinition {
  id: string;
  label: string;
  kind: string;
  accent: string;
  glow: string;
  radius: number;
  angle: number;
  ellipse: number;
  speed: number;
  drift: number;
  phase: number;
  depthShift: number;
}

const ORBIT_ITEMS: OrbitItemDefinition[] = [
  {
    id: 'x',
    label: 'X',
    kind: 'signal',
    accent: 'rgba(255, 255, 255, 0.72)',
    glow: 'rgba(255, 255, 255, 0.18)',
    radius: 144,
    angle: 0.5,
    ellipse: 0.78,
    speed: -0.26,
    drift: 8,
    phase: 0.3,
    depthShift: 0.9,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    kind: 'model',
    accent: 'rgba(104, 187, 255, 0.84)',
    glow: 'rgba(104, 187, 255, 0.2)',
    radius: 236,
    angle: 5.35,
    ellipse: 0.72,
    speed: 0.2,
    drift: 11,
    phase: 1.1,
    depthShift: 0.4,
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    kind: 'network',
    accent: 'rgba(73, 148, 255, 0.82)',
    glow: 'rgba(73, 148, 255, 0.18)',
    radius: 236,
    angle: 2.22,
    ellipse: 0.72,
    speed: 0.2,
    drift: 9,
    phase: 2.2,
    depthShift: 1.8,
  },
  {
    id: 'meta',
    label: 'Meta',
    kind: 'channel',
    accent: 'rgba(118, 177, 255, 0.82)',
    glow: 'rgba(118, 177, 255, 0.2)',
    radius: 328,
    angle: 0.06,
    ellipse: 0.66,
    speed: -0.15,
    drift: 13,
    phase: 1.7,
    depthShift: 0.2,
  },
  {
    id: 'youtube',
    label: 'YouTube',
    kind: 'video',
    accent: 'rgba(255, 78, 106, 0.9)',
    glow: 'rgba(255, 78, 106, 0.22)',
    radius: 328,
    angle: 2.1,
    ellipse: 0.66,
    speed: -0.15,
    drift: 10,
    phase: 0.9,
    depthShift: 1.3,
  },
  {
    id: 'claude',
    label: 'Claude',
    kind: 'assistant',
    accent: 'rgba(245, 191, 112, 0.86)',
    glow: 'rgba(245, 191, 112, 0.22)',
    radius: 328,
    angle: 5.26,
    ellipse: 0.66,
    speed: -0.15,
    drift: 12,
    phase: 2.7,
    depthShift: 2.2,
  },
];

const ORBIT_RINGS = [
  { id: 'inner', radius: 144, ellipse: 0.78, opacity: 0.72, rotate: 10 },
  { id: 'middle', radius: 236, ellipse: 0.72, opacity: 0.52, rotate: -16 },
  { id: 'outer', radius: 328, ellipse: 0.66, opacity: 0.38, rotate: 20 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function OrbitGlyph({ id }: { id: string }): JSX.Element {
  switch (id) {
    case 'x':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 5 18 19" />
          <path d="M18 5 6 19" />
        </svg>
      );
    case 'meta':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 15c1.8-6.4 4.7-9.6 8-9.6s4.8 3.4 7.8 9.6c-1.2 2.2-2.5 3.3-4 3.3-2.1 0-3-2.8-3.8-5.1-.8 2.3-1.8 5.1-3.8 5.1-1.5 0-2.9-1.1-4.2-3.3Z" />
        </svg>
      );
    case 'linkedin':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4.5" y="4.5" width="15" height="15" rx="3" />
          <path d="M8.3 10.1v6.2" />
          <path d="M8.3 7.8h.02" />
          <path d="M12 16.3v-3.4c0-1.6.9-2.8 2.4-2.8 1.4 0 2.2.9 2.2 2.8v3.4" />
          <path d="M12 10.1v6.2" />
        </svg>
      );
    case 'youtube':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="6.5" width="17" height="11" rx="3.2" />
          <path d="m10 9.6 5 2.4-5 2.4z" />
        </svg>
      );
    case 'gemini':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4.2 13.7 9l4.8 1.7-4.8 1.7-1.7 4.8-1.7-4.8L5.5 10.7 10.3 9Z" />
        </svg>
      );
    case 'claude':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="2.4" />
          <path d="M12 4.5v3" />
          <path d="M12 16.5v3" />
          <path d="m6.2 6.2 2.1 2.1" />
          <path d="m15.7 15.7 2.1 2.1" />
          <path d="M4.5 12h3" />
          <path d="M16.5 12h3" />
          <path d="m6.2 17.8 2.1-2.1" />
          <path d="m15.7 8.3 2.1-2.1" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="6" />
        </svg>
      );
  }
}

function DefaultCenterMark(): JSX.Element {
  return (
    <div className="rd-hero-orbit__center-mark">
      <div className="rd-hero-orbit__center-logo">
        <BrandLogo size={76} variant="mark" priority />
      </div>
      <div className="rd-hero-orbit__center-copy">
        <span className="rd-hero-orbit__center-title">Aries AI</span>
        <span className="rd-hero-orbit__center-caption">Unified marketing intelligence</span>
      </div>
    </div>
  );
}

export default function LandingHeroOrbitSection({
  eyebrow,
  title,
  description,
  primaryAction,
  secondaryAction,
  badges = [],
  centerMark,
}: LandingHeroOrbitSectionProps): JSX.Element {
  const { ref, progress } = useSectionScrollProgress<HTMLElement>(0.16);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [time, setTime] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion) {
      return;
    }

    let frameId = 0;

    const tick = (timestamp: number) => {
      setTime(timestamp / 1000);
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [prefersReducedMotion]);

  const effectiveProgress = prefersReducedMotion ? 0.2 : progress;
  const orbitTightness = clamp(1 - effectiveProgress * 0.78, 0.22, 1);
  const orbitHeight = clamp(1 - effectiveProgress * 0.22, 0.72, 1);
  const scrollSpinBoost = effectiveProgress * 1.4;

  const resolvedRings = useMemo(
    () =>
      ORBIT_RINGS.map((ring) => ({
        ...ring,
        width: ring.radius * 2 * orbitTightness,
        height: ring.radius * 2 * ring.ellipse * orbitTightness * orbitHeight,
        rotation: ring.rotate + (prefersReducedMotion ? 0 : time * 10 * Math.sign(ring.rotate)) + effectiveProgress * 44,
      })),
    [effectiveProgress, orbitHeight, orbitTightness, prefersReducedMotion, time],
  );

  const resolvedItems = useMemo(
    () =>
      ORBIT_ITEMS.map((item, index) => {
        const angle = item.angle + (prefersReducedMotion ? 0 : time * item.speed) + scrollSpinBoost * (index < 3 ? 1 : -1);
        const radiusX = item.radius * orbitTightness;
        const radiusY = item.radius * item.ellipse * orbitTightness * orbitHeight;
        const floatOffset = prefersReducedMotion ? 0 : Math.sin(time * 0.9 + item.phase) * item.drift * (1 - effectiveProgress * 0.55);
        const x = Math.cos(angle * TAU) * radiusX;
        const y = Math.sin(angle * TAU) * radiusY + floatOffset;
        const depth = (Math.sin(angle * TAU + item.depthShift) + 1) / 2;
        const scale = clamp(0.84 + depth * 0.3 - effectiveProgress * 0.08, 0.74, 1.14);
        const opacity = clamp(0.5 + depth * 0.4, 0.48, 1);

        return {
          ...item,
          x,
          y,
          xPos: STAGE_CENTER + x,
          yPos: STAGE_CENTER + y,
          scale,
          opacity,
          lineOpacity: clamp(0.12 + depth * 0.34 - effectiveProgress * 0.08, 0.1, 0.46),
          zIndex: Math.round(depth * 10) + 2,
          lineDelay: index * 0.24,
        };
      }),
    [effectiveProgress, orbitHeight, orbitTightness, prefersReducedMotion, scrollSpinBoost, time],
  );

  const contentStyle = useMemo(
    () =>
      ({
        opacity: clamp(1 - effectiveProgress * 0.28, 0.74, 1),
        transform: `translateY(${effectiveProgress * -28}px)`,
      }) satisfies CSSProperties,
    [effectiveProgress],
  );

  const sceneStyle = useMemo(
    () =>
      ({
        '--rd-hero-progress': effectiveProgress.toFixed(3),
        '--rd-hero-tightness': orbitTightness.toFixed(3),
      }) as CSSProperties,
    [effectiveProgress, orbitTightness],
  );

  return (
    <section ref={ref} className="rd-hero rd-hero--orbit">
      <div className="rd-container rd-hero-orbit__track">
        <div className="rd-hero-orbit__viewport">
          <div className="rd-hero-orbit__grid">
            <div className="rd-hero-orbit__content" style={contentStyle}>
              <p className="rd-hero__eyebrow">{eyebrow}</p>
              <h1 className="rd-hero__title">{title}</h1>
              <p className="rd-hero__description">{description}</p>

              <div className="rd-hero__actions">
                <ButtonLink href={primaryAction.href} id={primaryAction.id} variant={primaryAction.variant ?? 'primary'}>
                  {primaryAction.label}
                </ButtonLink>
                {secondaryAction ? (
                  <ButtonLink
                    href={secondaryAction.href}
                    id={secondaryAction.id}
                    variant={secondaryAction.variant ?? 'secondary'}
                  >
                    {secondaryAction.label}
                  </ButtonLink>
                ) : null}
              </div>

              {badges.length ? (
                <div className="rd-hero-orbit__badge-row" aria-label="Hero capabilities">
                  {badges.map((badge) => (
                    <span key={badge} className="rd-hero-orbit__badge">
                      {badge}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rd-hero-orbit__scene-shell">
              <div className="rd-hero-orbit__scroll-meter" aria-hidden="true">
                <span>Scroll to focus the orbit</span>
                <div className="rd-hero-orbit__scroll-bar">
                  <span
                    style={{ transform: `scaleX(${clamp(effectiveProgress * 1.08 + 0.04, 0.04, 1)})` }}
                  />
                </div>
              </div>

              <div className="rd-hero-orbit__scene" style={sceneStyle}>
                <div className="rd-hero-orbit__gridlines" aria-hidden="true" />
                <div className="rd-hero-orbit__aura rd-hero-orbit__aura--violet" aria-hidden="true" />
                <div className="rd-hero-orbit__aura rd-hero-orbit__aura--cyan" aria-hidden="true" />
                <div className="rd-hero-orbit__aura rd-hero-orbit__aura--amber" aria-hidden="true" />

                {resolvedRings.map((ring) => (
                  <div
                    key={ring.id}
                    className="rd-hero-orbit__ring"
                    style={
                      {
                        width: `${(ring.width / STAGE_SIZE) * 100}%`,
                        height: `${(ring.height / STAGE_SIZE) * 100}%`,
                        opacity: ring.opacity,
                        transform: `translate(-50%, -50%) rotate(${ring.rotation}deg)`,
                      } as CSSProperties
                    }
                    aria-hidden="true"
                  />
                ))}

                <svg
                  className="rd-hero-orbit__lines"
                  viewBox={`0 0 ${STAGE_SIZE} ${STAGE_SIZE}`}
                  preserveAspectRatio="xMidYMid meet"
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient id="rd-hero-orbit-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="rgba(255,255,255,0.06)" />
                      <stop offset="50%" stopColor="rgba(191, 146, 255, 0.82)" />
                      <stop offset="100%" stopColor="rgba(97, 215, 255, 0.08)" />
                    </linearGradient>
                    <filter id="rd-hero-orbit-glow" x="-40%" y="-40%" width="180%" height="180%">
                      <feGaussianBlur stdDeviation="3.5" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>

                  {resolvedItems.map((item) => (
                    <path
                      key={item.id}
                      className="rd-hero-orbit__line"
                      d={`M ${STAGE_CENTER} ${STAGE_CENTER} Q ${STAGE_CENTER + item.x * 0.42} ${
                        STAGE_CENTER + item.y * 0.18
                      } ${item.xPos} ${item.yPos}`}
                      style={{ opacity: item.lineOpacity, animationDelay: `${item.lineDelay}s` } as CSSProperties}
                    />
                  ))}
                </svg>

                <div className="rd-hero-orbit__core">
                  {centerMark ?? <DefaultCenterMark />}
                </div>

                {resolvedItems.map((item) => (
                  <div
                    key={item.id}
                    className="rd-hero-orbit__chip"
                    style={
                      {
                        left: `${(item.xPos / STAGE_SIZE) * 100}%`,
                        top: `${(item.yPos / STAGE_SIZE) * 100}%`,
                        transform: `translate(-50%, -50%) scale(${item.scale})`,
                        opacity: item.opacity,
                        zIndex: item.zIndex,
                        '--chip-accent': item.accent,
                        '--chip-glow': item.glow,
                      } as CSSProperties
                    }
                  >
                    <span className="rd-hero-orbit__chip-icon" aria-hidden="true">
                      <OrbitGlyph id={item.id} />
                    </span>
                    <span className="rd-hero-orbit__chip-copy">
                      <strong>{item.label}</strong>
                      <small>{item.kind}</small>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
