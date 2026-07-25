export interface ContainerCreateRequest {
  name: string;
  request: Record<string, any>;
}

export function buildContainerCreateRequest(snapshot: unknown): ContainerCreateRequest;
export function restoreContainerFromInspect(snapshotPath: string): Promise<string>;
