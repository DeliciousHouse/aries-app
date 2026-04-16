export const DEMO = {
  brandUrl: process.env.DEMO_BRAND_URL || 'https://sugarandleather.com',
  brandName: process.env.DEMO_BRAND_NAME || 'Sugar & Leather',
  businessType:
    process.env.DEMO_BUSINESS_TYPE ||
    'Handmade leather goods — direct-to-consumer e-commerce',
  approverName: process.env.DEMO_APPROVER || 'Brendan',
  competitorUrl: process.env.DEMO_COMPETITOR_URL || 'https://portlandleather.com',
  offer:
    process.env.DEMO_OFFER ||
    'Handmade leather goods — bags, wallets, and belts made in Portland. Gift-forward, lifetime repair, direct-to-consumer.',
  brandVoice: 'Proof-led, practical, calm, founder-close.',
  styleVibe: 'Editorial, warm neutrals, tactile photography, understated luxury.',
  mustUseCopy: 'Handmade in Portland. Lifetime repair.',
  mustAvoidAesthetics: 'Stock-smile imagery, loud gradients, crowded layouts.',
  notes: 'Targeting women 30-50, gift-buyer mindset, Q4 ramp.',
  account: {
    email: process.env.DEMO_EMAIL || 'demo+broll@sugarandleather.com',
    password: process.env.DEMO_PASSWORD || '',
    fullName: process.env.DEMO_FULL_NAME || 'Brendan Demo',
  },
  existingJobId: process.env.DEMO_JOB_ID || '',
} as const;

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Set it before running this test.`,
    );
  }
  return v;
}
