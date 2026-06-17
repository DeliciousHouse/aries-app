/**
 * Shared publish-failure taxonomy used by the publish dispatch shim and the
 * `auto`-mode composite provider to avoid duplicate posts.
 *
 * A publish failure falls into one of two classes (mirroring the direct-Meta
 * `MetaPublishFailureClass`):
 *
 *  - DEFINITELY NEVER POSTED — the action never reached the platform: a guard /
 *    missing-connection / missing-capability / config / SDK error (all raised
 *    before execution), or a `ComposioToolError` (the broker's explicit
 *    `successful:false` verdict). Safe to roll back a claim, retry, or fall back
 *    to another provider.
 *
 *  - OUTCOME UNKNOWN — anything else thrown out of a publish (e.g. a transport
 *    drop to the broker mid-publish). The post MAY already be live, so callers
 *    must NOT retry or re-publish via a fallback provider — that is a duplicate
 *    post (CLAUDE.md double-post / resumability rule).
 */

import { PublishGuardError } from './providers/errors';
import {
  ComposioCapabilityMissingError,
  ComposioConfigError,
  ComposioConnectionMissingError,
  ComposioSdkMissingError,
  ComposioToolError,
} from './composio/errors';

/**
 * True for failures that prove the post NEVER reached the platform (safe to
 * retry / roll back / fall back). Everything else is outcome-unknown.
 */
export function publishNeverReachedPlatform(error: unknown): boolean {
  return (
    error instanceof PublishGuardError ||
    error instanceof ComposioConnectionMissingError ||
    error instanceof ComposioCapabilityMissingError ||
    error instanceof ComposioConfigError ||
    error instanceof ComposioSdkMissingError ||
    error instanceof ComposioToolError
  );
}
