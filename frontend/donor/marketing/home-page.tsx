'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Facebook,
  Github,
  Instagram,
  Layers,
  Lightbulb,
  Linkedin,
  MessageCircle,
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


const XIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932 6.064-6.932zm-1.294 19.497h2.039L6.482 2.39H4.294l13.313 18.26z" />
  </svg>
);

const PinterestIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.965 1.406-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.026 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.131 0 3.768-2.248 3.768-5.487 0-2.868-2.062-4.878-5.008-4.878-3.41 0-5.413 2.561-5.413 5.2 0 1.033.394 2.137.886 2.738.097.118.11.222.081.332-.089.373-.288 1.171-.328 1.334-.051.213-.173.258-.396.155-1.474-.686-2.392-2.844-2.392-4.577 0-3.725 2.706-7.147 7.807-7.147 4.097 0 7.283 2.92 7.283 6.821 0 4.072-2.568 7.348-6.136 7.348-1.2 0-2.327-.622-2.713-1.359 0 0-.594 2.258-.738 2.816-.269 1.037-1 2.337-1.488 3.132 1.12.339 2.298.536 3.526.536 6.621 0 11.983-5.367 11.983-11.987S18.638 0 12.017 0z" />
  </svg>
);

const RedditIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.056 1.597.04.21.06.427.06.646 0 2.834-3.334 5.141-7.447 5.141-4.113 0-7.447-2.307-7.447-5.141 0-.219.02-.436.06-.646a1.754 1.754 0 0 1-1.056-1.597c0-.968.786-1.754 1.754-1.754.478 0 .9.182 1.208.491 1.194-.856 2.85-1.419 4.674-1.488l.82-3.847a.125.125 0 0 1 .15-.097l2.907.612c.24-.265.589-.427.97-.427zM8.17 11.23a1.102 1.102 0 0 0-1.101 1.101 1.102 1.102 0 0 0 1.101 1.101 1.102 1.102 0 0 0 1.101-1.101 1.102 1.102 0 0 0-1.101-1.101zm7.658 0a1.102 1.102 0 0 0-1.101 1.101 1.102 1.102 0 0 0 1.101 1.101 1.102 1.102 0 0 0 1.101-1.101 1.102 1.102 0 0 0-1.101-1.101zm-5.462 4.414c-.04 0-.08.01-.12.016-1.096.11-2.03.46-2.031.864 0 .041.01.08.03.116l-.012.012c.11.28.69.51 1.43.64.33.06.7.09 1.11.09s.78-.03 1.11-.09c.74-.13 1.32-.36 1.43-.64l-.01-.01c.02-.04.03-.08.03-.12 0-.404-.93-.75-2-.86a1.104 1.104 0 0 0-.12-.016z" />
  </svg>
);


const WikipediaIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M16.924 8.536h-4.884v1.127h.955l-3.3 9.673h-.04l-2.731-8.52h1.666V8.536H3.84v1.127h1.011l4.496 12.838h1.107l2.844-8.75 3.018 8.75h1.109l4.588-12.838h1.096V8.536h-4.664v1.127h.955l-3.3 9.673h-.04l-2.731-8.52z" />
  </svg>
);

const QuoraIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M7.3799.9483A11.9628 11.9628 0 0 1 21.248 19.5397l2.4096 2.4225c.7322.7362.21 1.9905-.8272 1.9905l-10.7105.01a12.52 12.52 0 0 1-.304 0h-.02A11.9628 11.9628 0 0 1 7.3818.9503Zm7.3217 4.428a7.1717 7.1717 0 1 0-5.4873 13.2512 7.1717 7.1717 0 0 0 5.4883-13.2511Z"/>
  </svg>
);


import { motion, useScroll, useSpring, useTransform, type MotionValue } from 'motion/react';

import { cn } from '../lib/utils';
import { AriesMark } from '../ui';
import { DonorMarketingShell } from './chrome';

const FeatureShowcase3D = dynamic(() => import('./feature-showcase-3d'), {
  ssr: false,
  loading: () => (
    <section className="py-24 relative overflow-hidden bg-[#030014]">
      <div className="container mx-auto px-6">
        <div className="glass rounded-[2.5rem] p-10 text-center text-white/60">
          Loading interactive showcase…
        </div>
      </div>
    </section>
  ),
});

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
  icon: (props: { className?: string }) => React.ReactNode;
  angle: number;
  radius: number;
};

const PLATFORM_ORBITS: PlatformOrbit[] = [
  // Orbit 1: Radius 180 (2 platforms)
  { icon: XIcon, angle: 0, radius: 180 },
  { icon: WikipediaIcon, angle: 200, radius: 180 },
  
  // Orbit 2: Radius 300 (3 platforms)
  { icon: Linkedin, angle: 40, radius: 300 },
  { icon: Instagram, angle: 120, radius: 300 },
  { icon: RedditIcon, angle: 280, radius: 300 },
  
  // Orbit 3: Radius 420 (4 platforms)
  { icon: Youtube, angle: 80, radius: 420 },
  { icon: Facebook, angle: 160, radius: 420 },
  { icon: PinterestIcon, angle: 240, radius: 420 },
  { icon: QuoraIcon, angle: 320, radius: 420 },
];


function OrbitLine({
  angle,
  radius,
  rotation,
  progress,
  index,
}: {
  angle: number;
  radius: number;
  rotation: MotionValue<number>;
  progress: MotionValue<number>;
  index: number;
}) {
  const startRadius = 25;
  const lineTargetRadius = Math.max(startRadius, radius - 40);
  const lineStart = 0.3 + index * 0.015;
  const lineEnd = 0.35 + index * 0.015;
  const lineCurrentRadius = useTransform(progress, [lineStart, lineEnd, 0.5, 0.6], [startRadius, lineTargetRadius, lineTargetRadius, startRadius]);
  const lineOpacity = useTransform(progress, [lineStart, lineStart + 0.01, 0.5, 0.6], [0, 0.8, 0.8, 0]);

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
}: {
  platform: PlatformOrbit;
  rotation: MotionValue<number>;
  progress: MotionValue<number>;
  index: number;
}) {
  const platformRadius = useTransform(progress, [0, 0.05, 0.15, 0.5, 0.6], [0, 0, platform.radius, platform.radius, 0]);
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
      <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 backdrop-blur-md flex items-center justify-center shadow-2xl shadow-white/5 relative z-10">
        <Icon className="w-10 h-10 text-white" />
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
  const [hostname, setHostname] = useState('aries-ai.io');
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
    setHostname(window.location.hostname || 'aries-ai.io');
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

  const logoX = useTransform(smoothProgress, [0, 0.15, 0.3, 0.5, 0.95, 1], [startX, startX, 0, 0, startX, startX]);
  const logoY = useTransform(smoothProgress, [0, 0.15, 0.3, 0.5, 0.95, 1], [startY, startY, 0, 0, startY, startY]);
  const logoScale = useTransform(smoothProgress, [0, 0.15, 0.3, 0.5, 0.95, 1], [1, 1, 1.5625, 1.5625, 1, 1]);
  const logoOpacity = useTransform(smoothProgress, [0, 0.95, 1], [1, 1, 0]);
  const centralCircleOpacity = useTransform(smoothProgress, [0, 0.05, 0.15, 0.5, 0.6], [0, 0, 1, 1, 0]);
  const centralCircleScale = useTransform(smoothProgress, [0, 0.05, 0.15, 0.5, 0.6], [0.5, 0.5, 1, 1, 0.5]);
  const platformsOpacity = useTransform(smoothProgress, [0, 0.05, 0.15, 0.5, 0.6], [0, 0, 1, 1, 0]);
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

        <div className="container mx-auto px-6 relative z-20 text-center pt-0">
          <motion.div style={{ opacity: useTransform(smoothProgress, [0, 0.05], [1, 0]) }} className="mb-8">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass-reflection relative">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-white/80">Next-Gen Marketing Intelligence</span>
            </div>
          </motion.div>

          <motion.h1
            style={{
              opacity: useTransform(smoothProgress, [0, 0.05], [1, 0]),
              y: useTransform(smoothProgress, [0, 0.05], [0, -20]),
            }}
            className="text-[64px] font-bold tracking-tight mb-8 leading-[1.05]"
          >
            Turn Your Marketing Into an <br />
            <span className="text-gradient">Autonomous Growth Engine</span>
          </motion.h1>

          <motion.p
            style={{
              opacity: useTransform(smoothProgress, [0, 0.05], [1, 0]),
              y: useTransform(smoothProgress, [0, 0.05], [0, -20]),
            }}
            className="max-w-2xl mx-auto text-[1rem] text-white/60 mb-12"
          >
            Aries AI analyzes markets, generates content, and automatically publishes across all social media platforms. Experience the future of marketing execution.
          </motion.p>

          <motion.div
            style={{
              opacity: useTransform(smoothProgress, [0, 0.05], [1, 0]),
              y: useTransform(smoothProgress, [0, 0.05], [0, -20]),
            }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4"
          >
            <Link
              href="/login"
              className="w-full sm:w-auto px-8 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 hover:scale-105 transition-transform flex items-center justify-center gap-2"
            >
              Start Automating <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              href="/documentation"
              className="w-full sm:w-auto px-8 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2"
            >
              <Play className="w-5 h-5 fill-current" /> See Runtime
            </Link>
          </motion.div>

          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <motion.div style={{ opacity: platformsOpacity }} className="absolute inset-0 flex items-center justify-center">
              {[180, 300, 420].map((radius) => (
                <div key={radius} className="absolute rounded-full border border-white/5" style={{ width: radius * 2, height: radius * 2 }} />
              ))}
            </motion.div>

            <motion.div
              style={{ opacity: centralCircleOpacity, scale: centralCircleScale }}
              className="w-40 h-40 rounded-full border border-white/10 bg-white/5 backdrop-blur-sm flex items-center justify-center"
            >
              <div className="w-28 h-28 rounded-full border border-primary/20 animate-pulse" />
            </motion.div>

            <svg
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none overflow-visible"
              width="1000"
              height="1000"
              viewBox="-500 -500 1000 1000"
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
              {isMounted && PLATFORM_ORBITS.map((platform, index) => (
                <OrbitLine
                  key={`${platform.angle}-${platform.radius}`}
                  angle={platform.angle}
                  radius={platform.radius}
                  rotation={platformsRotate}
                  progress={smoothProgress}
                  index={index}
                />
              ))}
            </svg>

            <motion.div style={{ opacity: platformsOpacity }} className="absolute w-full h-full flex items-center justify-center">
              {PLATFORM_ORBITS.map((platform, index) => (
                <OrbitPlatform
                  key={`${platform.angle}-${platform.radius}`}
                  platform={platform}
                  rotation={platformsRotate}
                  progress={smoothProgress}
                  index={index}
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
                marginTop: '-40px',
                marginLeft: '-40px',
              }}
              className="z-[60]"
            >
              <div className="relative">
                <AriesMark sizeClassName="w-20 h-20" />
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
              <span className="font-bold text-white">Analytics</span>
            </div>
            <p className="text-sm font-medium text-white/50 tracking-tight">+24% Growth this week</p>
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
                <span className="font-bold text-white">Auto-Post</span>
              </div>
              <p className="text-sm font-medium text-white/50 tracking-tight">X, LinkedIn, Insta, etc.</p>
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
      title: 'Inconsistent Lead Flow',
      description: 'Manual marketing efforts lead to unpredictable results and missed opportunities.',
    },
    {
      icon: <AlertCircle className="w-6 h-6 text-orange-400" />,
      title: 'Wasted Marketing Budgets',
      description: "Spending money on campaigns that don't convert due to lack of real-time intelligence.",
    },
    {
      icon: <Clock className="w-6 h-6 text-yellow-400" />,
      title: 'Slow Campaign Execution',
      description: 'Taking weeks to go from idea to launch while competitors move at lightning speed.',
    },
    {
      icon: <Layers className="w-6 h-6 text-blue-400" />,
      title: 'Tool Overload',
      description: 'Managing 10+ disconnected tools just to keep your social media active.',
    },
  ];

  return (
    <section id="product" className="py-24 relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-4xl md:text-5xl font-bold mb-6"
          >
            Marketing Today Is <span className="text-red-400">Fragmented</span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 }}
            className="text-white/60 max-w-2xl mx-auto"
          >
            Traditional marketing teams are overwhelmed by data and manual tasks. Aries AI solves the complexity of modern growth.
          </motion.p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {problems.map((problem, index) => (
            <motion.div
              key={problem.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1 }}
              className="glass p-8 rounded-3xl border border-white/5 hover:border-white/20 transition-all group"
            >
              <div className="mb-6 p-3 bg-white/5 rounded-2xl w-fit group-hover:scale-110 transition-transform">
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
      title: 'AI Social Media Automation',
      description: 'Automatically creates and publishes posts across LinkedIn, X, Instagram, and more.',
      color: 'from-blue-500/20 to-blue-600/20',
    },
    {
      icon: <Search className="w-6 h-6" />,
      title: 'Market Intelligence Engine',
      description: 'Analyzes competitors, trends, and audience signals to find growth opportunities.',
      color: 'from-purple-500/20 to-purple-600/20',
    },
    {
      icon: <PenTool className="w-6 h-6" />,
      title: 'AI Content Generation',
      description: 'Creates high-performing marketing content tailored to your brand voice.',
      color: 'from-pink-500/20 to-pink-600/20',
    },
    {
      icon: <Zap className="w-6 h-6" />,
      title: 'Campaign Automation',
      description: 'Deploys multi-channel campaigns across platforms with zero manual effort.',
      color: 'from-yellow-500/20 to-yellow-600/20',
    },
    {
      icon: <BarChart3 className="w-6 h-6" />,
      title: 'Performance Analytics',
      description: "Real-time insights into what's working and where to double down.",
      color: 'from-green-500/20 to-green-600/20',
    },
    {
      icon: <RefreshCw className="w-6 h-6" />,
      title: 'Continuous Optimization',
      description: 'AI continuously learns from performance data to improve results over time.',
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
            Features for <br />
            <span className="text-gradient">Hyper-Growth</span>
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
      title: 'Market Intelligence',
      description: 'AI gathers competitor and industry data to understand your landscape.',
    },
    {
      icon: <Lightbulb className="w-6 h-6 text-secondary" />,
      title: 'Strategy',
      description: 'AI identifies growth opportunities and creates a custom execution plan.',
    },
    {
      icon: <Zap className="w-6 h-6 text-yellow-400" />,
      title: 'Execution',
      description: 'AI generates and publishes high-performing content across all channels.',
    },
    {
      icon: <BarChart3 className="w-6 h-6 text-green-400" />,
      title: 'Optimization',
      description: 'AI continuously improves results based on real-time performance data.',
    },
  ];

  return (
    <section id="how-it-works" className="py-24 relative">
      <div className="container mx-auto px-6">
        <div className="text-center mb-20">
          <h2 className="text-4xl md:text-[48px] leading-tight font-bold mb-6">How It Works</h2>
          <p className="text-white/60">Four steps to autonomous growth.</p>
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

function ContentCalendar() {
  const [activeDate, setActiveDate] = useState('25');
  const [currentWeek, setCurrentWeek] = useState<'current' | 'next'>('current');
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
  const [searchTerm, setSearchTerm] = useState('');
  const [activePlatforms, setActivePlatforms] = useState<string[]>([]);

  const platforms = [
    { name: 'X' },
    { name: 'LinkedIn' },
    { name: 'Instagram' },
    { name: 'YouTube' },
    { name: 'Facebook' },
    { name: 'Reddit' },
    { name: 'Pinterest' },
    { name: 'Wikipedia' },
    { name: 'Quora' },
  ];


  const getPlatformIcon = (platform: string) => {
    switch (platform) {
      case 'LinkedIn':
        return <Linkedin className="w-3.5 h-3.5 text-blue-400" />;
      case 'YouTube':
        return <Youtube className="w-3.5 h-3.5 text-red-400" />;
      case 'X':
        return <XIcon className="w-3.5 h-3.5 text-white" />;

      case 'Instagram':
        return <Instagram className="w-3.5 h-3.5 text-pink-400" />;
      case 'Facebook':
        return <Facebook className="w-3.5 h-3.5 text-blue-600" />;
      case 'Reddit':
        return <RedditIcon className="w-3.5 h-3.5 text-orange-500" />;
      case 'Pinterest':
        return <PinterestIcon className="w-3.5 h-3.5 text-red-600" />;
      case 'Wikipedia':
        return <WikipediaIcon className="w-3.5 h-3.5 text-gray-300" />;
      case 'Quora':
        return <QuoraIcon className="w-3.5 h-3.5 text-red-700" />;
      default:
        return <Sparkles className="w-3.5 h-3.5 text-primary" />;
    }
  };



  const getPlatformBorder = (platform: string) => {
    switch (platform) {
      case 'LinkedIn':
        return 'border-blue-600/30';
      case 'YouTube':
        return 'border-red-500/30';
      case 'X':
        return 'border-white/20';

      case 'Instagram':
        return 'border-pink-500/30';
      case 'Facebook':
        return 'border-blue-700/30';
      case 'Reddit':
        return 'border-orange-500/30';
      case 'Pinterest':
        return 'border-red-600/30';
      case 'Wikipedia':
        return 'border-gray-500/30';
      case 'Quora':
        return 'border-red-700/30';
      default:
        return 'border-primary/20';
    }
  };


  const truncateTitle = (title: string, wordCount = 3) => {
    const words = title.split(' ');
    return words.length <= wordCount ? title : `${words.slice(0, wordCount).join(' ')}...`;
  };

  const schedule = [
    {
      day: 'Mon',
      date: '23',
      posts: [
        { title: 'Enterprise AI Strategy Playbook', platform: 'LinkedIn', time: '09:00', status: 'Published', category: 'Strategy' },
        { title: 'Next-Gen Automation Primer', platform: 'X', time: '09:30', status: 'Published', category: 'Education' },
        { title: 'Brand Identity Deep-dive', platform: 'Instagram', time: '15:00', status: 'Published', category: 'Strategy' },
        { title: 'Market Intelligence Insights', platform: 'Quora', time: '18:00', status: 'Published', category: 'Education' },
      ],
    },
    {
      day: 'Tue',
      date: '24',
      posts: [
        { title: 'Future of SaaS Marketing', platform: 'LinkedIn', time: '10:00', status: 'Published', category: 'Strategy' },
        { title: 'B2B Lead Gen Analysis', platform: 'LinkedIn', time: '14:30', status: 'Published', category: 'Performance' },
        { title: 'Community Building 101', platform: 'Reddit', time: '19:00', status: 'Published', category: 'Community' },
      ],
    },
    {
      day: 'Wed',
      date: '25',
      posts: [
        { title: 'Data-Driven CMO Insights', platform: 'LinkedIn', time: '09:30', status: 'Published', category: 'Performance' },
        { title: 'Social Media Strategy Session', platform: 'Facebook', time: '13:00', status: 'Published', category: 'Strategy' },
        { title: 'Aries AI v2.1 Update Pre-launch', platform: 'X', time: '16:45', status: 'Published', category: 'Social' },
      ],
    },
    {
      day: 'Thu',
      date: '26',
      posts: [
        { title: 'LinkedIn Ads Optimization', platform: 'LinkedIn', time: '10:45', status: 'Scheduled', category: 'Performance' },
        { title: 'Content Performance Review', platform: 'Instagram', time: '11:30', status: 'Scheduled', category: 'Performance' },
        { title: 'YouTube: Scaling with AI Video', platform: 'YouTube', time: '15:15', status: 'Scheduled', category: 'Education' },
        { title: 'Quora: AI in 2026 Predictions', platform: 'Quora', time: '20:00', status: 'Scheduled', category: 'Education' },
        { title: 'Wikipedia: Tech Innovation Board', platform: 'Wikipedia', time: '22:30', status: 'Scheduled', category: 'Social' },
      ],
    },
    {
      day: 'Fri',
      date: '27',
      posts: [
        { title: 'Quarterly Growth Planning', platform: 'LinkedIn', time: '09:00', status: 'Scheduled', category: 'Strategy' },
        { title: 'Wikipedia: Project Aries Entry', platform: 'Wikipedia', time: '14:00', status: 'Scheduled', category: 'Social' },
        { title: 'Friday Innovation Recap', platform: 'Instagram', time: '17:30', status: 'Scheduled', category: 'Social' },
      ],
    },
    {
      day: 'Sat',
      date: '28',
      posts: [
        { title: 'AI Automation Workshop', platform: 'YouTube', time: '10:00', status: 'Scheduled', category: 'Education' },
        { title: 'Global SaaS Community Update', platform: 'LinkedIn', time: '11:30', status: 'Scheduled', category: 'Community' },
        { title: 'Pinterest: Board Cleanup', platform: 'Pinterest', time: '15:00', status: 'Scheduled', category: 'Strategy' },
      ],
    },
    {
      day: 'Sun',
      date: '29',
      posts: [
        { title: 'Future Tech Predictions', platform: 'X', time: '14:30', status: 'Scheduled', category: 'Strategy' },
        { title: 'Weekly Review Live Session', platform: 'YouTube', time: '21:00', status: 'Scheduled', category: 'Social' },
      ],
    },
    {
      day: 'Mon',
      date: '30',
      posts: [
        { title: 'April Marketing Blueprint', platform: 'LinkedIn', time: '09:00', status: 'Scheduled', category: 'Strategy' },
        { title: 'Q2 Growth Initiatives', platform: 'X', time: '11:00', status: 'Scheduled', category: 'Strategy' },
      ],
    },
    {
      day: 'Tue',
      date: '31',
      posts: [
        { title: 'March Performance Retrospective', platform: 'LinkedIn', time: '10:00', status: 'Scheduled', category: 'Performance' },
        { title: 'Closing the Output Gap', platform: 'Instagram', time: '14:00', status: 'Scheduled', category: 'Social' },
      ],
    },
    {
      day: 'Wed',
      date: '01',
      posts: [
        { title: 'April Fools: The Future of Manual Work', platform: 'X', time: '08:00', status: 'Scheduled', category: 'Social' },
        { title: 'New Platform Integration: Pinterest', platform: 'Pinterest', time: '12:00', status: 'Scheduled', category: 'Social' },
      ],
    },
    {
      day: 'Thu',
      date: '02',
      posts: [
        { title: 'Scaling Social Presence with AI', platform: 'LinkedIn', time: '09:45', status: 'Scheduled', category: 'Performance' },
      ],
    },
    {
      day: 'Fri',
      date: '03',
      posts: [
        { title: 'Community Q&A Roundup', platform: 'Reddit', time: '16:00', status: 'Scheduled', category: 'Community' },
        { title: 'Weekend Strategy Planning', platform: 'LinkedIn', time: '17:30', status: 'Scheduled', category: 'Strategy' },
      ],
    },
    {
      day: 'Sat',
      date: '04',
      posts: [
        { title: 'The Art of AI Content Creation', platform: 'YouTube', time: '11:00', status: 'Scheduled', category: 'Education' },
      ],
    },
    {
      day: 'Sun',
      date: '05',
      posts: [
        { title: 'Weekly Performance Snapshot', platform: 'LinkedIn', time: '18:00', status: 'Scheduled', category: 'Performance' },
      ],
    },

  ];



  const monthDays = Array.from({ length: 31 }, (_, i) => i + 1);
  const getPostsForDate = (date: string) => schedule.find((entry) => entry.date === date)?.posts || [];

  const displayedSchedule = useMemo(() => {
    const base = currentWeek === 'current'
      ? schedule.filter((item) => ['23', '24', '25', '26', '27', '28', '29'].includes(item.date))
      : schedule.filter((item) => ['30', '31', '01', '02', '03', '04', '05'].includes(item.date));

    return base.map(day => ({
      ...day,
      posts: day.posts.filter(post => {
        const matchesSearch = post.title.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesPlatform = activePlatforms.length === 0 || activePlatforms.includes(post.platform);
        return matchesSearch && matchesPlatform;
      })
    }));
  }, [currentWeek, schedule, searchTerm, activePlatforms]);

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
            Autonomous <span className="text-gradient">Content Calendar</span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 }}
            className="text-white/60 max-w-2xl mx-auto"
          >
            Aries AI automatically generates, schedules, and publishes your content across all platforms.
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
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-[#1a1a2e]/30 border border-white/10 rounded-xl py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-primary/50 transition-colors text-white"
              />
            </div>

            <div className="space-y-6">

              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-white/30 mb-4">Platforms</h4>
                <div className="space-y-2">
                  {platforms.map((platform) => (
                    <div 
                      key={platform.name} 
                      onClick={() => {
                        setActivePlatforms(prev => 
                          prev.includes(platform.name) 
                            ? prev.filter(p => p !== platform.name) 
                            : [...prev, platform.name]
                        );
                      }}
                      className={cn(
                        "flex items-center justify-between p-3 rounded-xl transition-colors cursor-pointer group",
                        activePlatforms.includes(platform.name) ? "bg-white/10" : "hover:bg-white/5"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <span className={cn(
                          "text-sm font-medium transition-colors",
                          activePlatforms.includes(platform.name) ? "text-white" : "text-white/70 group-hover:text-white"
                        )}>
                          {platform.name}
                        </span>
                      </div>
                      <div className={cn(
                        "w-2 h-2 rounded-full transition-all",
                        activePlatforms.includes(platform.name) ? "bg-primary scale-125 shadow-[0_0_8px_rgba(124,58,237,0.5)]" : "bg-white/10"
                      )} />
                    </div>
                  ))}
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
                <h3 className="text-2xl font-light">March 2026</h3>
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
                      setActiveDate('20');
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
                <div className="flex gap-3">
                  <Link href="/login" className="px-6 py-2 bg-white/5 border border-white/10 rounded-xl text-sm font-bold hover:bg-white/10 transition-all">
                    New Post
                  </Link>
                </div>
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
                              getPlatformBorder(post.platform),
                            )}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[8px] font-bold uppercase tracking-tighter opacity-40">{post.time}</span>
                              <MoreHorizontal className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                            <h5 className="text-[10px] font-light mb-1.5 leading-tight">{truncateTitle(post.title, 3)}</h5>
                            <div className="flex items-center justify-between gap-1.5 pt-0.5">
                              {getPlatformIcon(post.platform)}
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
                            <div key={post.title} className={cn('p-1 border text-[7px] font-light leading-none truncate', getPlatformBorder(post.platform))}>
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

function Pricing() {
  const plans = [
    {
      name: 'Starter',
      price: '49',
      description: 'Perfect for solo founders and small startups.',
      features: ['3 Social Accounts', 'AI Content Generation', 'Basic Analytics', 'Weekly Reports'],
      highlight: false,
    },
    {
      name: 'Growth',
      price: '149',
      description: 'Ideal for scaling companies and marketing teams.',
      features: ['Unlimited Accounts', 'Market Intelligence Engine', 'Advanced Analytics', 'Daily Optimization', 'Priority Support'],
      highlight: true,
    },
    {
      name: 'Enterprise',
      price: 'Custom',
      description: 'For large organizations with complex needs.',
      features: ['Custom AI Training', 'Dedicated Account Manager', 'API Access', 'White-label Reports', 'SLA Guarantee'],
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

                <Link
                  href={plan.price === 'Custom' ? '/documentation' : '/login'}
                  className={cn(
                    'w-full py-4 rounded-2xl font-bold transition-all text-center',
                    plan.highlight
                      ? 'bg-gradient-to-r from-primary to-secondary text-white shadow-lg shadow-primary/20'
                      : 'bg-white/10 hover:bg-white/20 text-white',
                  )}
                >
                  {plan.price === 'Custom' ? 'Review Runtime' : 'Get Started'}
                </Link>
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

function FinalCTA() {
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
                <Link
                  href="/login"
                  className="px-8 py-4 rounded-full border border-white/20 hover:border-white/40 text-white font-bold transition-all backdrop-blur-md text-sm"
                >
                  Start Automating
                </Link>
                <Link
                  href="/documentation"
                  className="px-8 py-4 rounded-full border border-white/20 hover:border-white/40 text-white font-bold transition-all backdrop-blur-md text-sm"
                >
                  Read the Docs
                </Link>
              </motion.div>
            </div>
          </div>

          {/* Spline 3D Integration */}
          <div className="w-full h-full relative z-10 overflow-hidden">
            <iframe
              src="https://my.spline.design/boxeshover-1S9fbn10HLJkYTmxyOt88Ycb/"
              frameBorder="0"
              width="100%"
              height="100%"
              className="absolute -top-[50px] left-0 w-full md:w-[calc(100%+100px)] lg:w-[calc(100%+200px)] h-[calc(100%+100px)] max-w-none"
              title="Interactive 3D Boxes"
              sandbox="allow-scripts allow-same-origin"
            ></iframe>
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

      <section className="py-12 border-y border-white/5 bg-[#0a0a20]/50 overflow-hidden">
        <div className="container mx-auto px-6">
          <p className="text-center text-white/30 text-sm font-medium uppercase tracking-widest mb-8">
            Trusted by industry leaders
          </p>
          <div className="flex flex-wrap justify-center items-center gap-12 md:gap-24 opacity-40 grayscale hover:grayscale-0 transition-all duration-500">
            {['NEXUS', 'VELOCITY', 'QUANTUM', 'ELEVATE', 'ORBIT'].map((label) => (
              <span key={label} className="text-2xl font-bold">{label}</span>
            ))}
          </div>
        </div>
      </section>

      <Problem />

      <section className="py-24 relative">
        <div className="container mx-auto px-6 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="max-w-6xl mx-auto"
          >
            <div className="max-w-4xl mx-auto">
              <h2 className="text-4xl md:text-[48px] leading-tight font-bold mb-8">Meet Aries AI</h2>
              <p className="text-xl text-white/60 mb-12 leading-relaxed">
                Aries AI is an AI-native marketing intelligence system that continuously learns and executes campaigns automatically. It&apos;s not just a tool; it&apos;s your new autonomous marketing department.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-4 md:gap-6 w-full pb-4">
              {['Market Intelligence', 'Strategy', 'Content', 'Automation', 'Optimization'].map((step, index) => (
                <Fragment key={step}>
                  <div className="glass px-8 py-4 rounded-full text-sm font-semibold border-primary/20 whitespace-nowrap cursor-pointer hover-gradient-border">
                    {step}
                  </div>
                  {index < 4 ? <div className="hidden md:block w-8 md:w-12 h-px bg-white/20" /> : null}
                </Fragment>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      <Features />
      <HowItWorks />
      <ContentCalendar />
      <FeatureShowcase3D />
      <Pricing />
      <FinalCTA />
    </DonorMarketingShell>
  );
}
