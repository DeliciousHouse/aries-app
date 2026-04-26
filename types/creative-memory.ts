export const creativeAssetSourceTypes = [
  'owned_instagram',
  'owned_facebook',
  'owned_meta_ad',
  'competitor_meta_ad',
  'manual_upload',
  'generated_by_aries',
  'runtime_artifact',
  'landing_page_screenshot',
] as const;

export type CreativeAssetSourceType = typeof creativeAssetSourceTypes[number];

export const creativeAssetPermissionScopes = [
  'owned',
  'public_ad_library',
  'user_uploaded',
  'generated',
  'licensed',
] as const;

export type CreativeAssetPermissionScope = typeof creativeAssetPermissionScopes[number];

export const creativeLearningLabels = [
  'useful',
  'not_useful',
  'needs_changes',
  'approved',
  'rejected',
  'used_in_campaign',
  'winner',
  'loser',
] as const;

export type CreativeLearningLabel = typeof creativeLearningLabels[number];

export interface CreativeMemoryBrief {
  objective: string;
  platform: string;
  placement: string;
  aspectRatio: string;
  funnelStage: string;
  offer: string;
  audience: string;
  creativeType: string;
  cta: string;
  imageText: string[];
  mustUseCopy?: string[];
  mustAvoidAesthetics?: string[];
}

export interface SelectedStyleCard {
  id: string;
  name: string;
  visualDna: string;
  copyDna: string;
  promptGuidance: string;
  negativeGuidance: string;
  confidenceScore: number;
  selectionReason: string;
}

export interface SelectedCreativeExample {
  id: string;
  sourceType: CreativeAssetSourceType | string;
  permissionScope: CreativeAssetPermissionScope | string;
  mediaType?: string;
  servedAssetRef?: string | null;
  exactImageText?: string[];
  learningLifecycle?: string;
  selectionReason: string;
  rank: number;
}

export interface MarketPatternNote {
  id: string;
  sourceLabel: string;
  pattern: string;
  allowedUse: 'abstract_only';
  selectionReason: string;
}

export interface CreativeContextPack {
  status: 'ready' | 'competitor_only' | 'insufficient_memory';
  brandSummary: string;
  selectedStyleCards: SelectedStyleCard[];
  selectedExamples: SelectedCreativeExample[];
  marketPatternNotes: MarketPatternNote[];
  excludedCandidates: Array<{ id?: string; sourceType?: string; reason: string }>;
  performanceNotes: string[];
  provenance: { generatedAt: string; retrieval: string; [key: string]: unknown };
  tokenEstimate: number;
  maxTokens: number;
}

export interface PromptRecipePreview {
  baselinePrompt: string;
  compiledPrompt: string;
  negativePrompt: string;
  contextPack: CreativeContextPack;
  tokenEstimate: number;
  excludedCandidateCount: number;
  canGenerate: boolean;
  blockingReason?: string;
  selectionReasons?: string[];
  provenance?: { generatedAt?: string; retrieval?: string; sideEffectFree?: boolean; [key: string]: unknown };
}
