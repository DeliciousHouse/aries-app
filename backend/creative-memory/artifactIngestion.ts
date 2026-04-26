import { assertFrontendSafeResponse } from './errors';
import { sanitizeServedAssetRef } from '@/validators/creative-memory';
export interface RuntimeArtifactProjectionInput { sourceJobId: string; sourceAssetId: string; servedAssetRef: string; storageKey?: string | null; absolutePath?: string | null; }
export function projectRuntimeArtifactRef(input: RuntimeArtifactProjectionInput) { const servedAssetRef = sanitizeServedAssetRef(input.servedAssetRef); if (!servedAssetRef) return null; return assertFrontendSafeResponse({ sourceJobId: input.sourceJobId, sourceAssetId: input.sourceAssetId, servedAssetRef, storageKind:'runtime_asset' as const }); }
