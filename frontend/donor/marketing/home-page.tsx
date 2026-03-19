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
  Twitter,
  Youtube,
  Zap,
  AlertCircle,
} from 'lucide-react';
import { motion, useScroll, useSpring, useTransform, type MotionValue } from 'motion/react';

import { cn } from '../lib/utils';
import { AriesMark } from '../ui';
import { DonorMarketingShell } from './chrome';

const FeatureShowcase3D = dynamic(() => import('./feature-showcase-3d'), {
  ssr: false,
  loading: () => (
    <section className="py-24 relative overflow-hidden bg-black">
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
  icon: typeof Twitter;
  angle: number;
  radius: number;
};

const PLATFORM_ORBITS: PlatformOrbit[] = [
  { icon: Twitter, angle: 180, radius: 180 },
  { icon: Instagram, angle: 60, radius: 300 },
  { icon: Linkedin, angle: 240, radius: 300 },
  { icon: Facebook, angle: 0, radius: 420 },
  { icon: Youtube, angle: 120, radius: 420 },
  { icon: MessageCircle, angle: 300, radius: 420 },
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

  const navbarLogoX = Math.max(24, (windowSize.width - 1280) / 2) + 16;
  const navbarLogoY = 32;
  const startX = navbarLogoX - windowSize.width / 2;
  const startY = navbarLogoY - windowSize.height / 2;

  const logoX = useTransform(smoothProgress, [0, 0.15, 0.3, 0.5, 0.95, 1], [startX, startX, 0, 0, startX, startX]);
  const logoY = useTransform(smoothProgress, [0, 0.15, 0.3, 0.5, 0.95, 1], [startY, startY, 0, 0, startY, startY]);
  const logoScale = useTransform(smoothProgress, [0, 0.15, 0.3, 0.5, 0.95, 1], [1, 1, 1.5625, 1.5625, 0.5, 0.5]);
  const logoOpacity = useTransform(smoothProgress, [0, 0.95, 1], [1, 1, 0]);
  const centralCircleOpacity = useTransform(smoothProgress, [0, 0.05, 0.15, 0.5, 0.6], [0, 0, 1, 1, 0]);
  const centralCircleScale = useTransform(smoothProgress, [0, 0.05, 0.15, 0.5, 0.6], [0.5, 0.5, 1, 1, 0.5]);
  const platformsOpacity = useTransform(smoothProgress, [0, 0.05, 0.15, 0.5, 0.6], [0, 0, 1, 1, 0]);
  const platformsRotate = useTransform(smoothProgress, [0, 1], [0, 360]);

  return (
    <section ref={containerRef} className="relative h-[250vh]">
      <div className="sticky top-0 h-screen flex items-center justify-center overflow-hidden bg-animate">
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

        <div className="container mx-auto px-6 relative z-20 text-center">
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
            className="text-[2.5rem] md:text-[3.5rem] lg:text-[4rem] font-bold tracking-tight mb-8 leading-[1.1]"
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
              {PLATFORM_ORBITS.map((platform, index) => (
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
                marginTop: '-16px',
                marginLeft: '-16px',
              }}
              className="z-[60]"
            >
              <div className="relative">
                <AriesMark sizeClassName="w-8 h-8" />
                <motion.div
                  className="absolute inset-0 rounded-lg border-2 border-primary/50"
                  animate={{ scale: [1, 2], opacity: [0.8, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
                />
              </div>
            </motion.div>
          </div>
        </div>

        <div className="hidden lg:block absolute inset-0 pointer-events-none max-w-[1400px] mx-auto">
          <motion.div
            style={{ opacity: useTransform(smoothProgress, [0, 0.05], [1, 0]) }}
            animate={{ y: [-15, 15, -15] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute top-[50%] left-8 xl:left-12 mt-24 glass-reflection p-5 rounded-2xl w-64 text-left pointer-events-auto"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-primary/20 rounded-lg">
                <BarChart3 className="w-5 h-5 text-primary" />
              </div>
              <span className="font-semibold text-white">Analytics</span>
            </div>
            <p className="text-sm font-medium text-white/80">+24% Growth this week</p>
          </motion.div>

          <motion.div
            style={{ opacity: useTransform(smoothProgress, [0, 0.05], [1, 0]) }}
            animate={{ y: [15, -15, 15] }}
            transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute top-[65%] right-4 xl:right-8 glass-reflection p-5 rounded-2xl w-[250px] flex flex-col justify-center text-left pointer-events-auto"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 bg-secondary/20 rounded-lg">
                <Share2 className="w-5 h-5 text-secondary" />
              </div>
              <span className="font-semibold text-white">Auto-Post</span>
            </div>
            <p className="text-sm font-medium text-white/80">X, LinkedIn, Insta, etc.</p>
          </motion.div>
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
            className="text-[48px] leading-tight font-bold mb-6"
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
          <h2 className="text-[48px] leading-tight font-bold mb-6">How It Works</h2>
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
  const [activeDate, setActiveDate] = useState('20');
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');

  const platforms = [
    { name: 'X / Twitter' },
    { name: 'LinkedIn' },
    { name: 'Instagram' },
    { name: 'YouTube' },
    { name: 'Facebook' },
  ];

  const getPlatformBorder = (platform: string) => {
    switch (platform) {
      case 'LinkedIn':
        return 'border-blue-600/50';
      case 'YouTube':
        return 'border-red-500/50';
      case 'X / Twitter':
        return 'border-blue-400/50';
      case 'Instagram':
        return 'border-pink-500/50';
      case 'Facebook':
        return 'border-blue-700/50';
      default:
        return 'border-primary/30';
    }
  };

  const truncateTitle = (title: string, wordCount = 3) => {
    const words = title.split(' ');
    return words.length <= wordCount ? title : `${words.slice(0, wordCount).join(' ')}...`;
  };

  const schedule = [
    {
      day: 'Mon',
      date: '16',
      posts: [
        { title: 'AI Marketing Trends 2026 Strategy', platform: 'LinkedIn', time: '09:00', status: 'Published' },
        { title: 'Aries AI Feature Reveal Today', platform: 'X / Twitter', time: '14:00', status: 'Published' },
      ],
    },
    {
      day: 'Tue',
      date: '17',
      posts: [
        { title: 'The Power of GEO Optimization', platform: 'Instagram', time: '10:30', status: 'Published' },
        { title: 'Market Intelligence 101 Guide', platform: 'YouTube', time: '16:00', status: 'Published' },
      ],
    },
    {
      day: 'Wed',
      date: '18',
      posts: [
        { title: 'Autonomous Growth Case Study Analysis', platform: 'LinkedIn', time: '11:00', status: 'Published' },
        { title: 'Facebook Ads Mastery Course', platform: 'Facebook', time: '15:30', status: 'Published' },
      ],
    },
    {
      day: 'Thu',
      date: '19',
      posts: [
        { title: 'Why AEO is the new SEO', platform: 'X / Twitter', time: '09:30', status: 'Published' },
        { title: 'Weekly AI Wrap-up Content', platform: 'Instagram', time: '15:00', status: 'Published' },
      ],
    },
    {
      day: 'Fri',
      date: '20',
      posts: [{ title: 'Aries AI v2.0 Launch Event', platform: 'LinkedIn', time: '10:00', status: 'Scheduled' }],
    },
  ];

  const monthDays = Array.from({ length: 31 }, (_, i) => i + 1);
  const getPostsForDate = (date: string) => schedule.find((entry) => entry.date === date)?.posts || [];

  return (
    <section id="calendar" className="py-24 relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-[48px] leading-tight font-light mb-6"
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
                className="w-full bg-black/30 border border-white/10 rounded-xl py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-primary/50 transition-colors"
              />
            </div>

            <div className="space-y-6">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-white/30 mb-4">Platforms</h4>
                <div className="space-y-2">
                  {platforms.map((platform) => (
                    <div key={platform.name} className="flex items-center justify-between p-3 rounded-xl hover:bg-white/5 transition-colors cursor-pointer group">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium text-white/70 group-hover:text-white transition-colors">
                          {platform.name}
                        </span>
                      </div>
                      <div className="w-2 h-2 rounded-full bg-primary" />
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-white/30 mb-4">Status</h4>
                <div className="space-y-3 px-2">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-sm text-white/60">Published</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-primary" />
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
                  <button type="button" className="p-2 hover:bg-white/5 rounded-lg border border-white/10 transition-colors">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveDate('20')}
                    className="px-4 py-2 hover:bg-white/5 rounded-lg border border-white/10 text-sm font-medium transition-colors"
                  >
                    Today
                  </button>
                  <button type="button" className="p-2 hover:bg-white/5 rounded-lg border border-white/10 transition-colors">
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
                <Link href="/calendar" className="px-6 py-2 bg-gradient-to-r from-primary to-secondary rounded-xl text-sm font-bold shadow-lg shadow-primary/20">
                  Open Runtime
                </Link>
              </div>
            </div>

            <div className="flex-1 p-8 overflow-x-auto">
              {viewMode === 'week' ? (
                <div className="min-w-[800px] grid grid-cols-5 gap-6 h-full">
                  {schedule.map((day, dayIndex) => (
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
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[8px] font-medium px-1.5 py-0.5 bg-white/5 rounded-full text-white/70">
                                {post.platform}
                              </span>
                              <span
                                className={cn(
                                  'text-[6px] font-bold uppercase tracking-widest px-1 py-0.5 rounded-full',
                                  post.status === 'Published' ? 'bg-green-500/20 text-green-500' : 'bg-primary/20 text-primary',
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
          <h2 className="text-[48px] leading-tight font-bold mb-6">Simple, Transparent Pricing</h2>
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
                  href={plan.price === 'Custom' ? '/contact' : '/login'}
                  className={cn(
                    'w-full py-4 rounded-2xl font-bold transition-all text-center',
                    plan.highlight
                      ? 'bg-gradient-to-r from-primary to-secondary text-white shadow-lg shadow-primary/20'
                      : 'bg-white/10 hover:bg-white/20 text-white',
                  )}
                >
                  {plan.price === 'Custom' ? 'Contact Sales' : 'Get Started'}
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
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full bg-white/5 blur-[120px] -z-10 pointer-events-none" />

          <div className="w-full h-full relative z-10 overflow-hidden bg-[radial-gradient(circle_at_30%_30%,rgba(124,58,237,0.35),transparent_35%),radial-gradient(circle_at_70%_40%,rgba(168,85,247,0.25),transparent_30%),radial-gradient(circle_at_50%_75%,rgba(255,255,255,0.09),transparent_40%)]">
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8">
              <div className="glass-reflection rounded-[2rem] p-8 md:p-12 max-w-3xl">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 mb-6">
                  <Sparkles className="w-7 h-7 text-primary" />
                </div>
                <h2 className="text-4xl md:text-6xl font-bold mb-6 leading-tight">
                  Bring the <span className="text-gradient">donor UI</span> to your real runtime
                </h2>
                <p className="text-white/60 text-lg md:text-xl max-w-2xl mx-auto mb-8">
                  Launch the canonical Aries operator experience against the existing OpenClaw-backed backend, without leaking runtime internals to the browser.
                </p>
                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                  <Link
                    href="/login"
                    className="px-8 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20 hover:scale-105 transition-transform flex items-center justify-center gap-2"
                  >
                    Open the Console <ArrowRight className="w-5 h-5" />
                  </Link>
                  <Link
                    href="/documentation"
                    className="px-8 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all"
                  >
                    Review Runtime Docs
                  </Link>
                </div>
              </div>
            </div>
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

      <section className="py-12 border-y border-white/5 bg-black/50 overflow-hidden">
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
              <h2 className="text-[48px] leading-tight font-bold mb-8">Meet Aries AI</h2>
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
      <FeatureShowcase3D />
      <HowItWorks />
      <ContentCalendar />
      <Pricing />
      <FinalCTA />
    </DonorMarketingShell>
  );
}
