export const publishedStatuses = [
  'draft',
  'in_review',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'rolled_back',
  'unverified',
  'expired',
] as const;

export type PublishedStatus = typeof publishedStatuses[number];

export interface Post {
  id: bigint;
  tenant_id: number;
  content: string;
  platform_post_id?: string | null;
  published_at?: Date | null;
  scheduled_at?: Date | null;
  published_status: PublishedStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreatePostInput {
  tenant_id: number;
  content: string;
  platform_post_id?: string;
  published_at?: Date;
  scheduled_at?: Date;
  published_status?: PublishedStatus;
}

export interface UpdatePostInput {
  content?: string;
  platform_post_id?: string;
  published_at?: Date;
  scheduled_at?: Date;
  published_status?: PublishedStatus;
}
