export type AriesCampaignStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'scheduled'
  | 'live'
  | 'changes_requested';

export type AriesChannelHealth = 'connected' | 'attention' | 'not_connected';

export interface AriesRecommendation {
  id: string;
  title: string;
  summary: string;
  actionLabel: string;
  href: string;
}

export interface AriesKpi {
  label: string;
  value: string;
  delta: string;
  tone: 'good' | 'neutral' | 'watch';
}

export interface AriesAssetVersion {
  id: string;
  label: string;
  headline: string;
  supportingText: string;
  cta: string;
  notes: string[];
}

export interface AriesReviewItem {
  id: string;
  campaignId: string;
  campaignName: string;
  title: string;
  channel: string;
  placement: string;
  scheduledFor: string;
  status: AriesCampaignStatus;
  summary: string;
  currentVersion: AriesAssetVersion;
  previousVersion?: AriesAssetVersion;
}

export interface AriesScheduleItem {
  id: string;
  title: string;
  channel: string;
  scheduledFor: string;
  status: AriesCampaignStatus;
}

export interface AriesChannelConnection {
  id: string;
  name: string;
  handle: string;
  health: AriesChannelHealth;
  detail: string;
}

export interface AriesCampaign {
  id: string;
  name: string;
  objective: string;
  status: AriesCampaignStatus;
  stageLabel: string;
  summary: string;
  dateRange: string;
  pendingApprovals: number;
  nextScheduled: string;
  trustNote: string;
  plan: {
    goal: string;
    audience: string;
    message: string;
    offer: string;
    channels: string[];
    whyNow: string;
  };
  creative: {
    heroTitle: string;
    summary: string;
    assets: Array<{
      id: string;
      name: string;
      type: string;
      status: AriesCampaignStatus;
      channel: string;
      summary: string;
    }>;
  };
  schedule: AriesScheduleItem[];
  results: {
    headline: string;
    summary: string;
    kpis: AriesKpi[];
    trend: Array<{
      label: string;
      leads: number;
      bookings: number;
    }>;
  };
  recommendations: AriesRecommendation[];
  activity: Array<{
    id: string;
    label: string;
    detail: string;
    at: string;
  }>;
}

export interface AriesWorkspaceSnapshot {
  businessName: string;
  trustMessage: string;
  nextAction: AriesRecommendation;
  activeCampaignId: string;
  scheduledNext: AriesScheduleItem | null;
  resultsSummary: AriesKpi[];
}

export const ARIES_CHANNELS: AriesChannelConnection[] = [
  {
    id: 'meta',
    name: 'Meta',
    handle: '@northstarstudio',
    health: 'connected',
    detail: 'Ads account connected and ready for scheduled launches.',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    handle: '@northstarstudio',
    health: 'connected',
    detail: 'Publishing and story placement are healthy.',
  },
  {
    id: 'google-business',
    name: 'Google Business',
    handle: 'Northstar Studio',
    health: 'attention',
    detail: 'Review response access needs reconnection before the next weekly post.',
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    handle: 'Northstar Studio',
    health: 'not_connected',
    detail: 'Not connected yet. Safe to add later.',
  },
];

export const ARIES_REVIEW_ITEMS: AriesReviewItem[] = [
  {
    id: 'review_meta_launch_hero',
    campaignId: 'spring-membership-drive',
    campaignName: 'Spring Membership Drive',
    title: 'Meta launch hero',
    channel: 'Meta',
    placement: 'Feed 4:5',
    scheduledFor: 'Tue, Mar 31 at 9:00 AM',
    status: 'in_review',
    summary: 'Needs final approval before the first ad set can be scheduled.',
    currentVersion: {
      id: 'v3',
      label: 'Current version',
      headline: 'Start strong this spring.',
      supportingText: 'Join now for four weeks of guided classes and a calmer routine.',
      cta: 'Book Intro',
      notes: [
        'Headline shortened for faster feed readability.',
        'Offer line now matches the landing page exactly.',
        'Visual hierarchy places the CTA above the fold crop.',
      ],
    },
    previousVersion: {
      id: 'v2',
      label: 'Previous version',
      headline: 'Make spring your reset.',
      supportingText: 'Four weeks of guided classes for busy professionals.',
      cta: 'Learn More',
      notes: [
        'Previous CTA felt too soft for this audience.',
        'Support line underplayed the intro offer.',
      ],
    },
  },
  {
    id: 'review_story_offer',
    campaignId: 'spring-membership-drive',
    campaignName: 'Spring Membership Drive',
    title: 'Instagram story offer',
    channel: 'Instagram',
    placement: 'Story 9:16',
    scheduledFor: 'Wed, Apr 1 at 7:30 AM',
    status: 'in_review',
    summary: 'Waiting on approval after a pricing clarification update.',
    currentVersion: {
      id: 'v2',
      label: 'Current version',
      headline: 'A calmer week starts here.',
      supportingText: 'Try four guided classes for one intro price before Friday.',
      cta: 'Reserve Spot',
      notes: [
        'Pricing language updated to reduce ambiguity.',
        'Story copy now aligns with the landing page subheadline.',
      ],
    },
    previousVersion: {
      id: 'v1',
      label: 'Previous version',
      headline: 'Try us this spring.',
      supportingText: 'Four guided classes before Friday.',
      cta: 'Reserve Spot',
      notes: ['The intro price was missing from the first pass.'],
    },
  },
  {
    id: 'review_landing_page',
    campaignId: 'spring-membership-drive',
    campaignName: 'Spring Membership Drive',
    title: 'Landing page update',
    channel: 'Website',
    placement: 'Campaign page',
    scheduledFor: 'Before launch',
    status: 'in_review',
    summary: 'One section was reordered after approval and now requires review again.',
    currentVersion: {
      id: 'v4',
      label: 'Current version',
      headline: 'Build a spring routine that actually sticks.',
      supportingText: 'Join with a four-class intro designed for busy professionals.',
      cta: 'Book Intro',
      notes: [
        'Social proof now appears above the pricing block.',
        'FAQ section tightened to reduce drop-off before the form.',
      ],
    },
    previousVersion: {
      id: 'v3',
      label: 'Previous version',
      headline: 'Build a spring routine that actually sticks.',
      supportingText: 'Join with a four-class intro designed for busy professionals.',
      cta: 'Book Intro',
      notes: ['Social proof previously appeared below pricing.'],
    },
  },
];

export const ARIES_CAMPAIGNS: AriesCampaign[] = [
  {
    id: 'spring-membership-drive',
    name: 'Spring Membership Drive',
    objective: 'Drive local intro bookings for the new class cycle.',
    status: 'in_review',
    stageLabel: 'Creative review',
    summary:
      'Aries has the campaign plan, landing page, launch creative, and first schedule ready. Three items need approval before scheduling begins.',
    dateRange: 'Mar 30 - Apr 20',
    pendingApprovals: 3,
    nextScheduled: 'Nothing scheduled until approval',
    trustNote: 'Nothing goes live until approved.',
    plan: {
      goal: 'Increase intro bookings for the next three-week class cycle.',
      audience: 'Busy local professionals who want a calmer, structured fitness routine.',
      message: 'A simple four-class intro can turn a chaotic week into a repeatable routine.',
      offer: 'Four guided classes for one intro price, booked online in under a minute.',
      channels: ['Meta', 'Instagram', 'Landing page'],
      whyNow: 'The spring cycle opens this week, so urgency and local timing matter.',
    },
    creative: {
      heroTitle: 'Review-ready creative set',
      summary: 'A calm, premium visual system built for feed, story, and landing page consistency.',
      assets: [
        {
          id: 'asset_meta_hero',
          name: 'Meta launch hero',
          type: 'Static ad',
          status: 'in_review',
          channel: 'Meta',
          summary: 'Primary launch creative for feed placements.',
        },
        {
          id: 'asset_story_offer',
          name: 'Instagram story offer',
          type: 'Story creative',
          status: 'in_review',
          channel: 'Instagram',
          summary: 'Short-form vertical creative for daily story placements.',
        },
        {
          id: 'asset_landing_page',
          name: 'Landing page',
          type: 'Landing page',
          status: 'in_review',
          channel: 'Website',
          summary: 'Conversion page aligned with the campaign message and offer.',
        },
      ],
    },
    schedule: [
      {
        id: 'sch_1',
        title: 'Meta launch hero',
        channel: 'Meta',
        scheduledFor: 'Tue, Mar 31 at 9:00 AM',
        status: 'draft',
      },
      {
        id: 'sch_2',
        title: 'Instagram story offer',
        channel: 'Instagram',
        scheduledFor: 'Wed, Apr 1 at 7:30 AM',
        status: 'draft',
      },
    ],
    results: {
      headline: 'Results will populate after launch.',
      summary: 'Aries will summarize booking momentum, cost efficiency, and next actions once the campaign is live.',
      kpis: [
        { label: 'Projected bookings', value: '18-24', delta: 'Ready after launch', tone: 'neutral' },
        { label: 'Estimated CPL', value: '$18-24', delta: 'Ready after launch', tone: 'neutral' },
        { label: 'Landing page conversion', value: '4.2-5.6%', delta: 'Ready after launch', tone: 'neutral' },
      ],
      trend: [
        { label: 'Week 1', leads: 0, bookings: 0 },
        { label: 'Week 2', leads: 0, bookings: 0 },
        { label: 'Week 3', leads: 0, bookings: 0 },
      ],
    },
    recommendations: [
      {
        id: 'rec_review_now',
        title: 'Approve the launch set',
        summary: 'Three items are ready. Approval is the only blocker before Aries can schedule the first week.',
        actionLabel: 'Open review queue',
        href: '/review',
      },
    ],
    activity: [
      {
        id: 'activity_1',
        label: 'Plan approved',
        detail: 'Campaign plan was approved and moved into creative preparation.',
        at: 'Today, 8:12 AM',
      },
      {
        id: 'activity_2',
        label: 'Creative updated',
        detail: 'Aries applied pricing clarity edits to the story set.',
        at: 'Today, 9:45 AM',
      },
      {
        id: 'activity_3',
        label: 'Landing page changed',
        detail: 'One structural change moved the page back into review for safety.',
        at: 'Today, 10:18 AM',
      },
    ],
  },
  {
    id: 'april-retention-pulse',
    name: 'April Retention Pulse',
    objective: 'Keep current members engaged with a light weekly content rhythm.',
    status: 'scheduled',
    stageLabel: 'Scheduled',
    summary:
      'This campaign is approved and scheduled. Aries is watching performance and will recommend edits if engagement drops.',
    dateRange: 'Apr 2 - Apr 28',
    pendingApprovals: 0,
    nextScheduled: 'Thu, Apr 2 at 8:30 AM',
    trustNote: 'Approved items stay visible here until they publish.',
    plan: {
      goal: 'Sustain attendance and reduce churn through weekly reminders and social proof.',
      audience: 'Current members and warm leads who already know the studio.',
      message: 'Consistency feels easier when the next step is already planned for you.',
      offer: 'Weekly class highlights, member stories, and reminder posts.',
      channels: ['Instagram', 'Email landing page', 'Google Business'],
      whyNow: 'A short rhythm keeps April attendance steady while the new offers ramp.',
    },
    creative: {
      heroTitle: 'Ready-to-launch creative set',
      summary: 'Low-friction content built for consistency and retention.',
      assets: [
        {
          id: 'asset_member_story',
          name: 'Member story',
          type: 'Social post',
          status: 'approved',
          channel: 'Instagram',
          summary: 'Approved testimonial-style story for the first week.',
        },
      ],
    },
    schedule: [
      {
        id: 'sch_3',
        title: 'Member story',
        channel: 'Instagram',
        scheduledFor: 'Thu, Apr 2 at 8:30 AM',
        status: 'scheduled',
      },
      {
        id: 'sch_4',
        title: 'Weekly reminder',
        channel: 'Google Business',
        scheduledFor: 'Sun, Apr 5 at 5:00 PM',
        status: 'scheduled',
      },
    ],
    results: {
      headline: 'Pre-launch baseline is set.',
      summary: 'Aries will compare attendance, clicks, and repeat bookings against last month once this campaign begins.',
      kpis: [
        { label: 'Projected repeat bookings', value: '32', delta: '+8 vs last month', tone: 'good' },
        { label: 'Projected CTR', value: '3.8%', delta: 'In line with recent posts', tone: 'neutral' },
        { label: 'Projected reply rate', value: '11%', delta: 'Higher than last cycle', tone: 'good' },
      ],
      trend: [
        { label: 'Baseline', leads: 12, bookings: 6 },
        { label: 'Week 1', leads: 0, bookings: 0 },
        { label: 'Week 2', leads: 0, bookings: 0 },
      ],
    },
    recommendations: [
      {
        id: 'rec_watch_launch',
        title: 'Watch the first scheduled post',
        summary: 'No action is needed yet. Aries will flag anything that needs revision before the second week.',
        actionLabel: 'Open schedule',
        href: '/calendar',
      },
    ],
    activity: [
      {
        id: 'activity_4',
        label: 'Schedule confirmed',
        detail: 'Two approved items are locked into next week.',
        at: 'Yesterday, 4:10 PM',
      },
    ],
  },
  {
    id: 'march-open-house',
    name: 'March Open House',
    objective: 'Convert open-house signups into intro consultations.',
    status: 'live',
    stageLabel: 'Live',
    summary:
      'The open-house campaign is live and performing well. Aries is recommending a follow-up variation based on stronger-than-expected booking interest.',
    dateRange: 'Mar 8 - Mar 24',
    pendingApprovals: 0,
    nextScheduled: 'No new items scheduled',
    trustNote: 'Live work remains visible until you archive or evolve it.',
    plan: {
      goal: 'Turn event interest into booked consultations over two weeks.',
      audience: 'People who clicked event invites and warm local audiences.',
      message: 'A guided first visit removes the intimidation of trying something new.',
      offer: 'Book a one-on-one introduction after the open house.',
      channels: ['Meta', 'Landing page'],
      whyNow: 'The event already built awareness, so follow-up conversion matters most.',
    },
    creative: {
      heroTitle: 'Live asset set',
      summary: 'A concise follow-up system built around conversion, not awareness.',
      assets: [
        {
          id: 'asset_follow_up',
          name: 'Consultation follow-up',
          type: 'Static ad',
          status: 'live',
          channel: 'Meta',
          summary: 'Currently driving the majority of booked consultations.',
        },
      ],
    },
    schedule: [
      {
        id: 'sch_5',
        title: 'Consultation follow-up',
        channel: 'Meta',
        scheduledFor: 'Live now',
        status: 'live',
      },
    ],
    results: {
      headline: 'Bookings are ahead of plan.',
      summary: 'This campaign is outperforming the booking goal. Aries recommends extending the strongest message into a second-week variation.',
      kpis: [
        { label: 'Booked consults', value: '27', delta: '+18% vs target', tone: 'good' },
        { label: 'Cost per booking', value: '$22', delta: '-11% vs target', tone: 'good' },
        { label: 'Landing page conversion', value: '6.4%', delta: '+1.3 pts', tone: 'good' },
      ],
      trend: [
        { label: 'Week 1', leads: 21, bookings: 9 },
        { label: 'Week 2', leads: 33, bookings: 18 },
        { label: 'Week 3', leads: 39, bookings: 27 },
      ],
    },
    recommendations: [
      {
        id: 'rec_extend_winner',
        title: 'Approve the winning variation for next week',
        summary: 'The highest-converting message is ready to adapt into a fresh creative version before fatigue appears.',
        actionLabel: 'Open campaign',
        href: '/campaigns/march-open-house',
      },
    ],
    activity: [
      {
        id: 'activity_5',
        label: 'Results milestone',
        detail: 'Booked consultations surpassed the goal three days early.',
        at: 'Today, 7:10 AM',
      },
    ],
  },
];

export const ARIES_WORKSPACE: AriesWorkspaceSnapshot = {
  businessName: 'Northstar Studio',
  trustMessage: 'Nothing goes live without your approval.',
  nextAction: {
    id: 'home_review',
    title: 'Approve the Spring Membership Drive launch set',
    summary: 'Three review items are ready. Once approved, Aries can schedule the first week.',
    actionLabel: 'Review now',
    href: '/review',
  },
  activeCampaignId: 'spring-membership-drive',
  scheduledNext: {
    id: 'home_schedule',
    title: 'Member story',
    channel: 'Instagram',
    scheduledFor: 'Thu, Apr 2 at 8:30 AM',
    status: 'scheduled',
  },
  resultsSummary: [
    { label: 'Booked consults', value: '27', delta: '+18% vs goal', tone: 'good' },
    { label: 'Leads this month', value: '94', delta: '+12% vs last month', tone: 'good' },
    { label: 'Review items', value: '3', delta: 'Need attention', tone: 'watch' },
  ],
};

export function getCampaignById(campaignId: string): AriesCampaign {
  return ARIES_CAMPAIGNS.find((campaign) => campaign.id === campaignId) ?? ARIES_CAMPAIGNS[0];
}

export function getReviewItemById(reviewId: string): AriesReviewItem {
  return ARIES_REVIEW_ITEMS.find((item) => item.id === reviewId) ?? ARIES_REVIEW_ITEMS[0];
}

export function getCampaignReviews(campaignId: string): AriesReviewItem[] {
  return ARIES_REVIEW_ITEMS.filter((item) => item.campaignId === campaignId);
}
