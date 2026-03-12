import path from 'node:path';

export function appSourceRoot(explicitRoot?: string): string {
  return explicitRoot || process.env.PROJECT_ROOT || process.cwd();
}

export function generatedDataRoot(explicitRoot?: string): string {
  return process.env.ARIES_DATA_ROOT || path.join(appSourceRoot(explicitRoot), 'generated');
}

export function generatedDataPath(...segments: string[]): string {
  return path.join(generatedDataRoot(), ...segments);
}

export function generatedDataPathFromRoot(explicitRoot: string | undefined, ...segments: string[]): string {
  return path.join(generatedDataRoot(explicitRoot), ...segments);
}

export function requiredSchemaPath(fileName: string, explicitRoot?: string): string {
  return path.join(appSourceRoot(explicitRoot), 'specs', fileName);
}
