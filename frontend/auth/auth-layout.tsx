import React from 'react';
import { AuthView } from '../types';
import './index.css';


interface AuthLayoutProps {
  children: React.ReactNode;
  onNavigate?: (view: AuthView) => void;
  hideVisuals?: boolean;
  isPremium?: boolean;
}


const AuthLayout: React.FC<AuthLayoutProps> = ({ children }) => {
  return (
    <div
      className="min-h-screen w-full relative overflow-hidden flex flex-col items-center justify-center p-4"
      style={{
        background: 'radial-gradient(circle at 20% 20%, rgba(124,58,237,0.22) 0%, transparent 28%), radial-gradient(circle at 80% 0%, rgba(56,189,248,0.12) 0%, transparent 22%), linear-gradient(180deg, #05050b 0%, #0a0914 100%)',
        fontFamily: "'Inter', sans-serif"
      }}
    >
      <div
        className="absolute inset-0 z-0 pointer-events-none opacity-[0.08]"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.8) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.8) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
        }}
      />

      {/* 1. Grainy Texture Overlay */}
      <div className="absolute inset-0 z-0 pointer-events-none opacity-[0.4] mix-blend-overlay">
        <svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
          <filter id="noiseFilter">
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch" />
          </filter>
          <rect width="100%" height="100%" filter="url(#noiseFilter)" />
        </svg>
      </div>

      {/* 2. Inset Vignette Effect */}
      <div className="absolute inset-0 z-10 pointer-events-none shadow-[inset_0_0_200px_rgba(0,0,0,1)]" />

      {/* 3. Center Glow Overlay (Extra mood) */}
      <div className="absolute inset-0 z-2 pointer-events-none">
        <div
          className="absolute w-full h-full opacity-30 mix-blend-color-dodge"
          style={{
            background: 'radial-gradient(circle at center, rgba(124,58,237,0.45) 0%, transparent 70%)',
            filter: 'blur(120px)'
          }}
        />
      </div>

      <div className="relative z-20 w-full flex flex-col items-center max-w-7xl">
        {children}
      </div>
    </div>
  );
};


export default AuthLayout;



