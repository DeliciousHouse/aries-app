import React from 'react';


const AuthVisuals: React.FC = () => {
  const [activeBar, setActiveBar] = React.useState(0);


  React.useEffect(() => {
    const interval = setInterval(() => {
      setActiveBar((prev) => (prev + 1) % 10);
    }, 600);
    return () => clearInterval(interval);
  }, []);


  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center overflow-hidden">
      {/* Container for the Aries Marketing Platform visual */}
      <div className="relative w-full max-w-lg mb-20 scale-90 lg:scale-100">


        {/* Floating Mini Card 1 - Visibility Score */}
        <div className="absolute -top-12 -left-8 w-52 p-4 bg-white/70 backdrop-blur-2xl border border-white/80 rounded-[28px] shadow-2xl animate-float z-20">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-900">Visibility Index</div>
          </div>
          <div className="text-3xl font-black text-slate-900">85%</div>
          <div className="mt-3 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 w-[85%] transition-all duration-1000" />
          </div>
        </div>


        {/* Main Dashboard Platform - Aries Analytics */}
        <div className="bg-white rounded-[48px] shadow-[0_40px_80px_-15px_rgba(0,0,0,0.05)] p-10 overflow-hidden relative border border-slate-100">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-purple-600/20">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div>
                <h4 className="text-slate-900 font-black text-lg leading-none mb-1">Aries Hub</h4>
                <p className="text-slate-400 text-[10px] font-bold uppercase tracking-widest">Growth Analytics</p>
              </div>
            </div>
          </div>


          <div className="space-y-8">
            {/* Campaign Growth Chart */}
            <div className="flex items-end h-32 gap-2.5 px-1">
              {[35, 60, 45, 85, 55, 100, 75, 40, 65, 90].map((h, i) => (
                <div
                  key={i}
                  className={`flex-1 rounded-t-xl hover:bg-purple-500 hover:shadow-lg transition-all duration-300 cursor-pointer group relative ${activeBar === i ? 'bg-purple-600 shadow-lg shadow-purple-600/30 scale-y-105' : 'bg-slate-50'}`}
                  style={{ height: `${h}%` }}
                >
                  <div className={`absolute -top-8 left-1/2 -translate-x-1/2 bg-indigo-900 text-white text-[10px] font-bold px-2 py-1 rounded-lg opacity-0 transition-all ${activeBar === i ? 'opacity-100 -translate-y-1' : 'group-hover:opacity-100'}`}>
                    {h}%
                    <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-indigo-900"></div>
                  </div>
                </div>
              ))}
            </div>


            {/* Platform Metrics */}
            <div className="grid grid-cols-2 gap-5 pt-6 border-t border-slate-50">
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100 flex flex-col items-center justify-center text-center group cursor-pointer hover:bg-white transition-all">
                <svg className="w-7 h-7 text-purple-600 mb-2 group-hover:scale-110 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-7.714 2.143L11 21l-2.286-6.857L1 12l7.714-2.143L11 3z" />
                </svg>
                <div className="text-[10px] font-black text-slate-900 uppercase tracking-widest">Insights</div>
              </div>
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100 flex flex-col items-center justify-center text-center group cursor-pointer hover:bg-white transition-all">
                <svg className="w-7 h-7 text-indigo-600 mb-2 group-hover:scale-110 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                </svg>
                <div className="text-[10px] font-black text-slate-900 uppercase tracking-widest">AI Hub</div>
              </div>
            </div>
          </div>
        </div>


        {/* Floating Mini Card 2 - Predictive Insight */}
        <div className="absolute -bottom-10 -right-10 w-56 p-5 bg-white rounded-[32px] shadow-2xl border border-slate-50 animate-float-delayed z-30">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-purple-100 text-purple-600 rounded-2xl flex items-center justify-center">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9.663 17h4.674a1 1 0 00.922-.606l7-15A1 1 0 0021.337 0H2.663a1 1 0 00-.922 1.394l7 15a1 1 0 00.922.606z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 17v4m-2 0h4" />
              </svg>
            </div>
            <div>
              <div className="text-slate-900 text-sm font-black">AI Predictive</div>
              <div className="text-[9px] text-purple-600 font-black uppercase tracking-widest">Efficiency Up</div>
            </div>
          </div>
        </div>
      </div>


      <div className="text-center max-w-sm px-4">
        <h2 className="text-3xl lg:text-4xl font-bold mb-5 leading-tight tracking-tight font-sans text-white drop-shadow-lg">Precision Marketing Powered by AI.</h2>
        <p className="text-white/70 text-base lg:text-lg leading-relaxed font-medium font-sans">
          Aries centralizes campaign intelligence to deliver deep creative insights at global scale.
        </p>
      </div>


      <style>{`
       @keyframes float {
         0%, 100% { transform: translateY(0px) rotate(-1deg); }
         50% { transform: translateY(-25px) rotate(1deg); }
       }
       @keyframes float-delayed {
         0%, 100% { transform: translateY(0px) rotate(1deg); }
         50% { transform: translateY(-20px) rotate(-1deg); }
       }
       .animate-float {
         animation: float 7s ease-in-out infinite;
       }
       .animate-float-delayed {
         animation: float-delayed 9s ease-in-out infinite;
         animation-delay: 2s;
       }
     `}</style>
    </div>
  );
};


export default AuthVisuals;



