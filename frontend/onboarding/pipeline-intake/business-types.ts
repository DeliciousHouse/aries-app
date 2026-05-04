export const BUSINESS_TYPES: readonly string[] = [
  'Ecommerce / DTC brand',
  'SaaS — B2B',
  'SaaS — B2C',
  'Marketplace',
  'Mobile app',
  'Tech hardware',
  'Fintech',
  'Healthtech',
  'Edtech',
  'Restaurant / Food service',
  'Cafe / Bakery',
  'Bar / Nightlife',
  'Food / Beverage brand',
  'Beauty & Cosmetics',
  'Hair / Nail / Beauty salon',
  'Spa / Wellness',
  'Fitness studio / Gym',
  'Yoga / Pilates studio',
  'Personal trainer / Coach',
  'Dental practice',
  'Medical / Clinic',
  'Mental health / Therapy',
  'Veterinary clinic',
  'Pharmacy / Health retail',
  'Real estate brokerage',
  'Real estate agent',
  'Property management',
  'Home services (plumbing, HVAC, etc.)',
  'Construction / Contractor',
  'Landscaping / Lawn care',
  'Cleaning service',
  'Auto dealership',
  'Auto repair / Detailing',
  'Hospitality / Hotel',
  'Travel agency / Tours',
  'Event venue',
  'Wedding / Event planning',
  'Photographer / Videographer',
  'Creative agency',
  'Marketing / PR agency',
  'Consulting firm',
  'Law firm',
  'Accounting / Bookkeeping',
  'Financial advisor',
  'Insurance agency',
  'Nonprofit / Charity',
  'Religious organization',
  'Education — K-12',
  'Education — Higher ed',
  'Online course creator',
  'Coaching / Mentorship',
  'Membership / Subscription community',
  'Publisher / Media',
  'Podcast / Newsletter',
  'Content creator / Influencer',
  'Musician / Band',
  'Artist / Maker',
  'Bookstore / Retail — small',
  'Boutique retail',
  'Pet products / Services',
  'Childcare / Preschool',
  'Manufacturer / Wholesaler',
  'Logistics / Shipping',
  'Other',
];

export function filterBusinessTypes(
  query: string,
  source: readonly string[] = BUSINESS_TYPES,
): readonly string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return source;
  return source.filter((entry) => entry.toLowerCase().includes(trimmed));
}

export function topGhostSuffix(
  query: string,
  source: readonly string[] = BUSINESS_TYPES,
): string {
  const trimmed = query.trim();
  if (!trimmed) return '';
  const lowerQuery = trimmed.toLowerCase();
  for (const entry of source) {
    if (entry.toLowerCase().startsWith(lowerQuery)) {
      return entry.slice(trimmed.length);
    }
  }
  return '';
}
