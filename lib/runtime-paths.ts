import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTAINER_CODE_ROOT = "/app";
const CONTAINER_APP_CODE_ROOT = "/app/aries-app";
const CONTAINER_DATA_ROOT = "/data";
const MODULE_CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_SHARED_DATA_ROOT = "/home/node/data";
const HOST_TEMP_DATA_ROOT = "/tmp/aries-data";

function normalizeRoot(p: string): string {
  return path.resolve(p);
}

function uniqueRoots(candidates: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      candidates
        .map((candidate) => (typeof candidate === "string" ? candidate.trim() : ""))
        .filter(Boolean)
        .map(normalizeRoot),
    ),
  );
}

function withAppRoot(candidate: string | null | undefined): Array<string | null | undefined> {
  if (!candidate) {
    return [];
  }

  const normalized = normalizeRoot(candidate);
  if (path.basename(normalized) === "aries-app") {
    return [normalized];
  }

  return [path.join(normalized, "aries-app"), normalized];
}

function hasCodeRootMarkers(root: string): boolean {
  return (
    existsSync(path.join(root, "package.json")) &&
    existsSync(path.join(root, "specs")) &&
    existsSync(path.join(root, "app")) &&
    existsSync(path.join(root, "backend"))
  );
}

export function codeRootCandidates(): string[] {
  const explicitCodeRoot = process.env.CODE_ROOT?.trim() || null;
  const cwd = process.cwd();

  return uniqueRoots([
    ...withAppRoot(explicitCodeRoot),
    ...withAppRoot(cwd),
    MODULE_CODE_ROOT,
    ...withAppRoot(CONTAINER_APP_CODE_ROOT),
    ...withAppRoot(CONTAINER_CODE_ROOT),
  ]);
}

export function resolveCodeRoot(): string {
  return codeRootCandidates().find((candidate) => hasCodeRootMarkers(candidate)) || MODULE_CODE_ROOT;
}

export function resolveDataRoot(): string {
  const explicitDataRoot = process.env.DATA_ROOT?.trim();
  if (explicitDataRoot) return normalizeRoot(explicitDataRoot);

  const candidates = [HOST_SHARED_DATA_ROOT, HOST_TEMP_DATA_ROOT, CONTAINER_DATA_ROOT]
    .map((candidate) => normalizeRoot(candidate));

  return candidates.find((candidate) => existsSync(candidate)) || resolveCodeRoot();
}

export function resolveCodePath(...segments: string[]): string {
  return path.join(resolveCodeRoot(), ...segments);
}

export function resolveDataPath(...segments: string[]): string {
  return path.join(resolveDataRoot(), ...segments);
}

export function resolveGeneratedRoot(): string {
  return resolveDataPath("generated");
}

export function resolveDraftRoot(): string {
  return path.join(resolveGeneratedRoot(), "draft");
}

export function resolveValidatedRoot(): string {
  return path.join(resolveGeneratedRoot(), "validated");
}

export function resolveSpecPathCandidates(fileName: string): string[] {
  return codeRootCandidates().map((root) => path.join(root, "specs", fileName));
}

export function describeSpecResolution(fileName: string): {
  requestedCodeRoot: string | null;
  resolvedCodeRoot: string;
  resolvedSpecPath: string;
  triedSpecPaths: string[];
} {
  const triedSpecPaths = resolveSpecPathCandidates(fileName);
  const resolvedSpecPath =
    triedSpecPaths.find((candidate) => existsSync(candidate)) || triedSpecPaths[0] || path.join(resolveCodeRoot(), "specs", fileName);

  return {
    requestedCodeRoot: process.env.CODE_ROOT?.trim() || null,
    resolvedCodeRoot: path.dirname(path.dirname(resolvedSpecPath)),
    resolvedSpecPath,
    triedSpecPaths,
  };
}

export function resolveSpecPath(fileName: string): string {
  return describeSpecResolution(fileName).resolvedSpecPath;
}
