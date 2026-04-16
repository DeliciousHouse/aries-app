import Link from 'next/link';

export const metadata = {
  title: 'Page not found — Aries AI',
};

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background text-white flex items-center justify-center px-6">
      <div className="glass rounded-[2.5rem] p-10 md:p-14 max-w-2xl text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-primary mb-4">404</p>
        <h1 className="text-5xl md:text-6xl font-bold mb-5">
          <span className="text-gradient">Page not found</span>
        </h1>
        <p className="text-white/60 text-lg mb-8">
          The page you&apos;re looking for doesn&apos;t exist. Head back to the homepage or sign in.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link href="/" className="px-8 py-4 rounded-full bg-gradient-to-r from-primary to-secondary text-white font-semibold shadow-xl shadow-primary/20">
            Back to home
          </Link>
          <Link href="/login" className="px-8 py-4 rounded-full bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all">
            Go to login
          </Link>
        </div>
      </div>
    </div>
  );
}
