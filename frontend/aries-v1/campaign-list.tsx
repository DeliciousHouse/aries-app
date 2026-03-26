'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Rocket, 
  Plus, 
  MoreVertical, 
  Play, 
  Pause, 
  Settings2,
  BarChart2,
  Clock,
  CheckCircle2,
  X,
  Linkedin
} from 'lucide-react';
import { XIcon, RedditIcon } from '../components/Icons';

const campaigns = [
  { 
    id: 1, 
    name: 'Q4 Product Launch', 
    status: 'active', 
    platforms: ['linkedin', 'twitter'], 
    progress: 45, 
    totalPosts: 12, 
    completedPosts: 5,
    nextPost: 'Today, 2:00 PM'
  },
  { 
    id: 2, 
    name: 'Weekly Founder Thoughts', 
    status: 'active', 
    platforms: ['linkedin'], 
    progress: 80, 
    totalPosts: 5, 
    completedPosts: 4,
    nextPost: 'Tomorrow, 9:00 AM'
  },
  { 
    id: 3, 
    name: 'Black Friday Promo', 
    status: 'paused', 
    platforms: ['twitter', 'reddit'], 
    progress: 0, 
    totalPosts: 20, 
    completedPosts: 0,
    nextPost: 'Paused'
  },
];

export default function AriesCampaignListScreen() {
  const [selectedCampaign, setSelectedCampaign] = useState<number | null>(null);

  const getCampaignById = (id: number) => campaigns.find(c => c.id === id);
  const activeCampaign = selectedCampaign ? getCampaignById(selectedCampaign) : null;

  return (
    <div className="space-y-6 md:space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 md:gap-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-display font-semibold tracking-tight text-white mb-1 md:mb-2">Campaigns</h1>
          <p className="text-xs md:text-sm text-text-muted">Manage your automated content flows.</p>
        </div>
        <button className="w-full sm:w-auto bg-primary hover:bg-primary/90 text-white px-4 md:px-6 py-2 md:py-2.5 rounded-xl font-medium transition-all duration-300 flex items-center justify-center gap-2 neon-glow shadow-[0_0_20px_rgba(123,97,255,0.3)]">
          <Plus className="w-4 h-4" />
          <span className="text-sm md:text-base">New Campaign</span>
        </button>
      </div>

      {/* Campaigns Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {campaigns.map((campaign, i) => (
          <motion.div
            key={campaign.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            onClick={() => setSelectedCampaign(campaign.id)}
            className="glass-panel p-6 cursor-pointer group hover:border-primary/30 transition-all duration-300"
          >
            <div className="flex justify-between items-start mb-6">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${campaign.status === 'active' ? 'bg-primary/10 text-primary' : 'bg-white/5 text-text-muted'}`}>
                  <Rocket className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white group-hover:text-primary transition-colors">{campaign.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`w-2 h-2 rounded-full ${campaign.status === 'active' ? 'bg-emerald-400 neon-glow' : 'bg-text-muted'}`}></span>
                    <span className="text-xs text-text-muted capitalize">{campaign.status}</span>
                  </div>
                </div>
              </div>
              <button className="p-2 text-text-muted hover:text-white transition-colors rounded-lg hover:bg-white/5" onClick={(e) => e.stopPropagation()}>
                <MoreVertical className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-xs mb-2">
                  <span className="text-text-muted">Progress</span>
                  <span className="text-white font-medium">{campaign.completedPosts} / {campaign.totalPosts} posts</span>
                </div>
                <div className="w-full h-1.5 bg-surface rounded-full overflow-hidden">
                  <div 
                    className={`h-full rounded-full ${campaign.status === 'active' ? 'bg-gradient-to-r from-primary to-secondary' : 'bg-text-muted'}`}
                    style={{ width: `${campaign.progress}%` }}
                  ></div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-border/50">
                <div className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-text-muted" />
                  <span className="text-xs text-text-muted">{campaign.nextPost}</span>
                </div>
                <div className="flex -space-x-2">
                  {campaign.platforms.map((platform, idx) => (
                    <div key={platform} className={`w-6 h-6 rounded-full border-2 border-background flex items-center justify-center z-${10-idx} ${platform === 'linkedin' ? 'bg-[#0077b5]' : platform === 'twitter' ? 'bg-black' : 'bg-[#FF4500]'}`}>
                      {platform === 'linkedin' ? (
                        <Linkedin className="w-3 h-3 text-white" />
                      ) : platform === 'twitter' ? (
                        <XIcon className="w-3 h-3 text-white" />
                      ) : (
                        <RedditIcon className="w-3 h-3 text-white" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Campaign Detail Modal/Panel */}
      <AnimatePresence>
        {selectedCampaign && activeCampaign && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedCampaign(null)}
              className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="fixed inset-0 md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 w-full md:max-w-3xl h-full md:max-h-[85vh] bg-surface border-0 md:border md:border-border md:rounded-2xl z-50 shadow-2xl flex flex-col overflow-hidden"
            >
              {/* Modal Header */}
              <div className="p-4 md:p-6 border-b border-border flex items-start justify-between bg-white/[0.02]">
                <div className="flex items-center gap-3 md:gap-4">
                  <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center neon-glow">
                    <Rocket className="w-5 h-5 md:w-6 md:h-6" />
                  </div>
                  <div>
                    <h2 className="text-xl md:text-2xl font-display font-semibold text-white">{activeCampaign.name}</h2>
                    <div className="flex flex-wrap items-center gap-2 md:gap-3 mt-1 text-xs md:text-sm text-text-muted">
                      <span className="flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-emerald-400" /> {activeCampaign.status === 'active' ? 'Active' : 'Paused'}</span>
                      <span className="hidden sm:inline">•</span>
                      <span>{activeCampaign.totalPosts} Posts Total</span>
                      <span className="hidden sm:inline">•</span>
                      <span>Ends Nov 30</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 md:gap-2">
                  <button className="p-2 bg-white/5 hover:bg-white/10 rounded-lg text-white transition-colors">
                    {activeCampaign.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  </button>
                  <button className="p-2 bg-white/5 hover:bg-white/10 rounded-lg text-white transition-colors">
                    <Settings2 className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => setSelectedCampaign(null)}
                    className="p-2 hover:bg-white/5 rounded-lg text-text-muted hover:text-white transition-colors ml-1 md:ml-2"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-4 md:p-6">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-6 mb-8">
                  <div className="glass-panel p-4 flex flex-col items-center justify-center text-center">
                    <BarChart2 className="w-5 h-5 text-primary mb-2" />
                    <span className="text-2xl font-semibold text-white">{activeCampaign.progress}%</span>
                    <span className="text-xs text-text-muted">Completion</span>
                  </div>
                  <div className="glass-panel p-4 flex flex-col items-center justify-center text-center">
                    <Rocket className="w-5 h-5 text-secondary mb-2" />
                    <span className="text-2xl font-semibold text-white">{activeCampaign.completedPosts}</span>
                    <span className="text-xs text-text-muted">Published</span>
                  </div>
                  <div className="glass-panel p-4 flex flex-col items-center justify-center text-center">
                    <Clock className="w-5 h-5 text-accent mb-2" />
                    <span className="text-2xl font-semibold text-white">{activeCampaign.totalPosts - activeCampaign.completedPosts}</span>
                    <span className="text-xs text-text-muted">Queued</span>
                  </div>
                </div>

                <h3 className="text-lg font-semibold text-white mb-4">Timeline</h3>
                <div className="space-y-8 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px lg:before:mx-auto lg:before:translate-x-0 before:h-full before:w-[1px] before:bg-white/10">
                  
                  {/* Timeline Item 1 */}
                  <div className="relative flex items-center justify-between lg:justify-normal lg:odd:flex-row-reverse group">
                    <div className="flex items-center justify-center w-10 min-w-[2.5rem] h-10 rounded-full border-4 border-[#0a0a0f] bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.3)] shrink-0 lg:order-1 lg:group-odd:-translate-x-1/2 lg:group-even:translate-x-1/2 z-10 transition-transform group-hover:scale-110">
                      <CheckCircle2 className="w-5 h-5" />
                    </div>
                    <div className="w-[calc(100%-4rem)] lg:w-[calc(50%-2.5rem)] glass-panel p-5 border-white/5 group-hover:border-emerald-500/20 transition-all">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-emerald-400">Published</span>
                        <span className="text-xs text-white/30">Oct 1, 10:00 AM</span>
                      </div>
                      <h4 className="text-base font-semibold text-white mb-1">Teaser Announcement</h4>
                      <p className="text-sm text-white/50 line-clamp-2 leading-relaxed">Something big is coming. We&apos;ve been working on this for 6 months and it changes everything about how you manage...</p>
                    </div>
                  </div>

                  {/* Timeline Item 2 */}
                  <div className="relative flex items-center justify-between lg:justify-normal lg:odd:flex-row-reverse group">
                    <div className="flex items-center justify-center w-10 min-w-[2.5rem] h-10 rounded-full border-4 border-[#0a0a0f] bg-primary text-white shadow-[0_0_20px_rgba(124,58,237,0.4)] shrink-0 lg:order-1 lg:group-odd:-translate-x-1/2 lg:group-even:translate-x-1/2 z-10 transition-transform group-hover:scale-110">
                      <Clock className="w-5 h-5" />
                    </div>
                    <div className="w-[calc(100%-4rem)] lg:w-[calc(50%-2.5rem)] glass-panel p-5 border-primary/30 bg-primary/5 shadow-[0_0_30px_rgba(124,58,237,0.05)]">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-primary">Up Next</span>
                        <span className="text-xs text-white/30">Today, 2:00 PM</span>
                      </div>
                      <h4 className="text-base font-semibold text-white mb-1">Feature Deep Dive: AI</h4>
                      <p className="text-sm text-white/50 line-clamp-2 leading-relaxed">Let&apos;s talk about the AI engine powering our new release. It&apos;s not just a wrapper, it&apos;s a fundamental rethink of...</p>
                      <button className="mt-4 text-sm font-semibold text-primary hover:text-secondary transition-colors underline-offset-4 hover:underline">Edit Content →</button>
                    </div>
                  </div>

                  {/* Timeline Item 3 */}
                  <div className="relative flex items-center justify-between lg:justify-normal lg:odd:flex-row-reverse group">
                    <div className="flex items-center justify-center w-10 min-w-[2.5rem] h-10 rounded-full border-4 border-[#0a0a0f] bg-white/5 text-white/20 shadow-none shrink-0 lg:order-1 lg:group-odd:-translate-x-1/2 lg:group-even:translate-x-1/2 z-10 transition-transform group-hover:scale-110">
                      <div className="w-2.5 h-2.5 rounded-full bg-white/20"></div>
                    </div>
                    <div className="w-[calc(100%-4rem)] lg:w-[calc(50%-2.5rem)] glass-panel p-5 border-white/5 opacity-60">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-white/40">Draft</span>
                        <span className="text-xs text-white/30">Oct 10, 9:00 AM</span>
                      </div>
                      <h4 className="text-base font-semibold text-white mb-1">Customer Story</h4>
                      <p className="text-sm text-white/50 italic leading-relaxed">AI will generate this content based on the case study uploaded...</p>
                    </div>
                  </div>

                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
