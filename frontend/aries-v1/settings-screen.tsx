'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  User, 
  Building2, 
  Target, 
  Upload, 
  Globe, 
  Palette, 
  FileText, 
  Save, 
  Edit3,
  Plus,
  Trash2,
  ExternalLink
} from 'lucide-react';

type Tab = 'me' | 'company' | 'competitors';

export default function AriesSettingsScreen() {
  const [activeTab, setActiveTab] = useState<Tab>('me');
  const [isEditing, setIsEditing] = useState(false);

  // Mock initial data
  const [profile, setProfile] = useState({
    name: 'Rohan Choudhary',
    email: 'rohan@sugarandleather.com',
    role: 'Founder & Creative Director',
    bio: 'Passionate about sustainable luxury and digital-first brand building. Leading the vision at Sugar & Leather.',
    avatar: 'https://picsum.photos/seed/rohan/200/200',
    timezone: 'GMT+5:30 (India Standard Time)',
    language: 'English (US)',
  });

  const [company, setCompany] = useState({
    name: 'Sugar & Leather',
    logo: 'https://picsum.photos/seed/company/200/200',
    url: 'https://sugarandleather.com',
    description: 'A premium lifestyle brand focusing on high-quality leather goods and sustainable fashion.',
    brandColor: '#7b61ff',
    industry: 'Luxury Goods & Fashion',
    size: '11-50 employees',
    founded: '2022',
    headquarters: 'Mumbai, India',
    socials: {
      instagram: '@sugarandleather',
      linkedin: 'sugar-and-leather',
    }
  });

  const [competitors, setCompetitors] = useState([
    { id: 1, name: 'Leather Co', url: 'https://leatherco.com', tier: 'High', advantage: 'Global Distribution' },
    { id: 2, name: 'Premium Goods', url: 'https://premiumgoods.io', tier: 'Medium', advantage: 'Lower Price Point' },
  ]);

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setProfile({ ...profile, avatar: reader.result as string });
      };
      reader.readAsDataURL(file);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setCompany({ ...company, logo: reader.result as string });
      };
      reader.readAsDataURL(file);
    }
  };

  const addCompetitor = () => {
    setCompetitors([...competitors, { id: Date.now(), name: '', url: '', tier: 'Medium', advantage: '' }]);
  };

  const removeCompetitor = (id: number) => {
    setCompetitors(competitors.filter(c => c.id !== id));
  };

  const updateCompetitor = (id: number, field: keyof typeof competitors[0], value: string) => {
    // @ts-ignore - dynamic field update
    setCompetitors(competitors.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const renderTabContent = () => {
    return (
      <div className="relative min-h-[550px]">
        <AnimatePresence mode="wait">
          {activeTab === 'me' && (
            <motion.div 
              key="me"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="space-y-8"
            >
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                  <h2 className="text-3xl font-display font-semibold text-white tracking-tight">Personal Profile</h2>
                  <p className="text-white/40 text-sm mt-1">Manage your identity and account credentials.</p>
                </div>
                <button 
                  onClick={() => setIsEditing(!isEditing)}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-xl transition-all text-sm font-medium border ${
                    isEditing 
                    ? 'bg-primary text-white border-primary shadow-lg shadow-primary/20' 
                    : 'bg-white/5 border-white/10 hover:bg-white/10 text-white/80'
                  }`}
                >
                  {isEditing ? <Save className="w-4 h-4" /> : <Edit3 className="w-4 h-4" />}
                  {isEditing ? 'Save Changes' : 'Edit Profile'}
                </button>
              </div>

              <div className="flex flex-col lg:flex-row gap-8 lg:gap-16">
                {/* Avatar Section */}
                <div className="flex flex-col items-center gap-6">
                  <div className="relative group">
                    <div className="w-32 h-32 md:w-40 md:h-40 rounded-full overflow-hidden border-4 border-white/10 bg-white/[0.03] flex items-center justify-center shadow-2xl">
                      {profile.avatar ? (
                        <img src={profile.avatar} alt="Profile" className="w-full h-full object-cover" />
                      ) : (
                        <User className="w-16 h-16 text-white/10" />
                      )}
                    </div>
                    {isEditing && (
                      <label className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-all cursor-pointer rounded-full border-2 border-dashed border-primary/50">
                        <div className="text-center">
                          <Upload className="w-8 h-8 text-white mx-auto mb-2" />
                          <span className="text-[10px] font-bold uppercase text-white tracking-widest">Update</span>
                        </div>
                        <input type="file" className="hidden" onChange={handleAvatarUpload} accept="image/*" />
                      </label>
                    )}
                  </div>
                  <div className="text-center">
                    <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-white/20">Profile Image</span>
                  </div>
                </div>

                <div className="flex-1 space-y-8">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Full Name</label>
                      <div className="relative group">
                        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                          <User className="w-4 h-4 text-white/20 group-focus-within:text-primary transition-colors" />
                        </div>
                        <input 
                          type="text" 
                          value={profile.name}
                          disabled={!isEditing}
                          onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                          className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-white placeholder:text-white/20 focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all"
                          placeholder="Your Name"
                        />
                      </div>
                    </div>
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Professional Role</label>
                      <input 
                        type="text" 
                        value={profile.role}
                        disabled={!isEditing}
                        onChange={(e) => setProfile({ ...profile, role: e.target.value })}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 px-5 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all"
                        placeholder="e.g. CEO, Designer"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Professional Bio</label>
                    <textarea 
                      value={profile.bio}
                      disabled={!isEditing}
                      onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
                      rows={3}
                      className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 px-5 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all resize-none leading-relaxed"
                      placeholder="Tell us about yourself..."
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Timezone</label>
                      <select 
                        value={profile.timezone}
                        disabled={!isEditing}
                        onChange={(e) => setProfile({ ...profile, timezone: e.target.value })}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 px-5 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all appearance-none"
                      >
                        <option value={profile.timezone}>{profile.timezone}</option>
                        <option value="UTC">UTC (Coordinated Universal Time)</option>
                        <option value="EST">EST (Eastern Standard Time)</option>
                      </select>
                    </div>
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Language</label>
                      <select 
                        value={profile.language}
                        disabled={!isEditing}
                        onChange={(e) => setProfile({ ...profile, language: e.target.value })}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 px-5 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all appearance-none"
                      >
                        <option value="English (US)">English (US)</option>
                        <option value="English (UK)">English (UK)</option>
                        <option value="Hindi">Hindi</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {isEditing && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="pt-8 flex justify-end"
                >
                  <button 
                    onClick={() => setIsEditing(false)}
                    className="w-full md:w-auto px-8 py-3 rounded-2xl bg-primary text-white font-semibold shadow-xl shadow-primary/25 hover:bg-primary/90 transition-all active:scale-95"
                  >
                    Save All Changes
                  </button>
                </motion.div>
              )}
            </motion.div>
          )}

          {activeTab === 'company' && (
            <motion.div 
              key="company"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="space-y-10"
            >
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                  <h2 className="text-3xl font-display font-semibold text-white tracking-tight">Brand Identity</h2>
                  <p className="text-white/40 text-sm mt-1">Define how your company appears to the world.</p>
                </div>
                <button 
                  onClick={() => setIsEditing(!isEditing)}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-xl transition-all text-sm font-medium border ${
                    isEditing 
                    ? 'bg-primary text-white border-primary shadow-lg shadow-primary/20' 
                    : 'bg-white/5 border-white/10 hover:bg-white/10 text-white/80'
                  }`}
                >
                  {isEditing ? <Save className="w-4 h-4" /> : <Edit3 className="w-4 h-4" />}
                  {isEditing ? 'Save Changes' : 'Edit Company'}
                </button>
              </div>

              <div className="flex flex-col lg:flex-row gap-8 lg:gap-16">
                {/* Logo Section */}
                <div className="flex flex-col items-center gap-6">
                  <div className="relative group">
                    <div className="w-32 h-32 md:w-40 md:h-40 rounded-[2rem] overflow-hidden border border-white/10 bg-white/[0.03] flex items-center justify-center p-4 shadow-inner">
                      {company.logo ? (
                        <img src={company.logo} alt="Company Logo" className="w-full h-full object-contain" />
                      ) : (
                        <Building2 className="w-16 h-16 text-white/10" />
                      )}
                    </div>
                    {isEditing && (
                      <label className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-all cursor-pointer rounded-[2rem] border-2 border-dashed border-primary/50">
                        <div className="text-center">
                          <Upload className="w-8 h-8 text-white mx-auto mb-2" />
                          <span className="text-[10px] font-bold uppercase text-white tracking-widest">Upload</span>
                        </div>
                        <input type="file" className="hidden" onChange={handleLogoUpload} accept="image/*" />
                      </label>
                    )}
                  </div>
                  <div className="text-center">
                    <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-white/20">Brand Mark</span>
                  </div>
                </div>

                {/* Form Section */}
                <div className="flex-1 space-y-8">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Entity Name</label>
                      <input 
                        type="text" 
                        value={company.name}
                        disabled={!isEditing}
                        onChange={(e) => setCompany({ ...company, name: e.target.value })}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 px-5 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all"
                        placeholder="Company Name"
                      />
                    </div>
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Industry Sector</label>
                      <input 
                        type="text" 
                        value={company.industry}
                        disabled={!isEditing}
                        onChange={(e) => setCompany({ ...company, industry: e.target.value })}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 px-5 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all"
                        placeholder="e.g. Technology, Fashion"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Company Size</label>
                      <select 
                        value={company.size}
                        disabled={!isEditing}
                        onChange={(e) => setCompany({ ...company, size: e.target.value })}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 px-5 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all appearance-none"
                      >
                        <option value="1-10 employees">1-10 employees</option>
                        <option value="11-50 employees">11-50 employees</option>
                        <option value="51-200 employees">51-200 employees</option>
                        <option value="201-500 employees">201-500 employees</option>
                      </select>
                    </div>
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Founded Year</label>
                      <input 
                        type="text" 
                        value={company.founded}
                        disabled={!isEditing}
                        onChange={(e) => setCompany({ ...company, founded: e.target.value })}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 px-5 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all"
                      />
                    </div>
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Headquarters</label>
                      <input 
                        type="text" 
                        value={company.headquarters}
                        disabled={!isEditing}
                        onChange={(e) => setCompany({ ...company, headquarters: e.target.value })}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 px-5 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Digital Presence</label>
                    <div className="relative group">
                      <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                        <Globe className="w-4 h-4 text-white/20 group-focus-within:text-primary transition-colors" />
                      </div>
                      <input 
                        type="url" 
                        value={company.url}
                        disabled={!isEditing}
                        onChange={(e) => setCompany({ ...company, url: e.target.value })}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all"
                        placeholder="https://yourcompany.com"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Mission Statement</label>
                    <div className="relative group">
                      <div className="absolute left-4 top-4 pointer-events-none">
                        <FileText className="w-4 h-4 text-white/20 group-focus-within:text-primary transition-colors" />
                      </div>
                      <textarea 
                        value={company.description}
                        disabled={!isEditing}
                        onChange={(e) => setCompany({ ...company, description: e.target.value })}
                        rows={4}
                        className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-white focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all resize-none leading-relaxed"
                        placeholder="Describe your company's core values and vision..."
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/20 ml-1">Signature Aesthetic</label>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                      <div 
                        className="w-16 h-16 rounded-2xl border border-white/10 shadow-2xl relative overflow-hidden shrink-0"
                        style={{ backgroundColor: company.brandColor }}
                      >
                        <div className="absolute inset-0 bg-gradient-to-br from-white/20 to-transparent pointer-events-none" />
                      </div>
                      <div className="relative flex-1 group w-full">
                        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                          <Palette className="w-4 h-4 text-white/20 group-focus-within:text-primary transition-colors" />
                        </div>
                        <input 
                          type="text" 
                          value={company.brandColor}
                          disabled={!isEditing}
                          onChange={(e) => setCompany({ ...company, brandColor: e.target.value })}
                          className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-white font-mono focus:outline-none focus:border-primary/40 focus:bg-white/[0.05] disabled:opacity-40 transition-all"
                        />
                      </div>
                      {isEditing && (
                        <div className="relative h-14 w-14 group">
                          <input 
                            type="color" 
                            value={company.brandColor}
                            onChange={(e) => setCompany({ ...company, brandColor: e.target.value })}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                          />
                          <div className="absolute inset-0 bg-white/5 border border-white/10 rounded-2xl flex items-center justify-center group-hover:bg-white/10 transition-colors">
                            <Plus className="w-5 h-5 text-white/40" />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {isEditing && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="pt-8 flex justify-end"
                >
                  <button 
                    onClick={() => setIsEditing(false)}
                    className="w-full md:w-auto px-8 py-3 rounded-2xl bg-primary text-white font-semibold shadow-xl shadow-primary/25 hover:bg-primary/90 transition-all active:scale-95"
                  >
                    Save All Changes
                  </button>
                </motion.div>
              )}
            </motion.div>
          )}

          {activeTab === 'competitors' && (
            <motion.div 
              key="competitors"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="space-y-8"
            >
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                  <h2 className="text-3xl font-display font-semibold text-white tracking-tight">Market Intelligence</h2>
                  <p className="text-white/40 text-sm mt-1">Monitor key rivals and industry benchmarks.</p>
                </div>
                <div className="flex flex-wrap gap-3">
                  {isEditing && (
                    <button 
                      onClick={addCompetitor}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary/10 border border-primary/20 hover:bg-primary/20 transition-all text-sm font-medium text-primary shadow-lg shadow-primary/5"
                    >
                      <Plus className="w-4 h-4" />
                      Add Rival
                    </button>
                  )}
                  <button 
                    onClick={() => setIsEditing(!isEditing)}
                    className={`flex items-center gap-2 px-5 py-2.5 rounded-xl transition-all text-sm font-medium border ${
                      isEditing 
                      ? 'bg-primary text-white border-primary shadow-lg shadow-primary/20' 
                      : 'bg-white/5 border-white/10 hover:bg-white/10 text-white/80'
                    }`}
                  >
                    {isEditing ? <Save className="w-4 h-4" /> : <Edit3 className="w-4 h-4" />}
                    {isEditing ? 'Save Changes' : 'Edit Rivals'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-5 pt-4">
                <AnimatePresence initial={false}>
                  {competitors.map((comp) => (
                    <motion.div 
                      key={comp.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className="glass-panel p-6 border-white/5 flex flex-col md:flex-row items-start md:items-center gap-6 md:gap-8 group relative overflow-hidden"
                    >
                      <div className="absolute inset-0 bg-gradient-to-r from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                      
                      <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/5 flex items-center justify-center text-white/20 group-hover:text-primary/50 transition-colors shrink-0">
                        <Target className="w-7 h-7" />
                      </div>
                      
                      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8 w-full">
                        <div className="space-y-2">
                          <label className="text-[9px] font-bold uppercase tracking-[0.2em] text-white/10">Entity Name</label>
                          <input 
                            type="text" 
                            value={comp.name}
                            disabled={!isEditing}
                            placeholder="Competitor Name"
                            onChange={(e) => updateCompetitor(comp.id, 'name', e.target.value)}
                            className="w-full bg-transparent border-none p-0 text-lg font-medium text-white focus:ring-0 placeholder:text-white/10 disabled:opacity-60 transition-all"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-[9px] font-bold uppercase tracking-[0.2em] text-white/10">Market Tier</label>
                          <select 
                            value={comp.tier}
                            disabled={!isEditing}
                            onChange={(e) => updateCompetitor(comp.id, 'tier', e.target.value)}
                            className="w-full bg-transparent border-none p-0 text-white/70 focus:ring-0 disabled:opacity-40 transition-all appearance-none"
                          >
                            <option value="High">High Priority</option>
                            <option value="Medium">Medium Priority</option>
                            <option value="Low">Low Priority</option>
                          </select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-[9px] font-bold uppercase tracking-[0.2em] text-white/10">Digital Domain</label>
                          <div className="flex items-center gap-3">
                            <input 
                              type="url" 
                              value={comp.url}
                              disabled={!isEditing}
                              placeholder="https://competitor.com"
                              onChange={(e) => updateCompetitor(comp.id, 'url', e.target.value)}
                              className="w-full bg-transparent border-none p-0 text-white/50 focus:ring-0 placeholder:text-white/10 disabled:opacity-40 transition-all font-mono text-sm"
                            />
                            {!isEditing && comp.url && (
                              <a href={comp.url} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg bg-white/5 text-white/30 hover:text-primary hover:bg-primary/10 transition-all">
                                <ExternalLink className="w-4 h-4" />
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      {isEditing && (
                        <div className="w-full md:flex-1 pt-4 border-t border-white/5">
                          <label className="text-[9px] font-bold uppercase tracking-[0.2em] text-white/10">Key Differentiator</label>
                          <input 
                            type="text" 
                            value={comp.advantage}
                            disabled={!isEditing}
                            placeholder="What makes them a threat?"
                            onChange={(e) => updateCompetitor(comp.id, 'advantage', e.target.value)}
                            className="w-full bg-transparent border-none p-0 text-sm text-white/60 focus:ring-0 placeholder:text-white/10 disabled:opacity-40 transition-all"
                          />
                        </div>
                      )}

                      {isEditing && (
                        <button 
                          onClick={() => removeCompetitor(comp.id)}
                          className="p-3 text-red-500/30 hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-all ml-auto"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>

                {competitors.length === 0 && (
                  <div className="text-center py-20 border-2 border-dashed border-white/5 rounded-[2.5rem] bg-white/[0.01]">
                    <Target className="w-16 h-16 text-white/5 mx-auto mb-6" />
                    <p className="text-white/20 font-medium">No competitors registered in the system.</p>
                    {isEditing && (
                      <button 
                        onClick={addCompetitor}
                        className="mt-6 text-primary hover:text-secondary transition-colors text-sm font-bold uppercase tracking-widest"
                      >
                        + Add First Rival
                      </button>
                    )}
                  </div>
                )}
              </div>

              {isEditing && competitors.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="pt-8 flex justify-end"
                >
                  <button 
                    onClick={() => setIsEditing(false)}
                    className="w-full md:w-auto px-8 py-3 rounded-2xl bg-primary text-white font-semibold shadow-xl shadow-primary/25 hover:bg-primary/90 transition-all active:scale-95"
                  >
                    Save All Changes
                  </button>
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 md:space-y-12 pb-20">
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl md:text-5xl font-display font-semibold tracking-tight text-white transition-all">Settings</h1>
        <p className="text-white/30 text-base md:text-lg max-w-2xl leading-relaxed">
          Refine your professional presence, brand architecture, and market intelligence parameters.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-2 md:gap-3 p-1.5 bg-white/[0.03] border border-white/10 rounded-2xl md:rounded-[1.5rem] w-full md:w-fit backdrop-blur-md">
        <button
          onClick={() => { setActiveTab('me'); setIsEditing(false); }}
          className={`flex-1 md:flex-none flex items-center justify-center gap-3 px-4 md:px-8 py-3 md:py-3.5 rounded-xl md:rounded-[1.25rem] text-xs md:text-sm font-semibold transition-all duration-300 ${activeTab === 'me' ? 'bg-primary text-white shadow-2xl shadow-primary/40 scale-[1.02]' : 'text-white/40 hover:text-white hover:bg-white/5'}`}
        >
          <User className="w-4 h-4" />
          About Me
        </button>
        <button
          onClick={() => { setActiveTab('company'); setIsEditing(false); }}
          className={`flex-1 md:flex-none flex items-center justify-center gap-3 px-4 md:px-8 py-3 md:py-3.5 rounded-xl md:rounded-[1.25rem] text-xs md:text-sm font-semibold transition-all duration-300 ${activeTab === 'company' ? 'bg-primary text-white shadow-2xl shadow-primary/40 scale-[1.02]' : 'text-white/40 hover:text-white hover:bg-white/5'}`}
        >
          <Building2 className="w-4 h-4" />
          Company
        </button>
        <button
          onClick={() => { setActiveTab('competitors'); setIsEditing(false); }}
          className={`flex-1 md:flex-none flex items-center justify-center gap-3 px-4 md:px-8 py-3 md:py-3.5 rounded-xl md:rounded-[1.25rem] text-xs md:text-sm font-semibold transition-all duration-300 ${activeTab === 'competitors' ? 'bg-primary text-white shadow-2xl shadow-primary/40 scale-[1.02]' : 'text-white/40 hover:text-white hover:bg-white/5'}`}
        >
          <Target className="w-4 h-4" />
          Competitors
        </button>
      </div>

      {/* Content Area */}
      <div className="glass rounded-[2rem] md:rounded-[3rem] p-6 md:p-12 border-white/10 shadow-[0_30px_100px_-20px_rgba(0,0,0,0.5)] relative overflow-hidden">
        {/* Atmospheric Background Elements */}
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[120px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-secondary/5 rounded-full blur-[100px] translate-y-1/2 -translate-x-1/2 pointer-events-none" />
        
        {renderTabContent()}
      </div>
    </div>
  );
}
