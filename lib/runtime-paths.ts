import path from "node:path";

const CONTAINER_CODE_ROOT = "/app";
const CONTAINER_DATA_ROOT = "/data";

function normalizeRoot(p: string): string {
  return path.resolve(p);
}

export function resolveCodeRoot(): string {
  const explicitCodeRoot = process.env.CODE_ROOT?.trim();
  if (explicitCodeRoot) return normalizeRoot(explicitCodeRoot);
  return CONTAINER_CODE_ROOT;
}

export function resolveDataRoot(): string {
  const explicitDataRoot = process.env.DATA_ROOT?.trim();
  if (explicitDataRoot) return normalizeRoot(explicitDataRoot);
  return CONTAINER_DATA_ROOT;
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

export function resolveSpecPath(fileName: string): string {
  return resolveCodePath("specs", fileName);
}
