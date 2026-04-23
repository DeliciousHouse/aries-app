'use client';

import { Fragment, useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent, type SVGProps } from 'react';

import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Facebook,
  Instagram,
  Layers,
  Lightbulb,
  Linkedin,
  MoreHorizontal,
  PenTool,
  Play,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Sparkles,
  TrendingDown,
  Youtube,
  Zap,
  AlertCircle,
} from 'lucide-react';
import { motion, useScroll, useSpring, useTransform, type MotionValue } from 'motion/react';

import { cn } from '../lib/utils';
import { AriesMark } from '../ui';
import { DonorMarketingShell } from './chrome';

const EARLY_ACCESS_STEPS = [
  ['01', ['Beta invite']],
  ['02', ['Workspace', 'preview']],
  ['03', ['Priority', 'setup']],
] as const;

function EarlyAccessCopy({
  titleId,
  headingTag = 'h2',
}: {
  titleId?: string;
  headingTag?: 'h2' | 'h3';
}) {
  const HeadingTag = headingTag;

  return (
    <div>
      <span className="inline-flex rounded-full border border-primary/20 bg-primary/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.2em] text-primary">
        Early access
      </span>
      <HeadingTag id={titleId} className="mt-6 text-4xl font-light leading-tight md:text-[52px]">
        Sign in to get <span className="text-gradient">early access</span>
      </HeadingTag>
      <p className="mt-6 max-w-2xl text-lg leading-8 text-white/62">
        Join the first group of businesses getting Aries for campaign planning, approval-safe creative, launch scheduling, and clear weekly results.
      </p>

      <div className="mt-[50px] grid w-full gap-4 sm:grid-cols-3">
        {EARLY_ACCESS_STEPS.map(([count, labelLines]) => (
          <div
            key={count}
            className="group min-h-28 rounded-[1.25rem] border border-white/10 bg-black/35 p-5 transition-colors hover:border-primary/35 hover:bg-primary/10"
          >
            <div className="text-3xl font-light leading-none tracking-[0.08em] text-white">{count}</div>
            <div className="mt-5 text-[10px] font-semibold uppercase leading-5 tracking-[0.3em] text-white/45">
              {labelLines.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EarlyAccessForm({
  source,
  emailInputId,
  className,
  variant = 'default',
  buttonLabel = 'Request access',
}: {
  source: string;
  emailInputId: string;
  className?: string;
  variant?: 'default' | 'hero';
  buttonLabel?: string;
}) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (variant !== 'hero' || status !== 'success' || !message) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setMessage(null);
      setStatus('idle');
    }, 3000);

    return () => window.clearTimeout(timeoutId);
  }, [message, status, variant]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setStatus('error');
      setMessage('Enter your email to request early access.');
      return;
    }

    setStatus('loading');
    setMessage(null);

    try {
      const response = await fetch('/api/early-access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: trimmedEmail,
          source,
        }),
      });
      const result = (await response.json()) as { message?: string };

      if (!response.ok) {
        throw new Error(result.message || 'We could not save your email right now.');
      }

      setStatus('success');
      setMessage(result.message || "You're on the early access list.");
      setEmail('');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'We could not save your email right now.');
    }
  }

  const isHeroVariant = variant === 'hero';

  return (
    <form onSubmit={handleSubmit} className={cn(className, isHeroVariant ? 'mx-auto flex flex-col items-center' : '')}>
      <label
        className={cn('block text-sm font-semibold text-white/80', isHeroVariant ? 'sr-only' : '')}
        htmlFor={emailInputId}
      >
        {isHeroVariant ? 'Email address' : 'Work email'}
      </label>
      <div
        className={cn(
          'mt-3',
          isHeroVariant ? 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-center' : 'flex flex-col gap-3 sm:flex-row lg:flex-col xl:flex-row',
        )}
      >
        {isHeroVariant ? (
          <input
            id={emailInputId}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Enter email address"
            className="w-full sm:w-[300px] md:w-[340px] rounded-full bg-white/6 px-6 py-4 text-base text-white outline-none transition placeholder:text-white/30 focus:border-primary/50 shadow-xl shadow-black/20"
            style={{ border: '1px solid #fff3' }}
            disabled={status === 'loading'}
          />
        ) : (
          <input
            id={emailInputId}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-white outline-none transition placeholder:text-white/30 focus:border-primary/50"
            disabled={status === 'loading'}
          />
        )}
        <button
          type="submit"
          disabled={status === 'loading'}
          className={cn(
            'bg-gradient-to-r from-primary to-secondary font-bold text-white shadow-lg shadow-primary/20 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60',
            isHeroVariant
              ? 'rounded-full px-8 py-4 text-base sm:flex-none'
              : 'rounded-2xl px-5 py-3 text-sm',
          )}
        >
          {status === 'loading' ? 'Saving...' : buttonLabel}
        </button>
      </div>
      {message ? (
        <p
          className={cn(
            'mt-4 rounded-xl border px-4 py-3 text-sm',
            isHeroVariant ? 'text-center' : '',
            status === 'success'
              ? 'border-primary/25 bg-primary/10 text-white'
              : 'border-red-400/20 bg-red-400/10 text-red-100',
          )}
        >
          {message}
        </p>
      ) : isHeroVariant ? null : (
        <p className="mt-4 text-sm leading-6 text-white/42">
          We will only use this email to contact you about Aries early access.
        </p>
      )}
    </form>
  );
}

function NetworkBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId = 0;
    let particles: Array<{
      x: number;
      y: number;
      vx: number;
      vy: number;
      radius: number;
    }> = [];

    const initParticles = () => {
      particles = [];
      const count = Math.min(Math.floor((window.innerWidth * window.innerHeight) / 15000), 100);
      for (let index = 0; index < count; index += 1) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.5,
          radius: Math.random() * 1.5 + 0.5,
        });
      }
    };

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      initParticles();
    };

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < particles.length; i += 1) {
        const particle = particles[i];
        particle.x += particle.vx;
        particle.y += particle.vy;

        if (particle.x < 0 || particle.x > canvas.width) particle.vx *= -1;
        if (particle.y < 0 || particle.y > canvas.height) particle.vy *= -1;

        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(124, 58, 237, 0.9)';
        ctx.fill();

        for (let j = i + 1; j < particles.length; j += 1) {
          const other = particles[j];
          const dx = particle.x - other.x;
          const dy = particle.y - other.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < 150) {
            ctx.beginPath();
            const opacity = 0.6 * (1 - distance / 150);
            ctx.strokeStyle = `rgba(124, 58, 237, ${opacity})`;
            ctx.lineWidth = 1;
            ctx.moveTo(particle.x, particle.y);
            ctx.lineTo(other.x, other.y);
            ctx.stroke();
          }
        }
      }

      animationFrameId = requestAnimationFrame(animate);
    };

    window.addEventListener('resize', resize);
    resize();
    animate();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 z-0 pointer-events-none opacity-60" />;
}

type PlatformOrbit = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  angle: number;
  radius: number;
};

function XTwitterLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function RedditLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M20.18 11.08c-.72 0-1.34.4-1.66.98-1.42-.86-3.34-1.41-5.47-1.47l.93-4.39 3.04.65a1.5 1.5 0 1 0 .17-.8l-3.47-.74a.41.41 0 0 0-.49.32l-1.05 4.95c-2.18.04-4.15.59-5.6 1.47a1.9 1.9 0 1 0-2.1 2.99 3.73 3.73 0 0 0-.05.61c0 2.8 3.4 5.08 7.6 5.08s7.6-2.27 7.6-5.08c0-.2-.02-.4-.05-.59a1.9 1.9 0 0 0 .6-3.98ZM7.75 14.9a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0Zm7.25 3.2c-.83.83-2.42.9-2.95.9-.53 0-2.13-.07-2.95-.9a.4.4 0 0 1 .56-.56c.52.52 1.6.66 2.39.66.78 0 1.87-.14 2.39-.66a.4.4 0 1 1 .56.56Zm-.77-1.95a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z" />
    </svg>
  );
}

function PinterestLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12.02 2C6.49 2 2.5 5.96 2.5 11.24c0 3.93 2.2 6.24 3.48 6.24.53 0 .83-1.48.83-1.9 0-.5-1.27-1.56-1.27-3.63 0-4.29 3.26-7.33 7.49-7.33 3.63 0 6.31 2.06 6.31 5.85 0 2.83-1.14 8.15-4.82 8.15-1.33 0-2.46-.96-2.46-2.34 0-2.02 1.41-3.98 1.41-6.06 0-3.53-5.01-2.89-5.01 1.38 0 .9.11 1.9.51 2.72-.74 3.16-2.25 7.86-2.25 11.1 0 1 .14 1.98.24 2.97.17.19.08.17.34.08 2.68-3.67 2.58-4.39 3.8-9.19.66 1.25 2.35 1.92 3.7 1.92 5.68 0 8.23-5.53 8.23-10.52C23.03 5.38 18.38 2 12.02 2Z" />
    </svg>
  );
}

function WikipediaLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M2.2 5.2h5.1v.7c-.72.05-1.2.16-1.44.32-.24.16-.36.4-.36.72 0 .2.05.47.16.8l3.1 8.93 2.05-5.12-1.35-3.8c-.22-.64-.49-1.09-.82-1.34-.33-.25-.83-.42-1.5-.5v-.7h5.37v.7c-.73.04-1.22.13-1.47.28-.24.15-.36.4-.36.75 0 .2.05.46.16.78l.66 1.93.65-1.65c.18-.47.27-.83.27-1.08 0-.34-.13-.58-.4-.74-.27-.16-.73-.25-1.38-.28v-.7h4.8v.7c-.67.1-1.18.29-1.52.58-.34.29-.67.84-.99 1.65l-1.04 2.64 2.08 5.89 2.95-8.5c.13-.38.2-.72.2-1.02 0-.38-.15-.67-.45-.86-.3-.2-.82-.32-1.56-.37v-.7h4.73v.7c-.61.08-1.05.25-1.33.51-.28.26-.56.78-.84 1.55L14.1 21.3h-.76l-2.2-6.2-2.5 6.2h-.77L3.28 7.7c-.23-.69-.48-1.15-.75-1.38-.27-.23-.71-.37-1.33-.42v-.7Z" />
    </svg>
  );
}

const PLATFORM_ORBITS: PlatformOrbit[] = [
  { icon: XTwitterLogo, angle: 12, radius: 180 },
  { icon: Instagram, angle: 145, radius: 300 },
  { icon: Linkedin, angle: 35, radius: 300 },
  { icon: RedditLogo, angle: 275, radius: 300 },
  { icon: Facebook, angle: 205, radius: 420 },
  { icon: Youtube, angle: 115, radius: 420 },
  { icon: PinterestLogo, angle: 335, radius: 420 },
  { icon: WikipediaLogo, angle: 255, radius: 420 },
];

const MOBILE_PLATFORM_LAYOUT: Array<{
  icon: PlatformOrbit['icon'];
  angle: number;
  ringScale: number;
}> = [
  { icon: WikipediaLogo, angle: 282, ringScale: 1 },
  { icon: PinterestLogo, angle: 338, ringScale: 0.84 },
  { icon: Linkedin, angle: 22, ringScale: 0.84 },
  { icon: Youtube, angle: 92, ringScale: 1 },
  { icon: Instagram, angle: 150, ringScale: 0.84 },
  { icon: Facebook, angle: 212, ringScale: 1 },
  { icon: RedditLogo, angle: 128, ringScale: 0.62 },
  { icon: XTwitterLogo, angle: 236, ringScale: 0.5 },
];

const DESKTOP_RING_SCALES = [0.5, 0.76, 1] as const;

function OrbitLine({
  angle,
  radius,
  rotation,
  progress,
  index,
  startRadius,
  endPadding,
}: {
  angle: number;
  radius: number;
  rotation: MotionValue<number>;
  progress: MotionValue<number>;
  index: number;
  startRadius: number;
  endPadding: number;
}) {
  const lineTargetRadius = Math.max(startRadius, radius - endPadding);
  const lineStart = 0.3 + index * 0.015;
  const lineEnd = 0.35 + index * 0.015;
  const lineCurrentRadius = useTransform(progress, [lineStart, lineEnd, 0.9, 1.0], [startRadius, lineTargetRadius, lineTargetRadius, startRadius]);
  const lineOpacity = useTransform(progress, [lineStart, lineStart + 0.01, 0.9, 1.0], [0, 0.8, 0.8, 0]);

  const x1 = useTransform(rotation, (rot) => Math.cos(((angle + rot) * Math.PI) / 180) * startRadius);
  const y1 = useTransform(rotation, (rot) => Math.sin(((angle + rot) * Math.PI) / 180) * startRadius);
  const x2 = useTransform([lineCurrentRadius, rotation], ([r, rot]) => Math.cos(((angle + (rot as number)) * Math.PI) / 180) * (r as number));
  const y2 = useTransform([lineCurrentRadius, rotation], ([r, rot]) => Math.sin(((angle + (rot as number)) * Math.PI) / 180) * (r as number));

  return (
    <motion.line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke="url(#line-gradient)"
      strokeWidth="3"
      strokeDasharray="15 30"
      filter="url(#glow)"
      animate={{ strokeDashoffset: [45, 0] }}
      transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
      style={{ opacity: lineOpacity }}
    />
  );
}

function OrbitPlatform({
  platform,
  rotation,
  progress,
  index,
  platformSize,
  iconSize,
}: {
  platform: PlatformOrbit;
  rotation: MotionValue<number>;
  progress: MotionValue<number>;
  index: number;
  platformSize: number;
  iconSize: number;
}) {
  const platformRadius = useTransform(progress, [0, 0.05, 0.15, 0.9, 1.0], [0, 0, platform.radius, platform.radius, 0]);
  const x = useTransform([platformRadius, rotation], ([r, rot]) => Math.cos(((platform.angle + (rot as number)) * Math.PI) / 180) * (r as number));
  const y = useTransform([platformRadius, rotation], ([r, rot]) => Math.sin(((platform.angle + (rot as number)) * Math.PI) / 180) * (r as number));
  const Icon = platform.icon;

  return (
    <motion.div
      style={{
        position: 'absolute',
        x,
        y,
        scale: useTransform(platformRadius, [0, platform.radius], [0, 1]),
      }}
      className="relative"
    >
      <div
        className="rounded-full bg-white/5 border border-white/10 backdrop-blur-md flex items-center justify-center shadow-2xl shadow-white/5 relative z-10"
        style={{ width: platformSize, height: platformSize }}
      >
        <Icon className="text-white" style={{ width: iconSize, height: iconSize }} />
      </div>
      <motion.div
        className="absolute inset-0 rounded-full border-2 border-secondary/30"
        animate={{ scale: [1, 1.5], opacity: [0.5, 0] }}
        transition={{ duration: 2, repeat: Infinity, delay: index * 0.3, ease: 'easeOut' }}
      />
    </motion.div>
  );
}

function Hero() {
  const containerRef = useRef<HTMLElement>(null);
  const [isMounted, setIsMounted] = useState(false);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end start'],
  });

  const smoothProgress = useSpring(scrollYProgress, {
    stiffness: 100,
    damping: 30,
    restDelta: 0.001,
  });

  const [windowSize, setWindowSize] = useState({ width: 1280, height: 800 });

  useEffect(() => {
    setIsMounted(true);
    const updateSize = () => {
      setWindowSize({
        width: document.documentElement.clientWidth,
        height: window.innerHeight,
      });
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  const particles = useMemo(
    () =>
      Array.from({ length: 20 }, (_, index) => ({
        id: index,
        left: `${(index * 17) % 100}%`,
        top: `${(index * 29) % 100}%`,
        y: -100 - ((index * 31) % 100),
        x: ((index % 2 === 0 ? 1 : -1) * (15 + ((index * 7) % 35))),
        duration: 5 + (index % 5),
        delay: (index % 6) * 0.6,
        scale: 0.5 + ((index * 9) % 10) / 10,
      })),
    [],
  );

  const navbarLogoX = Math.max(24, (windowSize.width - 1280) / 2) + 40;
  const navbarLogoY = 56;
  const startX = navbarLogoX - windowSize.width / 2;
  const startY = navbarLogoY - windowSize.height / 2;
  const isMobile = windowSize.width < 640;
  const isTablet = windowSize.width < 1024;
  const platformSize = isMobile ? 48 : isTablet ? 64 : windowSize.width < 1280 ? 72 : 80;
  const iconSize = isMobile ? 24 : isTablet ? 32 : windowSize.width < 1280 ? 36 : 40;
  const centerOuterSize = isMobile ? 82 : isTablet ? 128 : 160;
  const centerInnerSize = isMobile ? 56 : isTablet ? 88 : 112;
  const logoSize = isMobile ? 40 : isTablet ? 62 : 80;
  const logoScaleFactor = isMobile ? 1.2 : isTablet ? 1.32 : 1.5625;
  const orbitLineStartRadius = isMobile ? 18 : isTablet ? 22 : 25;
  const orbitLineEndPadding = Math.max(24, platformSize / 2 + 12);
  const viewportPadding = isMobile ? 20 : isTablet ? 32 : 12;
  const availableOrbitRadius = Math.max(
    140,
    Math.min(
      (windowSize.width - viewportPadding * 2 - platformSize) / 2,
      (windowSize.height - viewportPadding * 2 - platformSize) / 2,
    ),
  );
  const mobileRingRadius = Math.max(132, Math.round(availableOrbitRadius));
  const desktopOuterRadius = Math.round(availableOrbitRadius);
  const orbitRadii = isMobile
    ? [0.42, 0.72, 1].map((scale) => Math.round(mobileRingRadius * scale))
    : isTablet
      ? [180, 300, 420].map((radius) => Math.round(radius * Math.min(1, availableOrbitRadius / 420)))
      : DESKTOP_RING_SCALES.map((scale) => Math.round(desktopOuterRadius * scale));
  const scaledPlatforms = isMobile
    ? MOBILE_PLATFORM_LAYOUT.map((platform) => ({
        icon: platform.icon,
        angle: platform.angle,
        radius: Math.round(mobileRingRadius * platform.ringScale),
      }))
    : isTablet
      ? PLATFORM_ORBITS.map((platform) => ({
          ...platform,
          radius: Math.round(platform.radius * Math.min(1, availableOrbitRadius / 420)),
        }))
      : PLATFORM_ORBITS.map((platform) => ({
          ...platform,
          radius:
            platform.radius === 180
              ? Math.round(desktopOuterRadius * DESKTOP_RING_SCALES[0])
              : platform.radius === 300
                ? Math.round(desktopOuterRadius * DESKTOP_RING_SCALES[1])
                : desktopOuterRadius,
        }));
  const maxOrbitRadius = Math.max(...orbitRadii, 0);
  const orbitExtent = maxOrbitRadius + platformSize;
  const orbitCanvasSize = orbitExtent * 2;

  const logoX = useTransform(smoothProgress, [0, 0.15, 0.3, 0.5, 0.95, 1], [startX, startX, 0, 0, startX, startX]);
  const logoY = useTransform(smoothProgress, [0, 0.15, 0.3, 0.5, 0.95, 1], [startY, startY, 0, 0, startY, startY]);
  const logoScale = useTransform(smoothProgress, [0, 0.15, 0.3, 0.5, 0.95, 1], [1, 1, logoScaleFactor, logoScaleFactor, 1, 1]);
  const logoOpacity = useTransform(smoothProgress, [0, 0.95, 1], [1, 1, 0]);
  const centralCircleOpacity = useTransform(smoothProgress, [0, 0.05, 0.15, 0.9, 1.0], [0, 0, 1, 1, 0]);
  const centralCircleScale = useTransform(smoothProgress, [0, 0.05, 0.15, 0.9, 1.0], [0.5, 0.5, 1, 1, 0.5]);
  const platformsOpacity = useTransform(smoothProgress, [0, 0.05, 0.15, 0.9, 1.0], [0, 0, 1, 1, 0]);
  const platformsRotate = useTransform(smoothProgress, [0, 1], [0, 360]);

  return (
    <section ref={containerRef} className="relative h-[250vh]">
      <div className="sticky top-0 h-screen w-full flex items-center justify-center overflow-hidden bg-animate">
        <NetworkBackground />

        <div className="absolute inset-0 z-0">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[120px] animate-pulse" />
          <div
            className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-secondary/10 rounded-full blur-[120px] animate-pulse"
            style={{ animationDelay: '2s' }}
          />
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {particles.map((particle) => (
              <motion.div
                key={particle.id}
                className="absolute w-1.5 h-1.5 bg-primary/40 rounded-full"
                style={{ left: particle.left, top: particle.top }}
                animate={{
                  y: [0, particle.y],
                  x: [0, particle.x],
                  opacity: [0, 0.8, 0],
                  scale: [0, particle.scale, 0],
                }}
                transition={{
                  duration: particle.duration,
                  repeat: Infinity,
                  ease: 'linear',
                  delay: particle.delay,
                }}
              />
            ))}
          </div>
        </div>

        <div className="container mx-auto px-6 relative z-20 text-center pt-48 md:pt-32 lg:pt-0">
          <motion.div style={{ opacity: useTransform(smoothProgress, [0, 0.05], [1, 0]) }} className="mb-8">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass-reflection relative">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-white/80">The system small businesses actually use to grow</span>
            </div>
          </motion.div>

          <motion.h1
            style={{
              opacity: useTransform(smoothProgress, [0, 0.05], [1, 0]),
              y: useTransform(smoothProgress, [0, 0.05], [0, -20]),
            }}
            className="text-3xl md:text-[3rem] lg:text-[4rem] font-bold tracking-tight mb-8 leading-[1.1]"
          >
            Marketing without a system is expensive. <br />
            <span className="text-gradient">Aries gives you the system.</span>
          </motion.h1>

          <motion.p
            style={{
              opacity: useTransform(smoothProgress, [0, 0.05], [1, 0]),
              y: useTransform(smoothProgress, [0, 0.05], [0, -20]),
            }}
            className="max-w-2xl mx-auto text-[1rem] text-white/60 mb-12"
          >
            Plan campaigns, approve creative, launch safely. Nothing goes live without your approval — and you always know what is running, what needs your sign-off, and how your campaigns are performing.
          </motion.p>

          <motion.div
            style={{
              opacity: useTransform(smoothProgress, [0, 0.05], [1, 0]),
              y: useTransform(smoothProgress, [0, 0.05], [0, -20]),
            }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4"
          >
            <a
              href="/onboarding/start"
              className="w-full sm:w-auto px-8 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 hover:scale-105 transition-transform flex items-center justify-center gap-2"
            >
              Start with your business <ArrowRight className="w-5 h-5" />
            </a>
            <a
              href="/login"
              className="w-full sm:w-auto px-8 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2"
            >
              Log in
            </a>
            <a
              href="/#how-it-works"
              className="w-full sm:w-auto px-8 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2"
            >
              <Play className="w-5 h-5 fill-current" /> See how it works
            </a>
          </motion.div>

          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <motion.div style={{ opacity: platformsOpacity }} className="absolute inset-0 flex items-center justify-center">
              {orbitRadii.map((radius) => (
                <div key={radius} className="absolute rounded-full border border-white/5" style={{ width: radius * 2, height: radius * 2 }} />
              ))}
            </motion.div>

            <motion.div
              style={{
                opacity: centralCircleOpacity,
                scale: centralCircleScale,
                width: centerOuterSize,
                height: centerOuterSize,
              }}
              className="rounded-full border border-white/10 bg-white/5 backdrop-blur-sm flex items-center justify-center"
            >
              <div className="rounded-full border border-primary/20 animate-pulse" style={{ width: centerInnerSize, height: centerInnerSize }} />
            </motion.div>

            <svg
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none overflow-visible"
              width={orbitCanvasSize}
              height={orbitCanvasSize}
              viewBox={`${-orbitExtent} ${-orbitExtent} ${orbitCanvasSize} ${orbitCanvasSize}`}
            >
              <defs>
                <linearGradient id="line-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.1" />
                  <stop offset="50%" stopColor="#a855f7" stopOpacity="1" />
                  <stop offset="100%" stopColor="#c084fc" stopOpacity="0.1" />
                </linearGradient>
                <filter id="glow">
                  <feGaussianBlur stdDeviation="2" result="coloredBlur" />
                  <feMerge>
                    <feMergeNode in="coloredBlur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              {isMounted && scaledPlatforms.map((platform, index) => (
                <OrbitLine
                  key={`${platform.angle}-${platform.radius}`}
                  angle={platform.angle}
                  radius={platform.radius}
                  rotation={platformsRotate}
                  progress={smoothProgress}
                  index={index}
                  startRadius={orbitLineStartRadius}
                  endPadding={orbitLineEndPadding}
                />
              ))}
            </svg>

            <motion.div style={{ opacity: platformsOpacity }} className="absolute w-full h-full flex items-center justify-center">
              {scaledPlatforms.map((platform, index) => (
                <OrbitPlatform
                  key={`${platform.angle}-${platform.radius}`}
                  platform={platform}
                  rotation={platformsRotate}
                  progress={smoothProgress}
                  index={index}
                  platformSize={platformSize}
                  iconSize={iconSize}
                />
              ))}
            </motion.div>

            <motion.div
              style={{
                x: logoX,
                y: logoY,
                scale: logoScale,
                opacity: logoOpacity,
                position: 'fixed',
                top: '50%',
                left: '50%',
                marginTop: `${logoSize / -2}px`,
                marginLeft: `${logoSize / -2}px`,
              }}
              className="z-[60]"
            >
              <div className="relative">
                <div style={{ width: logoSize, height: logoSize }}>
                  <AriesMark sizeClassName="w-full h-full" />
                </div>
                <motion.div
                  className="absolute inset-0 rounded-full border-2 border-primary/50"
                  animate={{ scale: [1, 2], opacity: [0.8, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
                />
              </div>
            </motion.div>
          </div>
        </div>


      </div>


      {/* Floating Insight Cards (Viewport-Anchored) */}
      <div className="hidden lg:block sticky top-0 h-screen w-screen pointer-events-none z-30 -mt-[100vh]">
        {/* Analytics Card (Left Anchor) */}
        <div className="absolute inset-x-0 top-0 h-full pointer-events-none px-[4vw]">
          <motion.div
            style={{
              left: 0,
              top: '66%',
              opacity: useTransform(smoothProgress, [0, 0.15], [1, 0])
            }}
            animate={{ y: [-15, 15, -15] }}
            transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
            className="absolute glass p-5 rounded-3xl w-72 text-left border border-white/10 glow-purple pointer-events-auto shadow-2xl"
          >
              <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-primary/20 rounded-lg">
                <BarChart3 className="w-5 h-5 text-primary" />
              </div>
              <span className="font-bold text-white">Approvals</span>
            </div>
            <p className="text-sm font-medium text-white/50 tracking-tight">3 items waiting for review</p>
          </motion.div>


          {/* Auto-Post Card (Force-Right Anchor via Flex) */}
          <div className="absolute inset-0 flex justify-end items-start pt-[70vh] px-[4vw]">
            <motion.div
              style={{
                opacity: useTransform(smoothProgress, [0, 0.15], [1, 0])
              }}
              animate={{ y: [15, -15, 15] }}
              transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
              className="glass p-5 rounded-3xl w-64 text-left border border-white/10 glow-purple pointer-events-auto shadow-2xl relative"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-secondary/20 rounded-lg">
                  <Share2 className="w-5 h-5 text-secondary" />
                </div>
                <span className="font-bold text-white">Scheduled</span>
              </div>
              <p className="text-sm font-medium text-white/50 tracking-tight">Next Thu at 8:30 AM</p>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Problem() {
  const problems = [
    {
      icon: <TrendingDown className="w-6 h-6 text-red-400" />,
      title: 'Missed launches',
      description: 'Without a clear schedule, campaigns slip and opportunities pass before you notice.',
    },
    {
      icon: <AlertCircle className="w-6 h-6 text-orange-400" />,
      title: 'Unclear approvals',
      description: 'When nobody knows who approved what, mistakes go live and trust erodes fast.',
    },
    {
      icon: <Clock className="w-6 h-6 text-yellow-400" />,
      title: 'Scattered results',
      description: 'Checking five different dashboards to answer one question: \u2018are my campaigns delivering results?\u2019',
    },
    {
      icon: <Layers className="w-6 h-6 text-blue-400" />,
      title: 'No clear next step',
      description: 'Finishing a campaign and having no idea what to do next to keep momentum going.',
    },
  ];

  return (
    <section id="product" className="py-24 relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="relative z-10 text-center mb-16">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-4xl md:text-5xl font-bold mb-6"
          >
            Marketing without a system is <span className="text-red-400">stressful</span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 }}
            className="text-white/60 max-w-2xl mx-auto"
          >
            Small businesses deserve a calm, clear place to plan marketing, approve work, and see what is actually driving results.
          </motion.p>
        </div>

        <div className="relative z-10 grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {problems.map((problem, index) => (
            <motion.div
              key={problem.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1 }}
              className="glass p-8 rounded-3xl border border-white/5 hover:border-white/20 transition-all group"
            >
              <div className="mb-6 w-fit p-3 rounded-full border border-white/10 bg-black/35 backdrop-blur-sm flex items-center justify-center group-hover:scale-110 transition-transform">
                {problem.icon}
              </div>
              <h3 className="text-xl font-bold mb-4">{problem.title}</h3>
              <p className="text-white/50 text-sm leading-relaxed">{problem.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Features() {
  const features = [
    {
      icon: <Share2 className="w-6 h-6" />,
      title: 'Campaign planning',
      description: 'Turn your business goals into a clear campaign plan you can read in seconds.',
      color: 'from-blue-500/20 to-blue-600/20',
    },
    {
      icon: <Search className="w-6 h-6" />,
      title: 'Creative review',
      description: 'See every draft, compare versions, and approve what ships before it goes live.',
      color: 'from-purple-500/20 to-purple-600/20',
    },
    {
      icon: <PenTool className="w-6 h-6" />,
      title: 'Approval safety',
      description: 'Nothing publishes without sign-off. Material edits return to review automatically.',
      color: 'from-pink-500/20 to-pink-600/20',
    },
    {
      icon: <Zap className="w-6 h-6" />,
      title: 'Launch scheduling',
      description: 'See exactly what is going out, when, and on which channels before it runs.',
      color: 'from-yellow-500/20 to-yellow-600/20',
    },
    {
      icon: <BarChart3 className="w-6 h-6" />,
      title: 'Results clarity',
      description: 'Business-readable reporting that answers one question: \u2018which efforts are performing best?\u2019',
      color: 'from-green-500/20 to-green-600/20',
    },
    {
      icon: <RefreshCw className="w-6 h-6" />,
      title: 'Next-step recommendations',
      description: 'Every result ends with a clear next action so you always know what to do.',
      color: 'from-red-500/20 to-red-600/20',
    },
  ];

  return (
    <section id="features" className="py-24 relative">
      <div className="container mx-auto px-6">
        <div className="text-center mb-20">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-4xl md:text-[48px] leading-tight font-bold mb-6"
          >
            Everything you need to <br />
            <span className="text-gradient">market with confidence</span>
          </motion.h2>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1 }}
              whileHover={{ y: -10 }}
              className="glass p-10 rounded-[2.5rem] relative overflow-hidden group"
            >
              <div className={cn('absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500', feature.color)} />

              <div className="relative z-10">
                <div className="mb-8 p-4 bg-white/5 rounded-2xl w-fit group-hover:bg-white/10 transition-colors">
                  {feature.icon}
                </div>
                <h3 className="text-2xl font-bold mb-4">{feature.title}</h3>
                <p className="text-white/50 leading-relaxed">{feature.description}</p>
              </div>

              <div className="absolute -bottom-10 -right-10 w-32 h-32 bg-primary/10 blur-3xl rounded-full group-hover:bg-primary/20 transition-all" />
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      icon: <Search className="w-6 h-6 text-primary" />,
      title: 'Connect your business',
      description: 'Set up once with your website, brand, and goals. Aries handles the rest.',
    },
    {
      icon: <Lightbulb className="w-6 h-6 text-secondary" />,
      title: 'Review the plan',
      description: 'See a clear campaign plan in plain English before anything is created.',
    },
    {
      icon: <Zap className="w-6 h-6 text-yellow-400" />,
      title: 'Approve and launch',
      description: 'Review every creative draft, approve what ships, and schedule with confidence.',
    },
    {
      icon: <BarChart3 className="w-6 h-6 text-green-400" />,
      title: 'See what delivered results',
      description: 'Business-readable results with one clear recommendation for what to do next.',
    },
  ];

  return (
    <section id="how-it-works" className="py-24 relative">
      <div className="container mx-auto px-6">
        <div className="text-center mb-20">
          <h2 className="text-4xl md:text-[48px] leading-tight font-bold mb-6">How It Works</h2>
          <p className="text-white/60">Four steps to marketing clarity.</p>
        </div>

        <div className="relative">
          <div className="hidden lg:block absolute top-1/2 left-0 right-0 h-0.5 bg-gradient-to-r from-primary/20 via-secondary/20 to-primary/20 -translate-y-1/2 z-0" />

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-12">
            {steps.map((step, index) => (
              <motion.div
                key={step.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.2 }}
                className="relative z-10 text-center"
              >
                <div className="w-20 h-20 mx-auto mb-8 rounded-3xl bg-white/5 border border-white/10 flex items-center justify-center relative group">
                  <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                  {step.icon}
                  <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-black border border-white/10 flex items-center justify-center text-xs font-bold">
                    0{index + 1}
                  </div>
                </div>
                <h3 className="text-xl font-bold mb-4">{step.title}</h3>
                <p className="text-white/50 text-sm leading-relaxed">{step.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Demo schedule for the marketing calendar section (static showcase data). */
const CONTENT_CALENDAR_SCHEDULE = [
  {
    day: 'Mon',
    date: '6',
    posts: [
      { title: 'AI Marketing Trends 2026 Strategy', platform: 'LinkedIn', time: '09:00', status: 'Published' },
      { title: 'Aries AI Feature Reveal Thread', platform: 'X / Twitter', time: '14:00', status: 'Published' },
      { title: 'Reddit: Founder AMA Recap', platform: 'Reddit', time: '17:30', status: 'Published' },
      { title: 'Pinterest: Weekly Creative Board', platform: 'Pinterest', time: '20:00', status: 'Published' },
    ],
  },
  {
    day: 'Tue',
    date: '7',
    posts: [
      { title: 'The Power of GEO Optimization', platform: 'Instagram', time: '10:30', status: 'Published' },
      { title: 'Market Intelligence 101 Guide', platform: 'YouTube', time: '16:00', status: 'Published' },
    ],
  },
  {
    day: 'Wed',
    date: '8',
    posts: [
      { title: 'Spring Campaign Case Study', platform: 'LinkedIn', time: '11:00', status: 'Published' },
      { title: 'Facebook Ads Mastery Course', platform: 'Facebook', time: '15:30', status: 'Published' },
      { title: 'Pinterest: Campaign Moodboard', platform: 'Pinterest', time: '18:00', status: 'Published' },
      { title: 'YouTube: Campaign Review Short', platform: 'YouTube', time: '21:00', status: 'Published' },
    ],
  },
  {
    day: 'Thu',
    date: '9',
    posts: [
      { title: 'Why AEO is the new SEO', platform: 'X / Twitter', time: '09:30', status: 'Published' },
      { title: 'Weekly AI Wrap-up Content', platform: 'Instagram', time: '15:00', status: 'Published' },
      { title: 'LinkedIn: Marketing Ops Lessons', platform: 'LinkedIn', time: '18:30', status: 'Published' },
    ],
  },
  {
    day: 'Fri',
    date: '10',
    posts: [
      { title: 'Aries AI v2.0 Launch Event', platform: 'LinkedIn', time: '10:00', status: 'Published' },
      { title: 'Wikipedia: Tech Innovation Notes', platform: 'Wikipedia', time: '22:30', status: 'Published' },
    ],
  },
  {
    day: 'Sat',
    date: '11',
    posts: [
      { title: 'Weekend Founder Story Carousel', platform: 'Instagram', time: '11:00', status: 'Scheduled' },
      { title: 'Reddit: Community Questions', platform: 'Reddit', time: '16:30', status: 'Scheduled' },
    ],
  },
  {
    day: 'Sun',
    date: '12',
    posts: [
      { title: 'Sunday Strategy Newsletter Clip', platform: 'LinkedIn', time: '12:00', status: 'Scheduled' },
      { title: 'Pinterest: Weekly Ideas Board', platform: 'Pinterest', time: '18:15', status: 'Scheduled' },
    ],
  },
  {
    day: 'Mon',
    date: '13',
    posts: [
      { title: 'Next-Gen Automation Primer', platform: 'X / Twitter', time: '09:30', status: 'Scheduled' },
      { title: 'LinkedIn: Founder Workflow Breakdown', platform: 'LinkedIn', time: '12:00', status: 'Scheduled' },
      { title: 'Brand Identity Deep-dive', platform: 'Instagram', time: '15:00', status: 'Scheduled' },
      { title: 'Pinterest: Launch Visual Board', platform: 'Pinterest', time: '18:45', status: 'Scheduled' },
    ],
  },
  {
    day: 'Tue',
    date: '14',
    posts: [
      { title: 'Future of SaaS Marketing', platform: 'LinkedIn', time: '10:00', status: 'Scheduled' },
      { title: 'Reddit: SaaS Growth Checklist', platform: 'Reddit', time: '13:30', status: 'Scheduled' },
      { title: 'YouTube: Workflow Walkthrough', platform: 'YouTube', time: '17:00', status: 'Scheduled' },
    ],
  },
  {
    day: 'Wed',
    date: '15',
    posts: [
      { title: 'Instagram: Client Results Reel', platform: 'Instagram', time: '09:45', status: 'Scheduled' },
      { title: 'Social Media Strategy Session', platform: 'Facebook', time: '13:00', status: 'Scheduled' },
      { title: 'Wikipedia: Marketing Systems Note', platform: 'Wikipedia', time: '16:15', status: 'Scheduled' },
      { title: 'Reddit: Automation Playbook', platform: 'Reddit', time: '19:00', status: 'Scheduled' },
    ],
  },
  {
    day: 'Thu',
    date: '16',
    posts: [
      { title: 'Content Performance Review', platform: 'Instagram', time: '11:30', status: 'Scheduled' },
      { title: 'Facebook: Proof Point Carousel', platform: 'Facebook', time: '15:15', status: 'Scheduled' },
      { title: 'Wikipedia: Brand Glossary Update', platform: 'Wikipedia', time: '20:00', status: 'Scheduled' },
    ],
  },
  {
    day: 'Fri',
    date: '17',
    posts: [
      { title: 'Quarterly Growth Planning', platform: 'LinkedIn', time: '09:00', status: 'Scheduled' },
      { title: 'X Thread: Campaign Lessons', platform: 'X / Twitter', time: '14:30', status: 'Scheduled' },
      { title: 'Pinterest: Strategy Template Pin', platform: 'Pinterest', time: '18:45', status: 'Scheduled' },
    ],
  },
  {
    day: 'Sat',
    date: '18',
    posts: [
      { title: 'Pinterest: Offer Inspiration Board', platform: 'Pinterest', time: '11:15', status: 'Scheduled' },
      { title: 'Facebook: Weekend Promo Reminder', platform: 'Facebook', time: '15:45', status: 'Scheduled' },
    ],
  },
  {
    day: 'Sun',
    date: '19',
    posts: [
      { title: 'YouTube Shorts Weekly Recap', platform: 'YouTube', time: '10:30', status: 'Scheduled' },
      { title: 'Reddit: Customer Story Thread', platform: 'Reddit', time: '18:00', status: 'Scheduled' },
    ],
  },
] as const;

const PLATFORM_CALENDAR_STYLE = {
  LinkedIn: { Icon: Linkedin, border: 'border-blue-600/30', iconClass: 'text-blue-400' },
  YouTube: { Icon: Youtube, border: 'border-red-500/30', iconClass: 'text-red-400' },
  'X / Twitter': { Icon: XTwitterLogo, border: 'border-white/20', iconClass: 'text-white/80' },
  Instagram: { Icon: Instagram, border: 'border-pink-500/30', iconClass: 'text-pink-400' },
  Facebook: { Icon: Facebook, border: 'border-blue-700/30', iconClass: 'text-blue-600' },
  Reddit: { Icon: RedditLogo, border: 'border-orange-500/30', iconClass: 'text-orange-400' },
  Pinterest: { Icon: PinterestLogo, border: 'border-red-600/30', iconClass: 'text-red-500' },
  Wikipedia: { Icon: WikipediaLogo, border: 'border-white/20', iconClass: 'text-white/75' },
} as const;

function platformCalendarMeta(platform: string) {
  if (platform in PLATFORM_CALENDAR_STYLE) {
    return PLATFORM_CALENDAR_STYLE[platform as keyof typeof PLATFORM_CALENDAR_STYLE];
  }
  return {
    Icon: Sparkles,
    border: 'border-primary/20',
    iconClass: 'text-primary',
  };
}

function calendarPlatformIcon(platform: string) {
  const { Icon, iconClass } = platformCalendarMeta(platform);
  return <Icon className={`w-3.5 h-3.5 ${iconClass}`} />;
}

function calendarPlatformBorder(platform: string) {
  return platformCalendarMeta(platform).border;
}

function ContentCalendar() {
  const [activeDate, setActiveDate] = useState('10');
  const [currentWeek, setCurrentWeek] = useState<'current' | 'next'>('current');
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
  const [searchTerm, setSearchTerm] = useState('');
  const [activePlatforms, setActivePlatforms] = useState<string[]>([]);

  const platforms = [
    { name: 'X / Twitter' },
    { name: 'LinkedIn' },
    { name: 'Instagram' },
    { name: 'YouTube' },
    { name: 'Facebook' },
    { name: 'Reddit' },
    { name: 'Pinterest' },
    { name: 'Wikipedia' },
  ];

  const truncateTitle = (title: string, wordCount = 3) => {
    const words = title.split(' ');
    return words.length <= wordCount ? title : `${words.slice(0, wordCount).join(' ')}...`;
  };

  const monthDays = Array.from({ length: 30 }, (_, i) => i + 1);
  const getPostsForDate = (date: string) =>
    CONTENT_CALENDAR_SCHEDULE.find((entry) => entry.date === date)?.posts || [];

  const displayedSchedule = useMemo(() => {
    const weekDates = currentWeek === 'current'
      ? ['6', '7', '8', '9', '10', '11', '12']
      : ['13', '14', '15', '16', '17', '18', '19'];
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return CONTENT_CALENDAR_SCHEDULE
      .filter((item) => weekDates.includes(item.date))
      .map((day) => ({
        ...day,
        posts: day.posts.filter((post) => {
          const matchesSearch = normalizedSearch.length === 0
            || post.title.toLowerCase().includes(normalizedSearch);
          const matchesPlatform = activePlatforms.length === 0
            || activePlatforms.includes(post.platform);
          return matchesSearch && matchesPlatform;
        }),
      }));
  }, [currentWeek, searchTerm, activePlatforms]);

  return (
    <section id="calendar" className="py-24 relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-4xl md:text-[48px] leading-tight font-light mb-6"
          >
            Your <span className="text-gradient">marketing schedule</span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 }}
            className="text-white/60 max-w-2xl mx-auto"
          >
            See what is planned, what is approved, and what is going out this week across your channels.
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          className="glass rounded-[3rem] overflow-hidden border-white/10 shadow-2xl flex flex-col lg:flex-row min-h-[700px]"
        >
          <div className="w-full lg:w-80 border-r border-white/10 bg-white/5 p-8 flex flex-col gap-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-bold">Calendar</span>
              </div>
              <button type="button" className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                <Plus className="w-5 h-5 text-white/50" />
              </button>
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
              <input
                type="text"
                placeholder="Search posts..."
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                className="w-full bg-black/30 border border-white/10 rounded-xl py-2 pl-10 pr-4 text-sm text-white focus:outline-none focus:border-primary/50 transition-colors"
              />
            </div>

            <div className="space-y-6">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-white/30 mb-4">Platforms</h4>
                <div className="space-y-2">
                  {platforms.map((platform) => {
                    const isActive = activePlatforms.includes(platform.name);
                    return (
                      <button
                        key={platform.name}
                        type="button"
                        onClick={() =>
                          setActivePlatforms((current) =>
                            current.includes(platform.name)
                              ? current.filter((name) => name !== platform.name)
                              : [...current, platform.name],
                          )
                        }
                        aria-pressed={isActive}
                        className={cn(
                          'w-full flex items-center justify-between p-3 rounded-xl transition-colors cursor-pointer group text-left',
                          isActive ? 'bg-white/10' : 'hover:bg-white/5',
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={cn(
                              'text-sm font-medium transition-colors',
                              isActive ? 'text-white' : 'text-white/70 group-hover:text-white',
                            )}
                          >
                            {platform.name}
                          </span>
                        </div>
                        <div
                          className={cn(
                            'w-2 h-2 rounded-full transition-all',
                            isActive
                              ? 'bg-primary scale-125 shadow-[0_0_8px_rgba(124,58,237,0.5)]'
                              : 'bg-white/10',
                          )}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-white/30 mb-4">Status</h4>
                <div className="space-y-3 px-2">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]" />
                    <span className="text-sm text-white/60">Published</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.5)]" />
                    <span className="text-sm text-white/60">Scheduled</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 flex flex-col">
            <div className="p-8 border-b border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="flex items-center gap-6">
                <h3 className="text-2xl font-light">April 2026</h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentWeek('current')}
                    className={cn(
                      "p-2 rounded-lg border border-white/10 transition-colors",
                      currentWeek === 'current' ? "bg-white/5 opacity-50 cursor-not-allowed" : "hover:bg-white/5"
                    )}
                    disabled={currentWeek === 'current'}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveDate('10');
                      setCurrentWeek('current');
                    }}
                    className="px-4 py-2 hover:bg-white/5 rounded-lg border border-white/10 text-sm font-medium transition-colors"
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentWeek('next')}
                    className={cn(
                      "p-2 rounded-lg border border-white/10 transition-colors",
                      currentWeek === 'next' ? "bg-white/5 opacity-50 cursor-not-allowed" : "hover:bg-white/5"
                    )}
                    disabled={currentWeek === 'next'}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="bg-white/5 p-1 rounded-xl border border-white/10 flex">
                  <button
                    type="button"
                    onClick={() => setViewMode('week')}
                    className={cn(
                      'px-4 py-2 rounded-lg text-sm font-bold transition-all',
                      viewMode === 'week' ? 'bg-primary/20 text-primary' : 'hover:bg-white/5 text-white/50',
                    )}
                  >
                    Week
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('month')}
                    className={cn(
                      'px-4 py-2 rounded-lg text-sm font-bold transition-all',
                      viewMode === 'month' ? 'bg-primary/20 text-primary' : 'hover:bg-white/5 text-white/50',
                    )}
                  >
                    Month
                  </button>
                </div>
                <a href="/calendar" className="px-6 py-2 bg-gradient-to-r from-primary to-secondary rounded-xl text-sm font-bold shadow-lg shadow-primary/20">
                  Open Runtime
                </a>
                <a href="/login" className="px-6 py-2 bg-gradient-to-r from-primary to-secondary rounded-xl text-sm font-bold shadow-lg shadow-primary/20">
                  New Post
                </a>
              </div>
            </div>

            <div className="flex-1 p-8 overflow-x-auto">
              {viewMode === 'week' ? (
                <div className="min-w-[800px] grid grid-cols-7 gap-6 h-full">
                  {displayedSchedule.map((day, dayIndex) => (
                    <div key={day.day} className="flex flex-col gap-6">
                      <div className="text-center">
                        <span className="block text-xs font-bold uppercase tracking-widest text-white/30 mb-2">{day.day}</span>
                        <button
                          type="button"
                          onClick={() => setActiveDate(day.date)}
                          className={cn(
                            'inline-flex items-center justify-center w-10 h-10 rounded-full text-lg font-bold transition-all',
                            activeDate === day.date
                              ? 'bg-primary text-white scale-110 shadow-lg shadow-primary/30'
                              : 'text-white/70 hover:bg-white/10',
                          )}
                        >
                          {day.date}
                        </button>
                      </div>

                      <div className="flex-1 space-y-2">
                        {day.posts.map((post, postIndex) => (
                          <motion.div
                            key={`${post.title}-${post.time}`}
                            initial={{ opacity: 0, y: 10 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            transition={{ delay: dayIndex * 0.1 + postIndex * 0.1 }}
                            className={cn(
                              'p-2 border bg-white/5 backdrop-blur-sm relative group cursor-pointer hover:bg-white/10 transition-all',
                              calendarPlatformBorder(post.platform),
                            )}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[8px] font-bold uppercase tracking-tighter opacity-40">{post.time}</span>
                              <MoreHorizontal className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                            <h5 className="text-[10px] font-light mb-1.5 leading-tight">{truncateTitle(post.title, 3)}</h5>
                            <div className="flex items-center justify-between gap-1.5 pt-0.5">
                              {calendarPlatformIcon(post.platform)}
                              <span
                                className={cn(
                                  'text-[5.5px] font-bold uppercase tracking-widest px-1 py-0.5 rounded-sm border',
                                  post.status === 'Published'
                                    ? 'border-green-400 text-white'
                                    : 'border-yellow-400 text-white',
                                )}
                              >
                                {post.status}
                              </span>
                            </div>
                          </motion.div>
                        ))}

                        <div className="h-12 border border-dashed border-white/5 flex items-center justify-center group hover:border-white/20 transition-colors cursor-pointer">
                          <Plus className="w-3 h-3 text-white/10 group-hover:text-white/30 transition-colors" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-7 gap-2">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                    <div key={day} className="text-center text-[10px] font-bold uppercase tracking-widest text-white/20 py-2">
                      {day}
                    </div>
                  ))}
                  {monthDays.map((day) => {
                    const posts = getPostsForDate(String(day));
                    return (
                      <div
                        key={day}
                        className={cn(
                          'h-28 border p-1.5 transition-all cursor-pointer group flex flex-col gap-1',
                          String(day) === activeDate ? 'bg-primary/10 border-primary/50' : 'bg-white/5 border-white/5 hover:border-white/20',
                        )}
                        onClick={() => setActiveDate(String(day))}
                      >
                        <span className={cn('text-[10px] font-bold mb-1', String(day) === activeDate ? 'text-primary' : 'text-white/40')}>
                          {day}
                        </span>
                        <div className="flex-1 space-y-1 overflow-hidden">
                          {posts.map((post) => (
                            <div key={post.title} className={cn('p-1 border text-[7px] font-light leading-none truncate', calendarPlatformBorder(post.platform))}>
                              {truncateTitle(post.title, 2)}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function EarlyAccessSignup() {
  return (
    <section id="early-access" className="relative overflow-hidden border-y border-white/10 bg-black/35 py-24">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:64px_64px] opacity-35" />
      <div className="absolute right-0 top-0 h-96 w-1/2 bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.25),transparent_58%)]" />
      <div className="w-full">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="relative w-full overflow-hidden"
        >
          <div className="container relative z-10 mx-auto grid gap-10 px-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
            <EarlyAccessCopy />
            <EarlyAccessForm
              source="marketing-homepage"
              emailInputId="early-access-email"
              className="flex min-h-[390px] flex-col justify-center rounded-[2rem] border border-white/10 bg-black/25 p-5 shadow-2xl shadow-black/20"
            />
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function Pricing() {
  const plans = [
    {
      name: 'Starter',
      price: '49',
      description: 'For one business with a few active channels.',
      features: ['3 Connected Channels', 'Campaign Planning', 'Approval Queue', 'Weekly Results'],
      highlight: false,
    },
    {
      name: 'Growth',
      price: '149',
      description: 'For businesses ready to run consistent campaigns.',
      features: ['Unlimited Channels', 'Full Campaign Workspace', 'Detailed Results', 'Next-Step Recommendations', 'Priority Support'],
      highlight: true,
    },
    {
      name: 'Enterprise',
      price: 'Custom',
      description: 'For multi-location or high-volume businesses.',
      features: ['Multiple Brands', 'Dedicated Support', 'Custom Reporting', 'Team Approvals', 'SLA Guarantee'],
      highlight: false,
    },
  ];

  return (
    <section id="pricing" className="py-24 relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-[48px] leading-tight font-bold mb-6">Simple, Transparent Pricing</h2>
          <p className="text-white/60">Choose the plan that fits your growth stage.</p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {plans.map((plan, index) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1 }}
              className={cn('relative flex flex-col', plan.highlight ? 'scale-105 z-10' : '')}
            >
              <div className={cn('glass p-10 rounded-[3rem] h-full flex flex-col', plan.highlight ? 'border-primary/50 glow-purple' : 'border-white/5')}>
                <div className="mb-8">
                  <h3 className="text-2xl font-bold mb-2">{plan.name}</h3>
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold">{plan.price === 'Custom' ? '' : '$'}{plan.price}</span>
                    {plan.price !== 'Custom' ? <span className="text-white/50">/mo</span> : null}
                  </div>
                  <p className="text-white/50 text-sm mt-4">{plan.description}</p>
                </div>

                <div className="space-y-4 mb-10 flex-1">
                  {plan.features.map((feature) => (
                    <div key={feature} className="flex items-center gap-3">
                      <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center">
                        <Check className="w-3 h-3 text-primary" />
                      </div>
                      <span className="text-sm text-white/80">{feature}</span>
                    </div>
                  ))}
                </div>

                <a
                  href={plan.price === 'Custom' ? '/onboarding/start' : '/onboarding/start'}
                  className={cn(
                    'w-full py-4 rounded-2xl font-bold transition-all text-center',
                    plan.highlight
                      ? 'bg-gradient-to-r from-primary to-secondary text-white shadow-lg shadow-primary/20'
                      : 'bg-white/10 hover:bg-white/20 text-white',
                  )}
                >
                  {plan.price === 'Custom' ? 'Contact us' : 'Get started'}
                </a>
              </div>

              {plan.highlight ? (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-primary px-4 py-1 rounded-full text-xs font-bold uppercase tracking-wider z-20">
                  Most Popular
                </div>
              ) : null}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureShowcaseFallback() {
  const panels = [
    {
      title: 'Campaign clarity',
      description: 'Aries keeps your plan, creative, schedule, and results in one place so you never lose track of what is running or what needs attention.',
      icon: <Zap className="w-5 h-5 text-primary" />,
    },
    {
      title: 'Approval confidence',
      description: 'Every launch stays reviewable. You move from plan to review to schedule without worrying that something shipped without sign-off.',
      icon: <Layers className="w-5 h-5 text-secondary" />,
    },
    {
      title: 'Results you can act on',
      description: 'Every campaign summary ends with a clear next step instead of a wall of charts, so you always know what to do next.',
      icon: <BarChart3 className="w-5 h-5 text-primary" />,
    },
  ];

  return (
    <section className="py-24 relative overflow-hidden bg-black">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-[48px] leading-tight font-bold mb-6">
            Built for <span className="text-gradient">business owners</span>
          </h2>
          <p className="text-white/60 max-w-3xl mx-auto text-lg">
            Aries keeps the complex work behind the scenes so you can focus on the decisions that matter for your business.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {panels.map((panel) => (
            <div
              key={panel.title}
              className="glass rounded-[2.5rem] border border-white/10 p-8 text-left"
            >
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5">
                {panel.icon}
              </div>
              <h3 className="mb-3 text-2xl font-bold">{panel.title}</h3>
              <p className="text-sm leading-relaxed text-white/60">{panel.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  // Spline is a WebGL embed that can stall the GPU on low-end hardware (and in
  // demo environments like LinkedIn Live). Defer the iframe until the section
  // is actually in the viewport, and gate it behind `requestIdleCallback` so it
  // never competes with the initial paint of the page.
  const splineContainerRef = useRef<HTMLDivElement | null>(null);
  const [mountSpline, setMountSpline] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const node = splineContainerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setMountSpline(true);
      return;
    }

    const idle = (cb: () => void) => {
      const ric = (window as typeof window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      }).requestIdleCallback;
      if (typeof ric === 'function') {
        ric(cb, { timeout: 1500 });
      } else {
        window.setTimeout(cb, 200);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            idle(() => setMountSpline(true));
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <section className="py-24 relative overflow-hidden">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          className="relative bg-white/5 backdrop-blur-xl border border-white/10 rounded-[4rem] overflow-hidden h-[500px] md:h-[700px] w-full"
        >
          {/* Background Glow */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full bg-white/5 blur-[120px] -z-10 pointer-events-none" />

          {/* Content Overlay */}
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center md:items-end md:justify-end p-8 md:p-12 md:pr-10 lg:pr-21 lg:pb-24 pointer-events-none">
            <div className="flex justify-center md:justify-end w-full pointer-events-auto">
              {/* Action Buttons */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                className="flex flex-wrap items-center gap-4"
              >
                <a
                  href="/onboarding/start"
                  className="px-8 py-4 rounded-full border border-white/20 hover:border-white/40 text-white font-bold transition-all backdrop-blur-md text-sm"
                >
                  Start with your business
                </a>
                <a
                  href="/#how-it-works"
                  className="px-8 py-4 rounded-full border border-white/20 hover:border-white/40 text-white font-bold transition-all backdrop-blur-md text-sm"
                >
                  See how it works
                </a>
              </motion.div>
            </div>
          </div>

          {/* Spline 3D Integration (deferred until in view to avoid WebGL GPU stalls) */}
          <div ref={splineContainerRef} className="w-full h-full relative z-10 overflow-hidden">
            {mountSpline ? (
              <iframe
                src="https://my.spline.design/boxeshover-1S9fbn10HLJkYTmxyOt88Ycb/"
                frameBorder="0"
                width="100%"
                height="100%"
                loading="lazy"
                className="absolute -top-[50px] left-0 w-full md:w-[calc(100%+100px)] lg:w-[calc(100%+200px)] h-[calc(100%+100px)] max-w-none"
                title="Interactive 3D Boxes"
                sandbox="allow-scripts allow-same-origin"
              ></iframe>
            ) : (
              <div
                aria-hidden="true"
                className="absolute -top-[50px] left-0 w-full md:w-[calc(100%+100px)] lg:w-[calc(100%+200px)] h-[calc(100%+100px)] max-w-none bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.35),transparent_58%)]"
              />
            )}
          </div>
        </motion.div>
      </div>
    </section>
  );
}

export default function DonorHomePage() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 100,
    damping: 30,
    restDelta: 0.001,
  });

  return (
    <DonorMarketingShell heroMode>
      <motion.div
        className="fixed top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary to-secondary z-[100] origin-left"
        style={{ scaleX }}
      />

      <Hero />

      <section className="py-16 border-y border-white/5 bg-black/50">
        <div className="container mx-auto px-6 text-center max-w-2xl">
          <blockquote className="text-lg text-white/80 italic leading-relaxed">
            "Aries helped me go from idea to approved campaign in 2 hours."
          </blockquote>
          <p className="mt-4 text-sm text-white/40 font-medium uppercase tracking-wider">
            Early access user
          </p>
        </div>
      </section>

      <Problem />

      <section id="meet-aries" className="py-24 relative">
        <div className="container mx-auto px-6 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="max-w-7xl mx-auto"
          >
            <div className="max-w-4xl mx-auto">
              <h2 className="text-4xl md:text-[48px] leading-tight font-bold mb-8">Meet Aries</h2>
              <p className="text-xl text-white/60 mb-12 leading-relaxed">
                A calm workspace where you plan campaigns, approve creative, launch safely, and see what delivered results &mdash; without learning marketing software.
              </p>
            </div>

            <div
              aria-label="Meet Aries workflow steps"
              className="mx-auto flex flex-wrap items-center justify-center gap-4 pb-4 lg:grid lg:w-fit lg:grid-cols-[12rem_1.25rem_12rem_1.25rem_12rem_1.25rem_12rem_1.25rem_12rem] lg:gap-3 xl:grid-cols-[13rem_2rem_13rem_2rem_13rem_2rem_13rem_2rem_13rem]"
              role="list"
            >
              {['Set up your business', 'See the plan', 'Review the creative', 'Launch safely', 'See what delivered results'].map((step, index) => (
                <Fragment key={step}>
                  <span
                    className="glass inline-flex w-full items-center justify-center rounded-full border-primary/20 px-8 py-4 text-center text-sm font-semibold whitespace-nowrap lg:px-4"
                    role="listitem"
                  >
                    <span className="relative z-10 block w-full text-center">{step}</span>
                  </span>
                  {index < 4 ? <div aria-hidden="true" role="presentation" className="hidden h-px w-full bg-white/20 lg:block" /> : null}
                </Fragment>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      <Features />
      <HowItWorks />
      <FeatureShowcaseFallback />
      <EarlyAccessSignup />
      <FinalCTA />
    </DonorMarketingShell>
  );
}
