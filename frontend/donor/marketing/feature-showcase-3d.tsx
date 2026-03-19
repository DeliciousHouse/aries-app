'use client';

import { useRef } from 'react';

import { Canvas, useFrame } from '@react-three/fiber';
import { Float } from '@react-three/drei/core/Float';
import { MeshDistortMaterial } from '@react-three/drei/core/MeshDistortMaterial';
import { Cone, Torus } from '@react-three/drei/core/shapes';
import { motion } from 'motion/react';
import * as THREE from 'three';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { Layout, Sparkles, TrendingUp, Zap } from 'lucide-react';

const data = [
  { name: 'Mon', value: 4000 },
  { name: 'Tue', value: 3000 },
  { name: 'Wed', value: 5000 },
  { name: 'Thu', value: 2780 },
  { name: 'Fri', value: 6890 },
  { name: 'Sat', value: 4390 },
  { name: 'Sun', value: 8490 },
];

function Shape3D({ type, color }: { type: 'torus' | 'cone'; color: string }) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!meshRef.current) return;
    meshRef.current.rotation.x = state.clock.getElapsedTime() * 0.5;
    meshRef.current.rotation.y = state.clock.getElapsedTime() * 0.2;
  });

  return (
    <Float speed={2} rotationIntensity={1} floatIntensity={1}>
      <mesh ref={meshRef}>
        {type === 'torus' ? (
          <Torus args={[1, 0.4, 32, 100]}>
            <MeshDistortMaterial color={color} speed={2} distort={0.3} radius={1} />
          </Torus>
        ) : (
          <Cone args={[1, 2, 32]}>
            <MeshDistortMaterial color={color} speed={2} distort={0.3} radius={1} />
          </Cone>
        )}
      </mesh>
    </Float>
  );
}

export default function FeatureShowcase3D() {
  return (
    <section className="py-24 relative overflow-hidden bg-black">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-[48px] leading-tight font-bold mb-6"
          >
            Visualize Your <span className="text-gradient">Growth</span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 }}
            className="text-white/60 max-w-3xl mx-auto text-lg"
          >
            Harness the power of AI, making marketing automation and growth strategy intuitive and effective for all business sizes.
          </motion.p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 h-auto md:h-[800px]">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            whileHover={{ y: -5 }}
            viewport={{ once: true }}
            className="md:col-span-4 glass rounded-[2.5rem] p-8 flex flex-col justify-between group overflow-hidden relative"
          >
            <div className="h-48 relative">
              <Canvas camera={{ position: [0, 0, 4] }}>
                <ambientLight intensity={0.5} />
                <pointLight position={[10, 10, 10]} />
                <Shape3D type="torus" color="#8b5cf6" />
              </Canvas>
            </div>
            <div>
              <h3 className="text-2xl font-bold mb-3 flex items-center gap-2">
                <Zap className="w-5 h-5 text-primary" />
                Campaign Orchestration
              </h3>
              <p className="text-white/50 text-sm">
                AI-driven campaign management that aligns with your business goals automatically.
              </p>
            </div>
            <div className="absolute -bottom-10 -right-10 w-32 h-32 bg-primary/10 blur-3xl rounded-full group-hover:bg-primary/20 transition-all" />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            whileHover={{ y: -5 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="md:col-span-8 glass rounded-[2.5rem] p-8 flex flex-col group overflow-hidden relative"
          >
            <div className="flex-1 bg-black/40 rounded-2xl border border-white/5 p-6 mb-6">
              <div className="flex items-center justify-between mb-8">
                <div className="flex gap-2">
                  <div className="w-3 h-3 rounded-full bg-red-500/50" />
                  <div className="w-3 h-3 rounded-full bg-yellow-500/50" />
                  <div className="w-3 h-3 rounded-full bg-green-500/50" />
                </div>
                <div className="text-xs text-white/30 font-mono">aries-ai-dashboard-v2.0</div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-4">
                  <div className="h-12 bg-white/5 rounded-xl border border-white/5 flex items-center px-4 gap-3">
                    <Layout className="w-4 h-4 text-primary" />
                    <div className="h-2 w-24 bg-white/10 rounded" />
                  </div>
                  <div className="h-12 bg-white/5 rounded-xl border border-white/5 flex items-center px-4 gap-3 opacity-50">
                    <TrendingUp className="w-4 h-4" />
                    <div className="h-2 w-16 bg-white/10 rounded" />
                  </div>
                  <div className="h-12 bg-white/5 rounded-xl border border-white/5 flex items-center px-4 gap-3 opacity-50">
                    <Sparkles className="w-4 h-4" />
                    <div className="h-2 w-20 bg-white/10 rounded" />
                  </div>
                </div>
                <div className="bg-primary/5 rounded-xl border border-primary/10 p-4">
                  <div className="text-[10px] text-primary uppercase tracking-widest mb-2">Growth Velocity</div>
                  <div className="text-3xl font-bold text-white mb-1">84.2%</div>
                  <div className="text-[10px] text-green-400">+12.4% from last month</div>
                  <div className="mt-4 h-16 w-full flex items-end gap-1">
                    {[40, 70, 45, 90, 65, 80, 100].map((h, i) => (
                      <div key={i} className="flex-1 bg-primary/20 rounded-t-sm" style={{ height: `${h}%` }} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div>
              <h3 className="text-2xl font-bold mb-3">Growth Command Center</h3>
              <p className="text-white/50 text-sm">
                A unified interface to monitor and manage your entire marketing ecosystem in real-time.
              </p>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            whileHover={{ y: -5 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 }}
            className="md:col-span-8 glass rounded-[2.5rem] p-8 flex flex-col group overflow-hidden relative"
          >
            <div className="flex-1 h-64 mb-6">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                  <XAxis dataKey="name" stroke="#ffffff20" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis
                    stroke="#ffffff20"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => `$${value}`}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#111', border: '1px solid #333', borderRadius: '12px' }}
                    itemStyle={{ color: '#8b5cf6' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#8b5cf6"
                    strokeWidth={4}
                    dot={{ r: 4, fill: '#8b5cf6', strokeWidth: 0 }}
                    activeDot={{ r: 6, strokeWidth: 0 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div>
              <h3 className="text-2xl font-bold mb-3">Real-time ROI Tracking</h3>
              <p className="text-white/50 text-sm">
                Deep insights into your marketing spend and performance across all channels.
              </p>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            whileHover={{ y: -5 }}
            viewport={{ once: true }}
            transition={{ delay: 0.3 }}
            className="md:col-span-4 glass rounded-[2.5rem] p-8 flex flex-col justify-between group overflow-hidden relative"
          >
            <div className="h-48 relative">
              <Canvas camera={{ position: [0, 0, 4] }}>
                <ambientLight intensity={0.5} />
                <pointLight position={[10, 10, 10]} />
                <Shape3D type="cone" color="#ec4899" />
              </Canvas>
            </div>
            <div>
              <h3 className="text-2xl font-bold mb-3 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-secondary" />
                AI Content Engine
              </h3>
              <p className="text-white/50 text-sm">
                Automatically generate and optimize content that resonates with your target audience.
              </p>
            </div>
            <div className="absolute -bottom-10 -right-10 w-32 h-32 bg-secondary/10 blur-3xl rounded-full group-hover:bg-secondary/20 transition-all" />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
