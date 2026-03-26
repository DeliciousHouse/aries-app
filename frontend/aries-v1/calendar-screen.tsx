'use client';

import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ChevronLeft, 
  ChevronRight, 
  Plus,
  Linkedin,
  Instagram,
  Youtube,
  Clock,
  X as CloseIcon,
  Calendar as CalendarIcon,
  Timer,
  Monitor,
  Smartphone,
  Send,
  RefreshCw,
  Edit3,
  Image as ImageIcon
} from 'lucide-react';
import { XIcon } from '../components/Icons';
import { 
  format, 
  addMonths, 
  subMonths, 
  startOfMonth, 
  endOfMonth, 
  startOfWeek, 
  endOfWeek, 
  eachDayOfInterval, 
  isSameDay, 
  isToday, 
  addWeeks, 
  subWeeks,
  parseISO,
  setHours,
  setMinutes,
  isPast,
  isFuture,
  subDays,
  addDays
} from 'date-fns';

interface Post {
  id: string;
  title: string;
  description?: string;
  content?: string;
  image?: string;
  platform: 'LinkedIn' | 'Instagram' | 'X' | 'YouTube' | 'Facebook';
  status: 'PUBLISHED' | 'SCHEDULED' | 'DRAFT';
  scheduledAt: Date;
}

const PLATFORMS: Post['platform'][] = ['LinkedIn', 'Instagram', 'X', 'YouTube', 'Facebook'];

const MOCK_TITLES = [
  'Q1 Growth Strategy',
  'Product Feature Teaser',
  'Community Spotlight',
  'Weekly Market Insights',
  'Customer Success Story',
  'Behind the Scenes',
  'New Integration Launch',
  'Expert Webinar Series',
  'Industry Trend Report',
  'Interactive Poll'
];

const generateMockPosts = (): Post[] => {
  const posts: Post[] = [];
  const start = subWeeks(new Date(), 2);
  const end = addWeeks(new Date(), 2);
  const days = eachDayOfInterval({ start, end });

  days.forEach((day, dayIdx) => {
    const numPosts = Math.floor(Math.random() * 4) + 2; // 2 to 5 posts
    for (let i = 0; i < numPosts; i++) {
      const hour = 9 + Math.floor(Math.random() * 10);
      const minute = Math.random() > 0.5 ? 0 : 30;
      const scheduledAt = setMinutes(setHours(day, hour), minute);
      
      let status: Post['status'] = 'SCHEDULED';
      if (isPast(scheduledAt) && !isToday(day)) {
        status = 'PUBLISHED';
      } else if (isToday(day)) {
        status = Math.random() > 0.5 ? 'PUBLISHED' : 'SCHEDULED';
      }

      const titleIndex = (dayIdx + i) % MOCK_TITLES.length;
      posts.push({
        id: `mock-${dayIdx}-${i}`,
        title: MOCK_TITLES[titleIndex],
        description: `Strategic content for ${PLATFORMS[i % PLATFORMS.length]} focusing on growth and engagement.`,
        content: `Exciting news from the team! We're launching new features to help you scale faster. Check out the link in bio! #Growth #Innovation #${PLATFORMS[i % PLATFORMS.length].replace(/\s/g, '')}`,
        platform: PLATFORMS[i % PLATFORMS.length],
        status,
        scheduledAt,
      });
    }
  });

  return posts;
};

const INITIAL_POSTS = generateMockPosts();

const PLATFORM_COLORS = {
  'LinkedIn': 'border-blue-500/40 text-blue-400 bg-blue-500/5',
  'Instagram': 'border-pink-500/40 text-pink-400 bg-pink-500/5',
  'X': 'border-zinc-400/40 text-zinc-300 bg-zinc-400/5',
  'YouTube': 'border-red-500/40 text-red-400 bg-red-500/5',
  'Facebook': 'border-indigo-500/40 text-indigo-400 bg-indigo-500/5',
};

const STATUS_COLORS = {
  'PUBLISHED': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  'SCHEDULED': 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  'DRAFT': 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
};

export default function AriesCalendarScreen() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<'week' | 'month'>('week');
  const [posts, setPosts] = useState<Post[]>(INITIAL_POSTS);
  
  // Modal States
  const [activeModal, setActiveModal] = useState<'create' | 'generate' | 'preview' | null>(null);
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [generatingPost, setGeneratingPost] = useState<Partial<Post> & { platforms?: Post['platform'][] }>({});
  
  // Form States
  const [newPostDate, setNewPostDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [newPostTime, setNewPostTime] = useState('12:00');
  const [newPostTitle, setNewPostTitle] = useState('');
  const [newPostDescription, setNewPostDescription] = useState('');
  const [newPostPlatform, setNewPostPlatform] = useState<Post['platform']>('LinkedIn');
  
  // Generation States
  const [previewMode, setPreviewMode] = useState<'mobile' | 'desktop'>('mobile');
  const [aiFeedback, setAiFeedback] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);

  const calendarDays = useMemo(() => {
    const weekStartsOn = view === 'month' ? 0 : 1;
    const start = view === 'month' 
      ? startOfWeek(startOfMonth(currentDate), { weekStartsOn }) 
      : startOfWeek(currentDate, { weekStartsOn });
    const end = view === 'month' 
      ? endOfWeek(endOfMonth(currentDate), { weekStartsOn }) 
      : endOfWeek(currentDate, { weekStartsOn });
    
    return eachDayOfInterval({ start, end });
  }, [currentDate, view]);

  const next = () => {
    setCurrentDate(view === 'month' ? addMonths(currentDate, 1) : addWeeks(currentDate, 1));
  };

  const prev = () => {
    setCurrentDate(view === 'month' ? subMonths(currentDate, 1) : subWeeks(currentDate, 1));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const handleCreatePost = (date?: Date) => {
    if (date) {
      setNewPostDate(format(date, 'yyyy-MM-dd'));
    }
    setNewPostTitle('');
    setNewPostDescription('');
    setActiveModal('create');
  };

  const handlePostClick = (post: Post) => {
    setSelectedPost(post);
    setActiveModal('preview');
  };

  const startGeneration = () => {
    const [hours, minutes] = newPostTime.split(':').map(Number);
    const scheduledAt = setMinutes(setHours(parseISO(newPostDate), hours), minutes);
    
    setUploadedImage(null);
    setGeneratingPost({
      title: newPostTitle,
      description: newPostDescription,
      platform: newPostPlatform,
      scheduledAt,
      content: `Here is a generated post for ${newPostPlatform} based on your description: "${newPostDescription}". It includes relevant hashtags and a call to action. #Generated #NorthstarStudio`,
    });
    setActiveModal('generate');
  };

  const handleAiFeedback = async () => {
    if (!aiFeedback.trim()) return;
    setIsGenerating(true);
    // Simulate AI generation delay
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    setGeneratingPost(prev => ({
      ...prev,
      content: `[Updated based on feedback: ${aiFeedback}]\n\n${prev.content}`,
    }));
    setAiFeedback('');
    setIsGenerating(false);
  };

  const finalizePost = (status: 'PUBLISHED' | 'SCHEDULED') => {
    const [hours, minutes] = newPostTime.split(':').map(Number);
    const scheduledAt = setMinutes(setHours(parseISO(newPostDate), hours), minutes);

    const selectedPlatforms = generatingPost.platforms?.length 
      ? generatingPost.platforms 
      : [generatingPost.platform || 'LinkedIn'];

    // If we are editing an existing scheduled post (and not adding more platforms)
    if (selectedPost && selectedPost.status === 'SCHEDULED' && selectedPlatforms.length === 1 && selectedPlatforms[0] === selectedPost.platform) {
      const updatedPost: Post = {
        ...selectedPost,
        title: generatingPost.title || 'Untitled Post',
        description: generatingPost.description,
        content: generatingPost.content,
        status,
        scheduledAt,
      };
      setPosts(posts.map(p => p.id === selectedPost.id ? updatedPost : p));
    } else {
      // Reposting or creating new (potentially multiple)
      const newPosts: Post[] = selectedPlatforms.map(plat => ({
        id: Math.random().toString(36).substr(2, 9),
        title: generatingPost.title || 'Untitled Post',
        description: generatingPost.description,
        content: generatingPost.content,
        platform: plat as Post['platform'],
        status,
        scheduledAt,
      }));
      setPosts([...posts, ...newPosts]);
    }
    
    setActiveModal(null);
    setSelectedPost(null);
    setGeneratingPost({});
  };

  const handleRepost = (post: Post) => {
    setGeneratingPost({
      ...post,
      status: 'SCHEDULED',
      platforms: [post.platform],
      scheduledAt: addWeeks(new Date(), 1),
    });
    setNewPostDate(format(addWeeks(new Date(), 1), 'yyyy-MM-dd'));
    setNewPostTime(format(addWeeks(new Date(), 1), 'HH:mm'));
    setActiveModal('generate');
  };

  const handleEditScheduled = (post: Post) => {
    setGeneratingPost({
      ...post,
      platforms: [post.platform]
    });
    setNewPostDate(format(post.scheduledAt, 'yyyy-MM-dd'));
    setNewPostTime(format(post.scheduledAt, 'HH:mm'));
    setActiveModal('generate');
  };

  const PlatformIcon = ({ platform, className }: { platform: Post['platform'], className?: string }) => {
    switch (platform) {
      case 'LinkedIn': return <Linkedin className={className} />;
      case 'Instagram': return <Instagram className={className} />;
      case 'YouTube': return <Youtube className={className} />;
      case 'X': return <XIcon className={className} />;
      default: return <Plus className={className} />;
    }
  };

  return (
    <div className="h-full bg-[#050505] text-white p-4 md:p-8 font-sans relative overflow-hidden flex flex-col grid-viewport">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 relative z-10 shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 md:gap-6">
          <h1 className="text-xl md:text-3xl font-medium tracking-tight min-w-[150px] md:min-w-[240px]">
            {format(currentDate, 'MMMM yyyy')}
          </h1>
          <div className="flex items-center gap-2">
            <button onClick={prev} className="p-1.5 md:p-2 hover:bg-white/5 rounded-lg border border-white/10 transition-colors">
              <ChevronLeft className="w-4 h-4 md:w-5 md:h-5" />
            </button>
            <button onClick={goToToday} className="px-3 md:px-6 py-1.5 md:py-2 hover:bg-white/5 rounded-lg border border-white/10 transition-colors font-medium text-xs md:text-base">
              Today
            </button>
            <button onClick={next} className="p-1.5 md:p-2 hover:bg-white/5 rounded-lg border border-white/10 transition-colors">
              <ChevronRight className="w-4 h-4 md:w-5 md:h-5" />
            </button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 md:gap-4">
          <div className="flex bg-[#111] p-1 rounded-xl border border-white/5">
            <button 
              onClick={() => setView('week')}
              className={`flex-1 sm:flex-none px-3 md:px-6 py-1.5 md:py-2 rounded-lg text-xs md:text-sm font-medium transition-all ${view === 'week' ? 'bg-[#222] text-white shadow-lg' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Week
            </button>
            <button 
              onClick={() => setView('month')}
              className={`flex-1 sm:flex-none px-3 md:px-6 py-1.5 md:py-2 rounded-lg text-xs md:text-sm font-medium transition-all ${view === 'month' ? 'bg-[#222] text-white shadow-lg' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Month
            </button>
          </div>
          <button 
            onClick={() => handleCreatePost()}
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 md:px-8 py-2 md:py-2.5 rounded-xl font-medium transition-all shadow-[0_0_20px_rgba(79,70,229,0.3)] flex items-center justify-center gap-2 text-sm md:text-base"
          >
            <Plus className="w-4 h-4" />
            New Post
          </button>
        </div>
      </div>

      {/* Calendar Grid */}
      <div className="relative z-10 flex-1 flex flex-col min-h-0 overflow-x-auto no-scrollbar -mx-4 px-4 lg:mx-0 lg:px-0">
        <motion.div 
          key={view}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="min-w-[900px] lg:min-w-0 flex-1 flex flex-col"
        >
          {/* Days of Week Header */}
          <div className="grid grid-cols-7 mb-6 shrink-0">
            {(view === 'month' 
              ? ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] 
              : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
            ).map(day => (
              <div key={day} className="text-center text-[8px] md:text-[10px] font-bold text-zinc-600 tracking-[0.2em] md:tracking-[0.3em]">
                {day}
              </div>
            ))}
          </div>

          {/* Dates Grid */}
          <div className={`grid grid-cols-7 flex-1 min-h-0 ${view === 'month' ? 'gap-px bg-white/[0.05] border border-white/[0.05] grid-rows-5' : 'gap-2 md:gap-4 grid-rows-1'}`}>
          {calendarDays.map((day, idx) => {
            const dayPosts = posts.filter(p => isSameDay(p.scheduledAt, day));
            const active = isToday(day);
            const isCurrentMonth = view === 'month' ? day.getMonth() === currentDate.getMonth() : true;

            if (view === 'month') {
              return (
                <div 
                  key={idx} 
                  className={`flex flex-col p-3 bg-[#050505] relative transition-all group ${!isCurrentMonth ? 'opacity-30' : ''} ${active ? 'bg-indigo-500/[0.02]' : ''}`}
                >
                  {/* Date Number */}
                  <div className="flex items-start justify-between mb-4">
                    <span className={`text-sm font-medium ${active ? 'text-indigo-400' : 'text-zinc-500'}`}>
                      {format(day, 'd')}
                    </span>
                    {active && (
                      <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(79,70,229,0.8)]" />
                    )}
                  </div>

                  {/* Posts for this day */}
                  <div className="w-full space-y-1 overflow-y-auto custom-scrollbar flex-1 pr-1">
                    {dayPosts.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()).map(post => (
                      <div 
                        key={post.id}
                        onClick={() => handlePostClick(post)}
                        className={`px-2 py-1 rounded border text-[8px] font-bold truncate cursor-pointer transition-all hover:bg-white/[0.05] border-l-2 flex items-center gap-1.5 ${PLATFORM_COLORS[post.platform]}`}
                      >
                        <PlatformIcon platform={post.platform} className="w-2.5 h-2.5 shrink-0 opacity-70" />
                        <span className="truncate">{post.title}</span>
                      </div>
                    ))}

                    <button 
                      onClick={() => handleCreatePost(day)}
                      className="w-full h-5 rounded border border-dashed border-zinc-900 hover:border-zinc-700 hover:bg-white/[0.02] flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 mt-1"
                    >
                      <Plus className="w-2.5 h-2.5 text-zinc-700" />
                    </button>
                  </div>

                  {active && (
                    <div className="absolute inset-0 border border-indigo-500/30 pointer-events-none" />
                  )}
                </div>
              );
            }

            // Weekly View (Detailed)
            return (
              <div key={idx} className={`flex flex-col items-center p-1 md:p-2 rounded-2xl border border-white/[0.03] bg-white/[0.01] overflow-hidden`}>
                {/* Date Circle */}
                <div className="mb-2 md:mb-4 relative shrink-0">
                  {active && (
                    <div 
                      className="absolute inset-0 bg-indigo-600 blur-lg opacity-40 rounded-full scale-125"
                    />
                  )}
                  <div className={`w-7 h-7 md:w-8 md:h-8 rounded-full flex items-center justify-center text-xs md:text-sm font-medium relative z-10 transition-all ${active ? 'bg-indigo-600 text-white shadow-[0_0_10px_rgba(79,70,229,0.5)]' : 'text-zinc-50'}`}>
                    {format(day, 'd')}
                  </div>
                </div>

                {/* Posts for this day */}
                <div className="w-full space-y-2 md:space-y-4 overflow-y-auto custom-scrollbar flex-1 pr-0.5 md:pr-1 py-2 md:py-4 mt-1 md:mt-2">
                  {dayPosts.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()).map(post => (
                    <div 
                      key={post.id}
                      onClick={() => handlePostClick(post)}
                      className={`p-2 md:p-4 rounded-xl md:rounded-2xl border bg-[#0a0a0a]/80 backdrop-blur-sm transition-all hover:scale-[1.02] cursor-pointer min-h-[100px] md:min-h-[120px] flex flex-col justify-between shadow-lg ${PLATFORM_COLORS[post.platform]}`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[8px] md:text-[10px] font-mono opacity-70">
                          {format(post.scheduledAt, 'HH:mm')}
                        </span>
                        <span className={`text-[6px] md:text-[7px] px-1.5 md:px-2 py-0.5 rounded-full border font-bold tracking-wider uppercase whitespace-nowrap ${STATUS_COLORS[post.status]}`}>
                          {post.status === 'PUBLISHED' ? 'Pub' : 'Sch'}
                        </span>
                      </div>
                      <h3 className="text-[9px] md:text-[11px] font-bold text-white mb-1 md:mb-1.5 line-clamp-2 leading-tight">
                        {post.title}
                      </h3>
                      <div className="flex items-center gap-1 md:gap-1.5 opacity-60">
                        <PlatformIcon platform={post.platform} className="w-2 md:w-2.5 h-2 md:h-2.5" />
                        <span className="text-[7px] md:text-[8px] font-bold uppercase tracking-widest truncate">{post.platform}</span>
                      </div>
                    </div>
                  ))}

                  {/* Add Post Button */}
                  <button 
                    onClick={() => handleCreatePost(day)}
                    className="w-full h-8 rounded-lg border border-dashed border-zinc-800 hover:border-zinc-600 hover:bg-white/[0.02] flex items-center justify-center transition-all group shrink-0"
                  >
                    <Plus className="w-3 h-3 text-zinc-700 group-hover:text-zinc-500" />
                  </button>
                </div>
              </div>
            );
          })}
          </div>
        </motion.div>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {/* Create Post Modal */}
        {activeModal === 'create' && (
          <div className="fixed inset-0 z-50 flex items-center justify-center md:p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setActiveModal(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative w-full h-full md:h-auto md:max-w-lg bg-[#0a0a0a] border-0 md:border md:border-white/10 rounded-none md:rounded-3xl overflow-hidden shadow-2xl"
            >
              <div className="p-6 md:p-8">
                <div className="flex items-center justify-between mb-8">
                  <h2 className="text-2xl font-medium text-white">Create New Post</h2>
                  <button onClick={() => setActiveModal(null)} className="p-2 hover:bg-white/5 rounded-full transition-colors">
                    <CloseIcon className="w-5 h-5 text-zinc-500" />
                  </button>
                </div>

                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-zinc-500 tracking-widest uppercase">Post Title</label>
                    <input 
                      type="text" 
                      value={newPostTitle}
                      onChange={(e) => setNewPostTitle(e.target.value)}
                      placeholder="Enter post title..."
                      className="w-full bg-[#111] border border-white/5 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-bold text-zinc-500 tracking-widest uppercase">Description</label>
                    <textarea 
                      value={newPostDescription}
                      onChange={(e) => setNewPostDescription(e.target.value)}
                      placeholder="What is this post about?"
                      className="w-full bg-[#111] border border-white/5 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors h-24 resize-none"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-bold text-zinc-500 tracking-widest uppercase">Platform</label>
                    <div className="grid grid-cols-3 gap-2">
                      {(['LinkedIn', 'Instagram', 'X', 'YouTube', 'Facebook'] as const).map(p => (
                        <button
                          key={p}
                          onClick={() => setNewPostPlatform(p)}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-[10px] font-medium transition-all ${newPostPlatform === p ? 'bg-indigo-600/10 border-indigo-500 text-white' : 'bg-[#111] border-white/5 text-zinc-500 hover:text-zinc-300'}`}
                        >
                          <PlatformIcon platform={p} className="w-3 h-3" />
                          {p.split(' ')[0]}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-zinc-500 tracking-widest uppercase">Date</label>
                      <input 
                        type="date" 
                        value={newPostDate}
                        onChange={(e) => setNewPostDate(e.target.value)}
                        className="w-full bg-[#111] border border-white/5 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors [color-scheme:dark]"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-zinc-500 tracking-widest uppercase">Time</label>
                      <input 
                        type="time" 
                        value={newPostTime}
                        onChange={(e) => setNewPostTime(e.target.value)}
                        className="w-full bg-[#111] border border-white/5 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors [color-scheme:dark]"
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-10">
                  <button 
                    onClick={startGeneration}
                    className="w-full py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-all shadow-[0_0_20px_rgba(79,70,229,0.3)] flex items-center justify-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Generate Content
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {/* Generation / Preview Modal */}
        {activeModal === 'generate' && (
          <div className="fixed inset-0 z-50 flex items-center justify-center md:p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setActiveModal(null);
                setUploadedImage(null);
              }}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative w-full h-full md:h-[90vh] md:max-w-6xl bg-[#0a0a0a] border-0 md:border md:border-white/10 rounded-none md:rounded-3xl overflow-hidden shadow-2xl flex flex-col"
            >
              <div className="p-4 md:p-6 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-4 md:gap-6">
                  <h2 className="text-lg md:text-xl font-medium truncate max-w-[150px] md:max-w-[300px]">
                    {generatingPost.title 
                      ? (generatingPost.title.split(' ').slice(0, 6).join(' ') + (generatingPost.title.split(' ').length > 6 ? '...' : ''))
                      : 'Post Configuration'}
                  </h2>
                  <div className="flex bg-[#111] p-1 rounded-lg border border-white/5">
                    <button 
                      onClick={() => setPreviewMode('mobile')}
                      className={`p-1.5 rounded-md transition-all ${previewMode === 'mobile' ? 'bg-[#222] text-white' : 'text-zinc-500'}`}
                    >
                      <Smartphone className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => setPreviewMode('desktop')}
                      className={`p-1.5 rounded-md transition-all ${previewMode === 'desktop' ? 'bg-[#222] text-white' : 'text-zinc-500'}`}
                    >
                      <Monitor className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 md:gap-4">
                  <div className="hidden sm:flex items-center gap-2 bg-[#111] px-3 py-1.5 rounded-lg border border-white/5">
                    <CalendarIcon className="w-3.5 h-3.5 text-zinc-500" />
                    <input 
                      type="date" 
                      value={newPostDate}
                      onChange={(e) => setNewPostDate(e.target.value)}
                      className="bg-transparent text-xs text-white focus:outline-none [color-scheme:dark]"
                    />
                    <div className="w-px h-3 bg-white/10 mx-1" />
                    <Clock className="w-3.5 h-3.5 text-zinc-500" />
                    <input 
                      type="time" 
                      value={newPostTime}
                      onChange={(e) => setNewPostTime(e.target.value)}
                      className="bg-transparent text-xs text-white focus:outline-none [color-scheme:dark]"
                    />
                  </div>
                  <button onClick={() => {
                    setActiveModal(null);
                    setUploadedImage(null);
                  }} className="p-2 hover:bg-white/5 rounded-full transition-colors">
                    <CloseIcon className="w-5 h-5 text-zinc-500" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
                {/* Left Sidebar: Platform Multi-select */}
                <div className="w-full lg:w-64 border-b lg:border-b-0 lg:border-r border-white/5 bg-[#0a0a0a] p-4 md:p-6 flex flex-col gap-4 md:gap-6 overflow-x-auto lg:overflow-y-auto no-scrollbar">
                  <div className="flex lg:flex-col gap-4 lg:gap-6 min-w-max lg:min-w-0">
                    <div className="shrink-0 lg:shrink">
                      <h3 className="text-[10px] font-bold text-zinc-500 tracking-widest uppercase mb-3 lg:mb-4">Platforms</h3>
                      <div className="flex lg:flex-col gap-2">
                        {PLATFORMS.map(p => {
                          const isSelected = generatingPost.platforms?.includes(p);
                          return (
                            <button
                              key={p}
                              onClick={() => {
                                const current = generatingPost.platforms || [];
                                const next = isSelected 
                                  ? current.filter(item => item !== p)
                                  : [...current, p];
                                setGeneratingPost(prev => ({ ...prev, platforms: next }));
                              }}
                              className={`flex items-center justify-between px-3 py-2 lg:px-4 lg:py-3 rounded-xl border transition-all ${isSelected ? 'bg-indigo-600/10 border-indigo-500 text-white' : 'bg-[#111] border-white/5 text-zinc-500 hover:border-white/20'}`}
                            >
                              <div className="flex items-center gap-2 lg:gap-3">
                                <PlatformIcon platform={p} className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
                                <span className="text-[10px] lg:text-xs font-medium">{p}</span>
                              </div>
                              {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(79,70,229,0.8)]" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="shrink-0 lg:shrink">
                      <h3 className="text-[10px] font-bold text-zinc-500 tracking-widest uppercase mb-3 lg:mb-4">Media</h3>
                      <input 
                        type="file" 
                        id="post-image-upload" 
                        className="hidden" 
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            const reader = new FileReader();
                            reader.onloadend = () => {
                              setUploadedImage(reader.result as string);
                            };
                            reader.readAsDataURL(file);
                          }
                        }}
                      />
                      <label 
                        htmlFor="post-image-upload"
                        className="flex items-center gap-2 lg:gap-3 px-3 py-2 lg:px-4 lg:py-3 rounded-xl border border-white/5 bg-[#111] text-zinc-500 hover:border-white/20 hover:text-white transition-all cursor-pointer"
                      >
                        <ImageIcon className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
                        <span className="text-[10px] lg:text-xs font-medium">Upload Image</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Preview Area */}
                <div className="flex-1 bg-[#050505] p-4 md:p-8 lg:p-12 lg:pt-20 overflow-y-auto flex flex-col items-center gap-6 md:gap-8">
                  <div className="sm:hidden w-full space-y-4 mb-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Date</label>
                        <input 
                          type="date" 
                          value={newPostDate}
                          onChange={(e) => setNewPostDate(e.target.value)}
                          className="w-full bg-[#111] border border-white/5 rounded-lg px-3 py-2 text-xs text-white focus:outline-none [color-scheme:dark]"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Time</label>
                        <input 
                          type="time" 
                          value={newPostTime}
                          onChange={(e) => setNewPostTime(e.target.value)}
                          className="w-full bg-[#111] border border-white/5 rounded-lg px-3 py-2 text-xs text-white focus:outline-none [color-scheme:dark]"
                        />
                      </div>
                    </div>
                  </div>

                  {(generatingPost.platforms?.length ? generatingPost.platforms : [generatingPost.platform]).map((plat, pIdx) => (
                    <div key={plat || pIdx} className={`transition-all duration-500 ${previewMode === 'mobile' ? 'w-full max-w-[320px]' : 'w-full max-w-2xl'}`}>
                      <div className="bg-[#111] rounded-2xl border border-white/5 overflow-hidden shadow-xl">
                        <div className="p-4 border-b border-white/5 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold">N</div>
                            <div>
                              <p className="text-xs font-bold">Northstar Studio</p>
                              <p className="text-[10px] text-zinc-500">Preview • {plat}</p>
                            </div>
                          </div>
                          <div className={`px-2 py-0.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-[8px] font-bold text-indigo-400 uppercase tracking-wider`}>
                            AI Optimized
                          </div>
                        </div>
                        <div className="p-4">
                          <textarea 
                            value={generatingPost.content}
                            onChange={(e) => setGeneratingPost(prev => ({ ...prev, content: e.target.value }))}
                            className="w-full bg-transparent text-sm leading-relaxed focus:outline-none resize-none min-h-[150px] md:min-h-[200px]"
                            placeholder={`Write your ${plat} content here...`}
                          />
                        </div>
                        {uploadedImage ? (
                          <div className="aspect-video w-full overflow-hidden border-t border-white/5">
                            <img 
                              src={uploadedImage} 
                              alt="Post Preview" 
                              className="w-full h-full object-cover"
                              referrerPolicy="no-referrer"
                            />
                          </div>
                        ) : (
                          <div className="aspect-video bg-zinc-900 flex items-center justify-center text-zinc-700 border-t border-white/5 text-xs font-medium">
                            Media Preview for {plat}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Feedback Area */}
                <div className="w-full lg:w-96 border-t lg:border-t-0 lg:border-l border-white/5 bg-[#0a0a0a] p-6 md:p-8 flex flex-col">
                  <h3 className="text-xs font-bold text-zinc-500 tracking-widest uppercase mb-4 md:mb-6">AI Assistant</h3>
                  <div className="flex-1 overflow-y-auto space-y-4 md:space-y-6 mb-4 md:mb-6 max-h-[200px] lg:max-h-none">
                    <div className="bg-[#111] rounded-2xl p-4 text-sm text-zinc-400 leading-relaxed border border-white/5">
                      I've crafted this post for your {generatingPost.platform} audience. It focuses on the key themes from your description.
                      <br /><br />
                      Need changes? Just tell me what to adjust.
                    </div>
                    {isGenerating && (
                      <div className="flex items-center gap-3 text-indigo-400 text-sm font-medium">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Refining content...
                      </div>
                    )}
                  </div>
                  <div className="space-y-4">
                    <div className="relative">
                      <textarea 
                        value={aiFeedback}
                        onChange={(e) => setAiFeedback(e.target.value)}
                        placeholder="Ask AI to refine..."
                        className="w-full bg-[#111] border border-white/5 rounded-2xl p-4 text-sm text-white focus:outline-none focus:border-indigo-500/50 transition-colors h-24 md:h-32 resize-none pr-12"
                      />
                      <button 
                        onClick={handleAiFeedback}
                        disabled={isGenerating || !aiFeedback.trim()}
                        className="absolute bottom-4 right-4 p-2 rounded-xl bg-indigo-600 text-white disabled:opacity-50 transition-all hover:scale-110"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-4 md:p-8 border-t border-white/5 bg-[#0a0a0a] flex flex-col sm:flex-row justify-end gap-3 md:gap-4">
                <button 
                  onClick={() => finalizePost('SCHEDULED')}
                  className="w-full sm:w-auto px-8 py-3 rounded-xl border border-white/10 text-white font-medium hover:bg-white/5 transition-colors"
                >
                  Schedule
                </button>
                <button 
                  onClick={() => finalizePost('PUBLISHED')}
                  className="w-full sm:w-auto px-8 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-all shadow-[0_0_20px_rgba(79,70,229,0.3)]"
                >
                  Publish Now
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {/* Post Preview Modal */}
        {activeModal === 'preview' && selectedPost && (
          <div className="fixed inset-0 z-50 flex items-center justify-center md:p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setActiveModal(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative w-full h-full md:h-auto md:max-w-lg bg-[#0a0a0a] border-0 md:border md:border-white/10 rounded-none md:rounded-3xl overflow-hidden shadow-2xl"
            >
              <div className="p-6 md:p-8">
                <div className="flex items-center justify-between mb-8">
                  <div className="flex items-center gap-3">
                    <PlatformIcon platform={selectedPost.platform} className="w-5 h-5" />
                    <h2 className="text-xl font-medium">{selectedPost.title}</h2>
                  </div>
                  <button onClick={() => setActiveModal(null)} className="p-2 hover:bg-white/5 rounded-full transition-colors">
                    <CloseIcon className="w-5 h-5 text-zinc-500" />
                  </button>
                </div>

                <div className="space-y-6">
                  <div className="bg-[#111] rounded-2xl p-6 border border-white/5">
                    <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
                      {selectedPost.content || "No content generated for this post yet."}
                    </p>
                  </div>

                  <div className="flex items-center justify-between text-xs text-zinc-500">
                    <div className="flex items-center gap-2">
                      <Clock className="w-3 h-3" />
                      {format(selectedPost.scheduledAt, 'MMM d, yyyy • HH:mm')}
                    </div>
                    <span className={`px-2 py-0.5 rounded-full border font-bold tracking-wider ${STATUS_COLORS[selectedPost.status]}`}>
                      {selectedPost.status}
                    </span>
                  </div>
                </div>

                <div className="mt-10 flex gap-3">
                  {selectedPost.status === 'PUBLISHED' ? (
                    <button 
                      onClick={() => handleRepost(selectedPost)}
                      className="w-full py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-all shadow-[0_0_20px_rgba(79,70,229,0.3)] flex items-center justify-center gap-2"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Repost Content
                    </button>
                  ) : (
                    <button 
                      onClick={() => handleEditScheduled(selectedPost)}
                      className="w-full py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-all shadow-[0_0_20px_rgba(79,70,229,0.3)] flex items-center justify-center gap-2"
                    >
                      <Edit3 className="w-4 h-4" />
                      Edit Schedule
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
