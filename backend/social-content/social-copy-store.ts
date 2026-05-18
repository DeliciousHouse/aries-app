import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveDataPath } from '@/lib/runtime-paths';
import type { SocialCopyArtifact } from './types';

type UnknownRecord = Record<string, unknown>;

export type SocialCopyArtifactStoreErrorCode =
  | 'social_copy_artifact_invalid_json'
  | 'social_copy_artifact_invalid_shape';

export class SocialCopyArtifactStoreError extends Error {
  readonly code: SocialCopyArtifactStoreErrorCode;
  readonly jobId: string;
  readonly filePath: string;
  override readonly cause?: unknown;

  constructor(
    code: SocialCopyArtifactStoreErrorCode,
    message: string,
    input: { jobId: string; filePath: string; cause?: unknown },
  ) {
    super(message);
    this.name = 'SocialCopyArtifactStoreError';
    this.code = code;
    this.jobId = input.jobId;
    this.filePath = input.filePath;
    this.cause = input.cause;
  }
}

export type WriteSocialCopyArtifactOptions = {
  preserveExistingPosts?: boolean;
};

export type WriteSocialCopyArtifactResult = {
  filePath: string;
  artifact: SocialCopyArtifact;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim());
  return normalized.every((entry) => entry.length > 0) ? normalized : null;
}

function invalidShape(jobId: string, filePath: string, detail: string, cause?: unknown): SocialCopyArtifactStoreError {
  return new SocialCopyArtifactStoreError(
    'social_copy_artifact_invalid_shape',
    `social-copy.json has an invalid shape: ${detail}`,
    { jobId, filePath, cause },
  );
}

function normalizePost(
  value: unknown,
  input: { jobId: string; filePath: string; index: number },
): SocialCopyArtifact['posts'][number] {
  const record = asRecord(value);
  if (!record) {
    throw invalidShape(input.jobId, input.filePath, `posts[${input.index}] must be an object`);
  }

  const id = nonEmptyString(record.id);
  const channel = nonEmptyString(record.channel);
  const caption = nonEmptyString(record.caption);
  const cta = nonEmptyString(record.cta);
  const hashtags = stringArray(record.hashtags);
  const warnings = stringArray(record.warnings);

  if (!id) throw invalidShape(input.jobId, input.filePath, `posts[${input.index}].id must be a non-empty string`);
  if (!channel) throw invalidShape(input.jobId, input.filePath, `posts[${input.index}].channel must be a non-empty string`);
  if (!caption) throw invalidShape(input.jobId, input.filePath, `posts[${input.index}].caption must be a non-empty string`);
  if (!cta) throw invalidShape(input.jobId, input.filePath, `posts[${input.index}].cta must be a non-empty string`);
  if (!hashtags) throw invalidShape(input.jobId, input.filePath, `posts[${input.index}].hashtags must be a string[]`);
  if (!warnings) throw invalidShape(input.jobId, input.filePath, `posts[${input.index}].warnings must be a string[]`);

  return {
    id,
    channel,
    caption,
    hashtags,
    cta,
    warnings,
  };
}

function normalizeArtifact(value: unknown, input: { jobId: string; filePath: string }): SocialCopyArtifact {
  const record = asRecord(value);
  if (!record) {
    throw invalidShape(input.jobId, input.filePath, 'root must be an object');
  }

  const version = nonEmptyString(record.version);
  const generatedAt = nonEmptyString(record.generated_at);
  if (!version) throw invalidShape(input.jobId, input.filePath, 'version must be a non-empty string');
  if (!generatedAt) throw invalidShape(input.jobId, input.filePath, 'generated_at must be a non-empty string');
  if (!Array.isArray(record.posts)) throw invalidShape(input.jobId, input.filePath, 'posts must be an array');

  return {
    version,
    generated_at: generatedAt,
    posts: record.posts.map((post, index) => normalizePost(post, { ...input, index })),
  };
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

function mergePosts(
  existingPosts: SocialCopyArtifact['posts'],
  incomingPosts: SocialCopyArtifact['posts'],
): SocialCopyArtifact['posts'] {
  const incomingById = new Map(incomingPosts.map((post) => [post.id, post] as const));
  const merged = existingPosts.map((post) => incomingById.get(post.id) ?? post);
  const seenIds = new Set(existingPosts.map((post) => post.id));

  for (const post of incomingPosts) {
    if (!seenIds.has(post.id)) {
      merged.push(post);
      seenIds.add(post.id);
    }
  }

  return merged;
}

function mergeSocialCopyArtifacts(
  existing: SocialCopyArtifact | null,
  incoming: SocialCopyArtifact,
): SocialCopyArtifact {
  if (!existing) {
    return incoming;
  }

  return {
    version: incoming.version,
    generated_at: incoming.generated_at,
    posts: mergePosts(existing.posts, incoming.posts),
  };
}

export function socialCopyArtifactPath(jobId: string): string {
  return resolveDataPath('generated', 'draft', 'marketing-workspaces', jobId, 'social-copy.json');
}

export async function loadSocialCopyArtifact(jobId: string): Promise<SocialCopyArtifact | null> {
  const filePath = socialCopyArtifactPath(jobId);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    return normalizeArtifact(JSON.parse(raw), { jobId, filePath });
  } catch (error) {
    if (error instanceof SocialCopyArtifactStoreError) {
      throw error;
    }
    throw new SocialCopyArtifactStoreError(
      'social_copy_artifact_invalid_json',
      `social-copy.json is malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      { jobId, filePath, cause: error },
    );
  }
}

export async function writeSocialCopyArtifact(
  jobId: string,
  artifact: SocialCopyArtifact,
  options: WriteSocialCopyArtifactOptions = {},
): Promise<WriteSocialCopyArtifactResult> {
  const filePath = socialCopyArtifactPath(jobId);
  const normalizedIncoming = normalizeArtifact(artifact, { jobId, filePath });
  const existing = options.preserveExistingPosts === false
    ? null
    : await loadSocialCopyArtifact(jobId);
  const nextArtifact = options.preserveExistingPosts === false
    ? normalizedIncoming
    : mergeSocialCopyArtifacts(existing, normalizedIncoming);

  await writeJsonAtomically(filePath, nextArtifact);
  return { filePath, artifact: nextArtifact };
}
