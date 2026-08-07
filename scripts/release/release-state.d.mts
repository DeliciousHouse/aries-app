export type CommandResult = {
  status: number;
  stderr: string;
  stdout: string;
};

export type CommandRunner = (command: string, args: string[]) => CommandResult;

export type ReleaseEnvironment = {
  defaultSha: string;
  image: string;
  releaseSha: string;
  releaseTag: string;
  releaseVersion: string;
  repository: string;
};

export type ReleaseSnapshot = {
  deployRunId: number | null;
  imageDigest: string;
  releaseId: number | null;
  releaseState: 'absent' | 'draft' | 'published';
  tagSha: string | null;
  tagState: 'absent' | 'found';
  versionDigest: string | null;
  versionState: 'absent' | 'found';
};

export function inspectReleaseState(
  environment: ReleaseEnvironment,
  run: CommandRunner,
): ReleaseSnapshot;
export function prepareRelease(
  environment: ReleaseEnvironment,
  snapshot: ReleaseSnapshot,
  run: CommandRunner,
): ReleaseSnapshot;
export function assertDraftRelease(
  environment: ReleaseEnvironment,
  snapshot: ReleaseSnapshot,
  run: CommandRunner,
): ReleaseSnapshot;
export function assertPublishedRelease(
  environment: ReleaseEnvironment,
  snapshot: ReleaseSnapshot,
  run: CommandRunner,
): ReleaseSnapshot;
export function promoteRelease(
  environment: ReleaseEnvironment,
  snapshot: ReleaseSnapshot,
  run: CommandRunner,
): ReleaseSnapshot;
export function ensureImmutableAlias(
  target: string,
  source: string,
  expectedDigest: string,
  description: string,
  run: CommandRunner,
): string;
export function commandRunner(command: string, args: string[]): CommandResult;
export function snapshotEntries(
  snapshot: ReleaseSnapshot,
  lowercase?: boolean,
): Array<[string, string | number]>;
