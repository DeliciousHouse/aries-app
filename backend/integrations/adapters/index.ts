import type { ProviderAdapter } from './types';
import { metaAdapter } from './meta';
import { linkedInAdapter } from './linkedin';
import { xAdapter } from './x';
import { youTubeAdapter } from './youtube';
import { redditAdapter } from './reddit';

export const PROVIDER_ADAPTERS: Record<string, ProviderAdapter> = {
  facebook: metaAdapter,
  instagram: metaAdapter,
  linkedin: linkedInAdapter,
  x: xAdapter,
  youtube: youTubeAdapter,
  reddit: redditAdapter
};
