export type Goal = "lead_generation" | "content_growth" | "product_sales" | "brand_awareness";
export type Channel = "tiktok" | "instagram" | "youtube" | "linkedin" | "x";
export type ExecutionMode = "strategy_only" | "strategy_plus_assets" | "full_pipeline";

export interface PipelineInput {
  brand_url: string;
  competitor_url: string;
  goal: Goal;
  channels: Channel[];
  mode: ExecutionMode;
}

export interface UrlPreviewData {
  title: string;
  favicon: string;
  domain: string;
  description: string;
}
