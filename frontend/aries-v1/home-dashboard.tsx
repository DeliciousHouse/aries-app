'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  Server, 
  Monitor, 
  ArrowRight,
  Activity,
  Box,
  Linkedin,
  Facebook,
  Instagram,
  Youtube,
  Zap,
  Layers,
  Sparkles,
  ChevronRight
} from 'lucide-react';
import { XIcon } from '../components/Icons';

const platforms = [
  { name: 'LinkedIn', reach: '12.4K', increase: '+24%', increaseVal: 24, posts: 12, color: '#0077b5', icon: Linkedin },
  { name: 'X', reach: '8.2K', increase: '+15%', increaseVal: 15, posts: 8, color: '#71717a', icon: XIcon },
  { name: 'Instagram', reach: '45.1K', increase: '+42%', increaseVal: 42, posts: 24, color: '#E1306C', icon: Instagram },
  { name: 'Facebook', reach: '3.5K', increase: '+5%', increaseVal: 5, posts: 2, color: '#4267B2', icon: Facebook },
  { name: 'YouTube', reach: '0', increase: '0%', increaseVal: 0, posts: 0, color: '#FF0000', icon: Youtube }
];

export default function AriesHomeDashboard() {
  const [activeIndex, setActiveIndex] = useState(0);

  // Auto-rotate the orbit every 4 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveIndex((prev) => prev + 1);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const activePlatformIndex = activeIndex % platforms.length;
  const activePlatform = platforms[activePlatformIndex];
  const isZero = activePlatform.posts === 0;

  // Paths for the sparkline animation
  const platformPaths = [
    { line: "M 0 30 C 20 30 30 15 50 20 C 70 25 80 5 90 5", arrow: "M 85 1 L 90 5 L 85 9" },
    { line: "M 0 30 C 20 20 40 40 60 10 C 70 0 80 15 90 5", arrow: "M 85 5 L 90 5 L 90 10" },
    { line: "M 0 30 C 25 35 45 10 65 20 C 75 25 85 10 90 5", arrow: "M 85 5 L 90 5 L 90 10" },
    { line: "M 0 30 C 15 15 35 30 50 15 C 65 0 80 10 90 5", arrow: "M 85 2 L 90 5 L 87 10" },
    { line: "M 0 30 C 30 25 40 5 60 15 C 75 25 85 10 90 5", arrow: "M 85 5 L 90 5 L 90 10" }
  ];
  
  const activePathSet = isZero 
    ? { line: "M 0 30 Q 45 30.01 90 30", arrow: "M 86 26 L 90 30 L 86 34" }
    : platformPaths[activePlatformIndex % platformPaths.length];

  return (
    <div className="space-y-6 pb-12">
      
      {/* Top Section - Single Unified Box */}
      <div className="relative w-full min-h-[400px] md:min-h-[550px] rounded-[1.5rem] md:rounded-[2rem] bg-[radial-gradient(ellipse_at_bottom,_var(--tw-gradient-stops))] from-primary/20 via-[#0a0a0f] to-[#0a0a0f] border border-white/10 overflow-hidden shadow-2xl">
        
        {/* Company Name */}
        <div className="absolute top-5 right-5 md:top-8 md:right-8 z-50">
          <div className="bg-[#12121a] border border-white/10 rounded-lg sm:rounded-xl md:rounded-2xl px-2.5 py-1.5 md:px-6 md:py-4 flex items-center justify-center shadow-xl">
            <h2 className="text-[10px] sm:text-sm md:text-xl lg:text-2xl font-bold text-white tracking-tight whitespace-nowrap">Northstar Studio</h2>
          </div>
        </div>

        {/* Radar Background (Center) */}
        <div className="absolute inset-0 flex items-end justify-center pointer-events-none">
          
          {/* Top Label (Total Reach) */}
          <div className="absolute top-40 md:top-48 lg:top-12 left-1/2 -translate-x-1/2 flex flex-col items-center z-20">
            <motion.span 
              key={activePlatform.reach}
              initial={{ opacity: 0, filter: 'blur(4px)', y: 5 }}
              animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
              transition={{ duration: 0.5 }}
              className="text-3xl md:text-4xl font-bold text-white tracking-tight"
            >
              {activePlatform.reach}
            </motion.span>
            <span className="text-[10px] md:text-xs text-white/50 uppercase tracking-widest font-medium mt-1 md:mt-2">Total Reach</span>
          </div>

          {/* Radar SVG */}
          <div className="absolute bottom-0 w-[95%] md:w-[80%] max-w-[1000px] aspect-[2/1] overflow-visible">
            <svg viewBox="0 0 200 100" className="w-full h-full overflow-visible">
              <defs>
                <linearGradient id="outerTicks" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="rgba(123,97,255,0.1)" />
                  <stop offset="50%" stopColor="rgba(123,97,255,0.6)" />
                  <stop offset="100%" stopColor="rgba(123,97,255,0.1)" />
                </linearGradient>
              </defs>
              
              {/* Outer Ticks */}
              <g transform="translate(100, 100)">
                {Array.from({ length: 90 }).map((_, i) => (
                  <line 
                    key={`outer-${i}`} 
                    x1="0" y1="-85" x2="0" y2="-95" 
                    transform={`rotate(${(i * 180) / 89 - 90})`} 
                    stroke="url(#outerTicks)" 
                    strokeWidth="0.75" 
                  />
                ))}
              </g>

              {/* Thin Rings */}
              <circle cx="100" cy="100" r="70" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
              <circle cx="100" cy="100" r="50" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
            </svg>

            {/* Orbiting Platforms */}
            <div className="absolute bottom-0 left-1/2 w-[85%] md:w-[70%] aspect-square -translate-x-1/2 translate-y-1/2 pointer-events-none z-20">
              <motion.div 
                className="absolute inset-0"
                animate={{ rotate: activeIndex * 72 }}
                transition={{ duration: 1.5, ease: "easeInOut" }}
              >
                {platforms.map((platform, i) => {
                  const isActive = i === activePlatformIndex;
                  return (
                    <div 
                      key={platform.name}
                      className="absolute inset-0"
                      style={{ 
                        transform: `rotate(${-i * 72}deg)` 
                      }}
                    >
                      <div className="absolute top-0 left-1/2 w-0 h-0">
                        <motion.div
                          animate={{ 
                            rotate: -(activeIndex * 72 - i * 72)
                          }}
                          transition={{ duration: 1.5, ease: "easeInOut" }}
                          className={`flex flex-col items-center justify-center -ml-5 -mt-5 md:-ml-7 md:-mt-7 w-10 h-10 md:w-14 md:h-14 rounded-full bg-[#12121a] border ${isActive ? 'border-white/30 shadow-[0_0_30px_rgba(123,97,255,0.2)]' : 'border-white/10'} transition-all duration-500 pointer-events-auto`}
                        >
                          <platform.icon className={`w-4 h-4 md:w-6 md:h-6 transition-colors duration-500 ${isActive ? 'text-white' : 'text-gray-500'}`} />
                        </motion.div>
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            </div>
          </div>

          {/* Center Gauge (Dome) */}
          <div className="absolute bottom-0 w-[50%] md:w-[35%] max-w-[450px] aspect-[2/1] rounded-t-full bg-gradient-to-t from-[#050505] to-primary/30 border-t border-primary/50 shadow-[0_-30px_60px_rgba(123,97,255,0.2)] flex items-end justify-center pb-1 md:pb-1 lg:pb-8 z-30">
            <div className="flex flex-col items-center">
              <motion.span 
                key={activePlatform.increase}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5 }}
                className="text-lg md:text-lg lg:text-4xl font-bold text-white leading-none"
              >
                {activePlatform.increase}
              </motion.span>
              <span className="text-[7px] md:text-[9px] text-white/50 uppercase tracking-widest mt-0.5 md:mt-0.5 lg:mt-2">Overall Increase</span>
            </div>
            
            {/* Animated Progress Arc Overlay */}
            <svg viewBox="0 0 100 55" className="absolute top-0 left-0 w-full h-full overflow-visible">
              <defs>
                <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="rgba(123,97,255,0.1)" />
                  <stop offset="50%" stopColor="rgba(123,97,255,0.6)" />
                  <stop offset="100%" stopColor="rgba(123,97,255,0.1)" />
                </linearGradient>
              </defs>
              
              {/* Ticks */}
              <g transform="translate(50, 50)">
                {Array.from({ length: 51 }).map((_, i) => {
                  const rotation = -180 + (i * 180) / 50;
                  return (
                    <line 
                      key={`gauge-tick-${i}`}
                      x1="40" y1="0" x2="46" y2="0"
                      transform={`rotate(${rotation})`}
                      stroke="url(#gaugeGradient)"
                      strokeWidth="0.75"
                    />
                  );
                })}
              </g>

              {/* Background Track */}
              <path d="M 15 50 A 35 35 0 0 1 85 50" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6" strokeLinecap="butt" />
              
              {/* Active Progress */}
              <motion.path 
                d="M 15 50 A 35 35 0 0 1 85 50" 
                fill="none" 
                stroke="#ffffff" 
                strokeWidth="6" 
                strokeLinecap="round" 
                initial={{ pathLength: 0 }}
                animate={{ pathLength: activePlatform.increaseVal / 100 }}
                transition={{ duration: 1.5, ease: "easeInOut" }}
              />
            </svg>
          </div>
        </div>

        {/* Content Overlay Grid (Cards on top) */}
        <div className="relative z-40 grid grid-cols-1 lg:grid-cols-12 gap-6 p-6 h-full pointer-events-none">
          
          {/* Left Column - Glassmorphic Cards */}
          <div className="lg:col-span-3 flex flex-col gap-6 pointer-events-auto items-start pt-0 lg:pt-0">
            {/* Number of Posts Card */}
            <div className="w-full max-w-[115px] sm:max-w-[180px] md:max-w-[220px] lg:w-64 bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl md:rounded-3xl p-2 sm:p-2.5 md:p-4 lg:p-5 relative overflow-hidden shadow-2xl group hover:bg-white/10 transition-colors">
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/20 blur-[50px] rounded-full -mr-10 -mt-10 pointer-events-none"></div>
              <h3 className="text-[9px] md:text-sm font-medium text-white/70 mb-1 sm:mb-1.5 md:mb-4">Number of Posts</h3>
              <div className="flex items-baseline gap-1 md:gap-1.5 mb-1 sm:mb-1.5 md:mb-6">
                <motion.span 
                  key={activePlatform.posts}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5 }}
                  className="text-xl md:text-4xl lg:text-5xl font-bold text-white tracking-tight"
                >
                  {activePlatform.posts}
                </motion.span>
                <span className="text-[9px] md:text-sm text-white/50">Posts</span>
              </div>
              
              {/* Animated Sparkline */}
              <div className="h-8 md:h-16 w-full">
                <svg viewBox="0 0 100 40" className="w-full h-full overflow-visible">
                  <defs>
                    <linearGradient id="fadeLine" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#7b61ff" stopOpacity="0" />
                      <stop offset="50%" stopColor="#7b61ff" stopOpacity="0.5" />
                      <stop offset="100%" stopColor="#7b61ff" stopOpacity="1" />
                    </linearGradient>
                  </defs>
                  <motion.path 
                    key={`path-${activePlatform.name}`}
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{ duration: 1.5, ease: "easeInOut" }}
                    d={activePathSet.line}
                    fill="none" 
                    stroke="url(#fadeLine)" 
                    strokeWidth="2" 
                    strokeLinecap="round" 
                  />
                  <motion.path 
                    key={`arrow-${activePlatform.name}`}
                    initial={{ opacity: 0, x: -3 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 1.2, duration: 0.3, ease: "easeOut" }}
                    d={activePathSet.arrow}
                    fill="none" 
                    stroke="#7b61ff" 
                    strokeWidth="2" 
                    strokeLinecap="round" 
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Bottom Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Working Now */}
        <div className="bg-[#080808] border border-white/[0.05] rounded-2xl overflow-hidden flex flex-col">
          <div className="p-6 pb-5 flex items-start justify-between">
            <div>
              <h4 className="text-[11px] font-bold text-white/40 uppercase tracking-[0.15em] mb-2">Working Now</h4>
              <h3 className="text-xl font-semibold text-white tracking-tight">Results will populate after launch.</h3>
            </div>
            <button className="flex items-center gap-1 text-white/90 hover:text-white transition-colors text-sm font-medium">
              Open results
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="h-px w-full bg-white/10" />
          
          <div className="p-6">
            <p className="text-[15px] text-white/60 leading-relaxed mb-6">
              Aries will summarize booking momentum, cost efficiency, and next actions once the campaign is live.
            </p>
            
            <div className="bg-[#1B1524] border border-white/[0.05] rounded-2xl p-5">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                  <Sparkles className="w-5 h-5 text-white/90" />
                </div>
                <div className="flex flex-col">
                  <h4 className="text-[15px] font-semibold text-white mb-2">Approve the launch set</h4>
                  <p className="text-[14px] text-white/50 leading-relaxed mb-4">
                    Three items are ready. Approval is the only blocker before Aries can schedule the first week.
                  </p>
                  <button className="flex items-center gap-2 text-white font-medium text-sm hover:text-white/80 transition-colors w-fit">
                    Open review queue
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Needs Approval */}
        <div className="bg-[#080808] border border-white/[0.05] rounded-2xl overflow-hidden flex flex-col">
          <div className="p-6 pb-5 flex items-start justify-between">
            <div>
              <h4 className="text-[11px] font-bold text-white/40 uppercase tracking-[0.15em] mb-2">Needs Approval</h4>
              <h3 className="text-xl font-semibold text-white tracking-tight">3 items waiting</h3>
            </div>
            <button className="flex items-center gap-2 bg-[#2a2515] hover:bg-[#3a331d] border border-[#4a4025] text-white px-4 py-2 rounded-full transition-colors">
              <Layers className="w-4 h-4 text-[#e5c07b]" />
              <span className="text-sm font-medium">Review Queue</span>
              <span className="flex items-center justify-center bg-white/10 text-white text-xs font-bold w-5 h-5 rounded-full ml-1">3</span>
            </button>
          </div>
          <div className="h-px w-full bg-white/10" />
          
          <div className="p-6 space-y-4">
            {[
              { 
                title: 'Meta launch hero', 
                meta: 'Meta · Feed 4:5 · Tue, Mar 31 at 9:00 AM',
                status: 'In review'
              },
              { 
                title: 'Instagram story offer', 
                meta: 'Instagram · Story 9:16 · Wed, Apr 1 at 7:30 AM',
                status: 'In review'
              },
              { 
                title: 'Landing page update', 
                meta: 'Website · Campaign page · Before launch',
                status: 'In review'
              },
            ].map((item, i) => (
              <div key={i} className="bg-[#1B1524] border border-white/[0.05] rounded-2xl p-5 flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-[15px] font-medium text-white/90 mb-1">{item.title}</span>
                  <span className="text-sm text-white/40">{item.meta}</span>
                </div>
                <div className="flex items-center justify-center px-3 py-1 rounded-full border border-[#4a4025] bg-[#2a2515]/50 text-[#e5c07b] text-xs font-medium">
                  {item.status}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="bg-[#080808] border border-white/[0.05] rounded-2xl overflow-hidden flex flex-col">
          <div className="p-6 pb-5">
            <h4 className="text-[11px] font-bold text-white/40 uppercase tracking-[0.15em] mb-2">Recent Activity</h4>
            <h3 className="text-xl font-semibold text-white tracking-tight">What Aries has done recently</h3>
          </div>
          <div className="h-px w-full bg-white/10" />
          
          <div className="p-6 space-y-4">
            {[
              { 
                title: 'Plan approved', 
                time: 'Today, 8:12 AM',
                desc: 'Campaign plan was approved and moved into creative preparation.'
              },
              { 
                title: 'Creative updated', 
                time: 'Today, 9:45 AM',
                desc: 'Aries applied pricing clarity edits to the story set.'
              },
              { 
                title: 'Landing page changed', 
                time: 'Today, 10:18 AM',
                desc: 'One structural change moved the page back into review for safety.'
              },
            ].map((activity, i) => (
              <div key={i} className="bg-[#1B1524] border border-white/[0.05] rounded-2xl p-5 flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Zap className="w-4 h-4 text-white/70" />
                </div>
                <div className="flex flex-col">
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="text-[15px] font-medium text-white/90">{activity.title}</span>
                    <span className="text-xs text-white/40">{activity.time}</span>
                  </div>
                  <p className="text-sm text-white/50 leading-relaxed">
                    {activity.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Connected Surfaces */}
        <div className="bg-[#080808] border border-white/[0.05] rounded-2xl overflow-hidden flex flex-col">
          <div className="p-6 pb-5">
            <h4 className="text-[11px] font-bold text-white/40 uppercase tracking-[0.15em] mb-2">Channel Health</h4>
            <h3 className="text-xl font-semibold text-white tracking-tight">Connected surfaces</h3>
          </div>
          <div className="h-px w-full bg-white/10" />
          
          <div className="p-6 space-y-4">
            {[
              { name: 'Facebook', handle: 'facebook' },
              { name: 'Instagram', handle: 'instagram' },
              { name: 'LinkedIn', handle: 'linkedin' },
            ].map((platform, i) => (
              <div key={i} className="bg-[#1B1524] border border-white/[0.05] rounded-2xl p-5 flex flex-col">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[15px] font-medium text-white/90">{platform.name}</span>
                  <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full">
                    <div className="w-2 h-2 rounded-full bg-white/30" />
                    <span className="text-xs text-white/60 font-medium">Not connected</span>
                  </div>
                </div>
                <span className="text-sm text-white/40 mb-4">{platform.handle}</span>
                <p className="text-sm text-white/50 leading-relaxed pr-4">
                  Not connected yet. Safe to connect later.
                </p>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
