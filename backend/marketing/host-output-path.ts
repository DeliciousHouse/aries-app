import path from 'node:path';

/**
 * Remap an absolute host-output path onto the in-container bind mount.
 *
 * The host's Lobster pipeline writes creative images and other artifacts
 * under an absolute host path (ARIES_LOBSTER_HOST_OUTPUT_DIR), but inside
 * this container that tree is only reachable via the read-only bind mount
 * at ARIES_LOBSTER_HOST_OUTPUT_MOUNT. Runtime docs routinely pin absolute
 * host paths (stage-3/4 creative assets especially), so every asset
 * resolver that does an absolute-path existsSync / isWithinRoot check
 * needs to add the remapped candidate before giving up. Without this
 * the dashboard drops creative assets and collapses to
 * creativeReviewReason='no_real_creative_assets'.
 *
 * Returns the remapped absolute path when `absolutePath` is under the
 * configured host output dir, otherwise null (including when either env
 * var is unset). path.resolve is used on the env-var-derived paths so a
 * trailing slash on the env var doesn't break the startsWith guard.
 */
export function remapHostOutputToMount(absolutePath: string): string | null {
  const hostOutputDir = process.env.ARIES_LOBSTER_HOST_OUTPUT_DIR?.trim();
  const hostOutputMount = process.env.ARIES_LOBSTER_HOST_OUTPUT_MOUNT?.trim();
  if (!hostOutputDir || !hostOutputMount) {
    return null;
  }

  const normalized = path.normalize(absolutePath);
  const hostDir = path.resolve(hostOutputDir);
  const hostMount = path.resolve(hostOutputMount);
  if (normalized !== hostDir && !normalized.startsWith(`${hostDir}${path.sep}`)) {
    return null;
  }

  const suffix = normalized.slice(hostDir.length).replace(/^[\\/]+/, '');
  return suffix ? path.join(hostMount, suffix) : hostMount;
}
