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
        background: 'radial-gradient(circle at center, #7A001E 0%, #4D000D 50%, #140005 100%)',
        fontFamily: "'Inter', sans-serif"
      }}
    >
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
            background: 'radial-gradient(circle at center, #7A001E 0%, transparent 70%)',
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



