'use client';

import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  BarChart3, 
  TrendingUp, 
  Users, 
  Eye,
  ArrowUpRight,
  ArrowDownRight,
  Sparkles,
  Linkedin,
  Instagram,
  Youtube,
  Facebook,
  Share2,
  MessageSquare,
  Heart,
  MousePointer2,
  Globe
} from 'lucide-react';
import { XIcon } from '../components/Icons';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  PieChart,
  Pie
} from 'recharts';

const PLATFORMS = [
  { id: 'all', name: 'All Platforms', icon: Globe, color: '#7b61ff' },
  { id: 'linkedin', name: 'LinkedIn', icon: Linkedin, color: '#0077b5' },
  { id: 'instagram', name: 'Instagram', icon: Instagram, color: '#E4405F' },
  { id: 'twitter', name: 'X', icon: XIcon, color: '#71717a' },
  { id: 'youtube', name: 'YouTube', icon: Youtube, color: '#FF0000' },
  { id: 'facebook', name: 'Facebook', icon: Facebook, color: '#1877F2' },
];

const generateEngagementData = (platformId: string, timeframe: string) => {
  const count = timeframe === '7d' ? 7 : timeframe === '30d' ? 15 : 30; // Using smaller counts for better visualization in mock
  const labels = timeframe === '7d' 
    ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] 
    : Array.from({ length: count }, (_, i) => timeframe === '30d' ? `W${Math.floor(i/7) + 1}` : `M${Math.floor(i/30) + 1}`);
    
  return Array.from({ length: count }).map((_, i) => ({
    name: timeframe === '7d' ? labels[i] : `${timeframe === '30d' ? 'Day' : 'Week'} ${i + 1}`,
    value: Math.floor(Math.random() * 5000) + 1000,
    engagement: (Math.random() * 5 + 2).toFixed(1),
  }));
};

const TOP_CONTENT = [
  { title: 'Q1 Growth Strategy Deep Dive', platform: 'linkedin', engagement: '12.4%', reach: '8.2K' },
  { title: 'Behind the Scenes: Product Launch', platform: 'instagram', engagement: '9.8%', reach: '12.1K' },
  { title: 'Weekly Market Insights #12', platform: 'twitter', engagement: '4.2%', reach: '5.4K' },
  { title: 'How to Scale Your SaaS in 2024', platform: 'linkedin', engagement: '15.1%', reach: '10.5K' },
  { title: 'New Feature Announcement!', platform: 'facebook', engagement: '3.2%', reach: '4.1K' },
  { title: 'Product Demo: AI Assistant', platform: 'youtube', engagement: '18.5%', reach: '25.2K' },
  { title: 'Office Tour: Creative Space', platform: 'instagram', engagement: '11.2%', reach: '15.4K' },
  { title: 'Customer Success Story: Acme Corp', platform: 'linkedin', engagement: '8.7%', reach: '6.3K' },
  { title: 'Quick Tip: Mastering Reels', platform: 'instagram', engagement: '14.2%', reach: '20.1K' },
];

const aggregateData = [
  { name: 'Mon', value: 12000, linkedin: 4000, instagram: 3000, twitter: 2000, youtube: 2000, facebook: 1000 },
  { name: 'Tue', value: 15000, linkedin: 5000, instagram: 4000, twitter: 2500, youtube: 2500, facebook: 1000 },
  { name: 'Wed', value: 18000, linkedin: 6000, instagram: 5000, twitter: 3000, youtube: 3000, facebook: 1000 },
  { name: 'Thu', value: 14000, linkedin: 4500, instagram: 3500, twitter: 2500, youtube: 2500, facebook: 1000 },
  { name: 'Fri', value: 20000, linkedin: 7000, instagram: 6000, twitter: 3000, youtube: 3000, facebook: 1000 },
  { name: 'Sat', value: 22000, linkedin: 8000, instagram: 7000, twitter: 3000, youtube: 3000, facebook: 1000 },
  { name: 'Sun', value: 19000, linkedin: 6500, instagram: 5500, twitter: 3000, youtube: 3000, facebook: 1000 },
];

const platformStats = [
  { id: 'linkedin', name: 'LinkedIn', impressions: '45.2K', engagement: '6.8%', growth: '+12%', color: '#0077b5' },
  { id: 'instagram', name: 'Instagram', impressions: '38.1K', engagement: '5.2%', growth: '+8%', color: '#E4405F' },
  { id: 'twitter', name: 'X', impressions: '22.4K', engagement: '3.1%', growth: '+15%', color: '#71717a' },
  { id: 'youtube', name: 'YouTube', impressions: '15.8K', engagement: '12.4%', growth: '+5%', color: '#FF0000' },
  { id: 'facebook', name: 'Facebook', impressions: '12.1K', engagement: '2.4%', growth: '+2%', color: '#1877F2' },
];

export default function AriesResultsScreen() {
  const [selectedPlatform, setSelectedPlatform] = useState('all');
  const [timeframe, setTimeframe] = useState('7d');

  const currentPlatform = useMemo(() => 
    PLATFORMS.find(p => p.id === selectedPlatform) || PLATFORMS[0]
  , [selectedPlatform]);

  const kpis = useMemo(() => {
    if (selectedPlatform === 'all') {
      return [
        { label: 'Total Impressions', value: '133.6K', change: '+14.2%', trend: 'up', icon: Eye },
        { label: 'Avg. Engagement', value: '5.8%', change: '+1.1%', trend: 'up', icon: TrendingUp },
        { label: 'Total Audience', value: '24.5K', change: '+8.4%', trend: 'up', icon: Users },
      ];
    }
    const stat = platformStats.find(s => s.id === selectedPlatform);
    return [
      { label: `${stat?.name} Impressions`, value: stat?.impressions, change: '+12.5%', trend: 'up', icon: Eye },
      { label: 'Engagement Rate', value: stat?.engagement, change: '+0.8%', trend: 'up', icon: TrendingUp },
      { label: 'Follower Growth', value: stat?.growth, change: '+2.4%', trend: 'up', icon: Users },
    ];
  }, [selectedPlatform]);

  const chartData = useMemo(() => {
    if (selectedPlatform === 'all') return aggregateData;
    // For single platform, map the 'value' to the platform ID key for consistency
    return generateEngagementData(selectedPlatform, timeframe).map(d => ({
      ...d,
      [selectedPlatform]: d.value
    }));
  }, [selectedPlatform, timeframe]);

  const filteredContent = useMemo(() => {
    if (selectedPlatform === 'all') return TOP_CONTENT.slice(0, 3);
    const platformContent = TOP_CONTENT.filter(post => post.platform === selectedPlatform);
    return platformContent.length > 0 ? platformContent : TOP_CONTENT.slice(0, 3);
  }, [selectedPlatform]);

  return (
    <div className="flex flex-col lg:flex-row gap-8 min-h-screen pb-12">
      {/* Platform Sidebar Selector */}
      <div className="w-full lg:w-64 shrink-0 space-y-2">
        <h3 className="text-xs font-bold text-zinc-500 tracking-widest uppercase mb-4 px-2">Platforms</h3>
        <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-visible pb-4 lg:pb-0 no-scrollbar">
          {PLATFORMS.map(platform => (
            <button
              key={platform.id}
              onClick={() => setSelectedPlatform(platform.id)}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all shrink-0 lg:w-full ${
                selectedPlatform === platform.id 
                  ? 'bg-primary/10 border-primary text-white shadow-[0_0_15px_rgba(123,97,255,0.2)]' 
                  : 'bg-surface/30 border-white/5 text-text-muted hover:border-white/10 hover:bg-surface/50'
              }`}
            >
              <platform.icon className={`w-4 h-4 ${selectedPlatform === platform.id ? 'text-primary' : 'text-zinc-500'}`} />
              <span className="text-sm font-medium whitespace-nowrap">{platform.name}</span>
            </button>
          ))}
        </div>

        <div className="mt-8 hidden lg:block">
          <div className="glass-panel p-4 bg-primary/5 border-primary/10">
            <div className="flex items-center gap-2 mb-2 text-primary">
              <Sparkles className="w-4 h-4" />
              <span className="text-xs font-bold uppercase tracking-wider">AI Insight</span>
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              {selectedPlatform === 'all' 
                ? "LinkedIn is your strongest driver for B2B leads, while Instagram Reels are seeing a 45% spike in reach."
                : `Your ${currentPlatform.name} engagement is peaking at 10 AM EST. Consider scheduling more high-value content during this window.`}
            </p>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 space-y-8 min-w-0">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className={`p-2 rounded-lg bg-white/5`}>
                <currentPlatform.icon className="w-5 h-5 text-primary" />
              </div>
              <h1 className="text-3xl font-display font-semibold tracking-tight text-white">
                {currentPlatform.name} Results
              </h1>
            </div>
            <p className="text-zinc-500">Performance metrics for the last {timeframe === '7d' ? '7 days' : timeframe}.</p>
          </div>
          
          <div className="flex bg-surface/50 border border-border rounded-xl p-1 shrink-0">
            {['7d', '30d', '90d'].map(t => (
              <button 
                key={t}
                onClick={() => setTimeframe(t)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${timeframe === t ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
          {kpis.map((kpi, i) => (
            <motion.div
              key={kpi.label}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              className="glass-panel p-4 md:p-6 flex flex-col justify-between group hover:border-primary/30"
            >
              <div className="flex justify-between items-start mb-4">
                <div className="p-2 rounded-xl bg-white/5 text-zinc-500 group-hover:text-primary transition-colors">
                  <kpi.icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                <div className={`flex items-center gap-1 text-[10px] md:text-xs font-medium px-2 py-1 rounded-md ${
                  kpi.trend === 'up' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                }`}>
                  {kpi.trend === 'up' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                  {kpi.change}
                </div>
              </div>
              <div>
                <h3 className="text-2xl md:text-3xl font-display font-semibold text-white mb-1">{kpi.value}</h3>
                <p className="text-xs md:text-sm text-zinc-400">{kpi.label}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Main Chart Section */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="glass-panel p-4 md:p-8"
        >
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 md:mb-8">
            <div>
              <h2 className="text-base md:text-lg font-semibold text-white">Engagement Over Time</h2>
              <p className="text-[10px] md:text-xs text-zinc-500">Daily breakdown of interactions and reach.</p>
            </div>
            {selectedPlatform === 'all' && (
              <div className="flex flex-wrap gap-3 md:gap-4 text-[9px] md:text-[10px] font-bold tracking-widest uppercase">
                {PLATFORMS.filter(p => p.id !== 'all').map(p => (
                  <div key={p.id} className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 md:w-2 md:h-2 rounded-full" style={{ backgroundColor: p.color }}></div>
                    <span className="text-zinc-500">{p.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <div className="h-[250px] md:h-[350px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData as any[]} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  {PLATFORMS.map(p => (
                    <linearGradient key={p.id} id={`color${p.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={p.color} stopOpacity={0.3}/>
                      <stop offset="95%" stopColor={p.color} stopOpacity={0}/>
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="name" stroke="rgba(255,255,255,0.3)" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="rgba(255,255,255,0.3)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(value) => value >= 1000 ? `${value / 1000}k` : value} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#12121a', borderColor: 'rgba(255,255,255,0.1)', borderRadius: '12px', color: '#fff', fontSize: '12px' }}
                  itemStyle={{ color: '#fff' }}
                />
                {selectedPlatform === 'all' ? (
                  PLATFORMS.filter(p => p.id !== 'all').map(p => (
                    <Area 
                      key={p.id}
                      type="monotone" 
                      dataKey={p.id} 
                      stackId="1"
                      stroke={p.color} 
                      strokeWidth={2} 
                      fillOpacity={1} 
                      fill={`url(#color${p.id})`} 
                    />
                  ))
                ) : (
                  <Area 
                    type="monotone" 
                    dataKey={selectedPlatform} 
                    stroke={currentPlatform.color} 
                    strokeWidth={3} 
                    fillOpacity={1} 
                    fill={`url(#color${currentPlatform.id})`} 
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </motion.div>

        {/* Bottom Grid: Comparison & Top Posts */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Platform Performance Table */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="glass-panel p-6"
          >
            <h2 className="text-lg font-semibold text-white mb-6">Platform Comparison</h2>
            <div className="space-y-4">
              {platformStats.map((stat) => (
                <div key={stat.id} className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.04] transition-all group">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${stat.color}20` }}>
                      {PLATFORMS.find(p => p.id === stat.id)?.icon && (
                        <div style={{ color: stat.color }}>
                          {React.createElement(PLATFORMS.find(p => p.id === stat.id)!.icon, { className: "w-4 h-4" })}
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">{stat.name}</p>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{stat.impressions} Impressions</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-white">{stat.engagement}</p>
                    <p className="text-[10px] text-emerald-400 font-bold">{stat.growth}</p>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Top Content */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="glass-panel p-6"
          >
            <h2 className="text-lg font-semibold text-white mb-6">Top Performing Content</h2>
            <div className="space-y-4">
              {filteredContent.map((post, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.04] transition-all">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                      {PLATFORMS.find(p => p.id === post.platform)?.icon && React.createElement(PLATFORMS.find(p => p.id === post.platform)!.icon, { className: "w-4 h-4 text-zinc-400" })}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">{post.title}</p>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{post.reach} Reach</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-bold text-primary">{post.engagement}</p>
                    <p className="text-[10px] text-zinc-500">Engagement</p>
                  </div>
                </div>
              ))}
            </div>
            <button className="w-full mt-6 py-3 rounded-xl border border-white/5 text-xs font-bold text-zinc-500 hover:text-white hover:bg-white/5 transition-all uppercase tracking-widest">
              View All Content Performance
            </button>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
