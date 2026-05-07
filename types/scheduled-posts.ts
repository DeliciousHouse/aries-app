export interface ScheduledPost {
  id: bigint;
  post_id: bigint;
  tenant_id: number;
  scheduled_for: Date;
  target_platforms: string[];
  updated_at: Date;
}

export interface CreateScheduledPostInput {
  post_id: bigint;
  tenant_id: number;
  scheduled_for: Date;
  target_platforms: string[];
}

export interface UpdateScheduledPostInput {
  scheduled_for?: Date;
  target_platforms?: string[];
}
