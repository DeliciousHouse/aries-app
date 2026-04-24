import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { findMarketingAsset } from '@/backend/marketing/asset-library';
import { readMarketingAssetWithinAllowedRoots } from '@/backend/marketing/asset-read';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { isMarketingPublicMode } from '@/lib/marketing-public-mode';
import { resolveDraftRoot } from '@/lib/runtime-paths';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing brand campaign assets.',
} as const;

const ASSET_NOT_FOUND_BODY = JSON.stringify({
  error: 'Marketing asset not found.',
  reason: 'marketing_asset_not_found',
});

const FORBIDDEN_ASSET_BODY = JSON.stringify({
  error: 'Forbidden.',
  reason: 'marketing_asset_forbidden',
});

function assetNotFoundResponse(
  jobId: string,
  assetId: string,
  cause: 'tenant_mismatch' | 'asset_descriptor_missing' | 'asset_file_missing',
): Response {
  // Branch-distinguishing log so operators can tell which of the three 404
  // paths fired without leaking internal state to the client (the response
  // body intentionally stays an opaque `marketing_asset_not_found`).
  console.warn('[marketing-asset-not-found]', { jobId, assetId, cause });
  return new Response(ASSET_NOT_FOUND_BODY, {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

function assetForbiddenResponse(): Response {
  return new Response(FORBIDDEN_ASSET_BODY, {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

function invalidVideoAssetResponse(): Response {
  return new Response(JSON.stringify({
    error: 'Invalid marketing asset request.',
    reason: 'invalid_marketing_asset_request',
  }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseSingleRangeHeader(rangeHeader: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }

  const [, startText, endText] = match;
  if (!startText && !endText) {
    return null;
  }

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }

    const start = Math.max(size - suffixLength, 0);
    return { start, end: size - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd)) {
    return null;
  }

  const end = Math.min(requestedEnd, size - 1);
  if (start < 0 || start >= size || start > end) {
    return null;
  }

  return { start, end };
}

type ReadableStreamWithFrom = typeof ReadableStream & {
  from<T>(source: Iterable<T> | AsyncIterable<T>): ReadableStream<T>;
};

function streamBodyFrom(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  return (ReadableStream as ReadableStreamWithFrom).from(source);
}

async function resolveVideoAssetPath(jobId: string, assetId: string): Promise<{ filePath: string; contentType: string } | Response> {
  const isPoster = assetId.endsWith('-poster');
  const baseName = assetId.replace(/^video-/, '').replace(/-poster$/, '');
  const videosRoot = path.resolve(resolveDraftRoot(), 'jobs', jobId, 'videos');
  const requestedPath = path.resolve(videosRoot, `${baseName}${isPoster ? '.jpg' : '.mp4'}`);

  if (!baseName || !isWithinRoot(videosRoot, requestedPath)) {
    return invalidVideoAssetResponse();
  }

  const resolvedVideosRoot = await realpath(videosRoot).catch(() => videosRoot);
  const resolvedPath = await realpath(requestedPath).catch((error: unknown) => {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null;
    }
    throw error;
  });

  if (!resolvedPath) {
    return assetNotFoundResponse(jobId, assetId, 'asset_file_missing');
  }

  if (!isWithinRoot(resolvedVideosRoot, resolvedPath)) {
    return invalidVideoAssetResponse();
  }

  return {
    filePath: resolvedPath,
    contentType: isPoster ? 'image/jpeg' : 'video/mp4',
  };
}

async function streamVideoAsset(
  jobId: string,
  assetId: string,
  request: Request | null,
): Promise<Response> {
  const resolvedAsset = await resolveVideoAssetPath(jobId, assetId);
  if (resolvedAsset instanceof Response) {
    return resolvedAsset;
  }

  const fileInfo = await stat(resolvedAsset.filePath).catch((error: unknown) => {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null;
    }
    throw error;
  });

  if (!fileInfo?.isFile()) {
    return assetNotFoundResponse(jobId, assetId, 'asset_file_missing');
  }

  const commonHeaders = new Headers({
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=60',
    'content-disposition': 'inline',
    'content-type': resolvedAsset.contentType,
  });

  const rangeHeader = request?.headers.get('range');
  if (rangeHeader) {
    const range = parseSingleRangeHeader(rangeHeader, fileInfo.size);
    if (!range) {
      commonHeaders.set('content-range', `bytes */${fileInfo.size}`);
      return new Response(null, {
        status: 416,
        headers: commonHeaders,
      });
    }

    const { start, end } = range;
    const contentLength = end - start + 1;
    const stream = createReadStream(resolvedAsset.filePath, { start, end });

    commonHeaders.set('content-length', String(contentLength));
    commonHeaders.set('content-range', `bytes ${start}-${end}/${fileInfo.size}`);

    return new Response(streamBodyFrom(stream as AsyncIterable<Uint8Array>), {
      status: 206,
      headers: commonHeaders,
    });
  }

  commonHeaders.set('content-length', String(fileInfo.size));
  return new Response(streamBodyFrom(createReadStream(resolvedAsset.filePath) as AsyncIterable<Uint8Array>), {
    status: 200,
    headers: commonHeaders,
  });
}

export async function handleGetMarketingJobAsset(
  jobId: string,
  assetId: string,
  requestOrTenantContextLoader?: Request | TenantContextLoader,
  tenantContextLoader?: TenantContextLoader,
) {
  const request = requestOrTenantContextLoader instanceof Request ? requestOrTenantContextLoader : null;
  const resolvedTenantContextLoader =
    typeof requestOrTenantContextLoader === 'function'
      ? requestOrTenantContextLoader
      : tenantContextLoader;
  const requiresTenantContext = assetId.startsWith('video-') || !isMarketingPublicMode();

  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc) {
    return new Response(JSON.stringify({ error: 'Marketing job not found.', reason: 'marketing_job_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (requiresTenantContext) {
    const tenantResult = await loadTenantContextOrResponse(resolvedTenantContextLoader, {
      missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
    });
    if ('response' in tenantResult) {
      return tenantResult.response;
    }

    if (runtimeDoc.tenant_id !== tenantResult.tenantContext.tenantId) {
      return assetId.startsWith('video-')
        ? assetForbiddenResponse()
        : assetNotFoundResponse(jobId, assetId, 'tenant_mismatch');
    }
  }

  if (assetId.startsWith('video-')) {
    return streamVideoAsset(jobId, assetId, request);
  }

  const asset = findMarketingAsset(jobId, runtimeDoc, assetId);
  if (!asset) {
    return assetNotFoundResponse(jobId, assetId, 'asset_descriptor_missing');
  }

  const buffer = await readMarketingAssetWithinAllowedRoots(asset.filePath);
  if (!buffer) {
    return assetNotFoundResponse(jobId, assetId, 'asset_file_missing');
  }

  // `inline` (not `attachment`) keeps the browser from surprise-downloading
  // unknown or markdown-ish content when this route is hit directly. The
  // /materials/[jobId]/[assetId] viewer is the polished default for
  // document-kind attachments; this raw route remains available for image
  // rendering and for the "Download source" affordance in the viewer.
  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': asset.contentType,
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=60',
    },
  });
}
