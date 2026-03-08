// @ts-nocheck

const ALLOWED_NODE_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.set',
  'n8n-nodes-base.if',
  'n8n-nodes-base.executeCommand',
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.respondToWebhook'
]);

export interface RepairInput {
  workflow: any;
  originalWorkflow?: any;
  failure: {
    message: string;
    sectionPath?: string;
  };
  attempt: number;
}

export interface RepairOutput {
  repaired: boolean;
  patchedSection: string | null;
  reason: string;
  workflow: any;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function patchInvalidNodeType(workflow: any, originalWorkflow: any): RepairOutput | null {
  const idx = workflow.nodes?.findIndex((n: any) => !ALLOWED_NODE_TYPES.has(n.type));
  if (idx === -1) return null;

  if (originalWorkflow?.nodes?.[idx]?.type && ALLOWED_NODE_TYPES.has(originalWorkflow.nodes[idx].type)) {
    workflow.nodes[idx].type = originalWorkflow.nodes[idx].type;
    return { repaired: true, patchedSection: `nodes[${idx}].type`, reason: 'restored original allowed node type', workflow };
  }

  workflow.nodes.splice(idx, 1);
  return { repaired: true, patchedSection: `nodes[${idx}]`, reason: 'removed disallowed node', workflow };
}

function patchBrokenConnection(workflow: any): RepairOutput | null {
  const nodeNames = new Set((workflow.nodes || []).map((n: any) => n.name));
  const connections = workflow.connections || {};

  for (const [source, sourceValue] of Object.entries(connections)) {
    const main = (sourceValue as any)?.main;
    if (!Array.isArray(main)) continue;

    for (let outIndex = 0; outIndex < main.length; outIndex++) {
      const branch = main[outIndex];
      if (!Array.isArray(branch)) continue;

      const filtered = branch.filter((edge: any) => nodeNames.has(edge.node));
      if (filtered.length !== branch.length) {
        (connections as any)[source].main[outIndex] = filtered;
        workflow.connections = connections;
        return {
          repaired: true,
          patchedSection: `connections.${source}.main[${outIndex}]`,
          reason: 'removed connection edge(s) to missing node',
          workflow
        };
      }
    }
  }

  return null;
}

function patchActivationFlag(workflow: any): RepairOutput {
  workflow.active = false;
  return {
    repaired: true,
    patchedSection: 'active',
    reason: 'set active=false prior to publish retry',
    workflow
  };
}

export function boundedRepair(input: RepairInput): RepairOutput {
  const workflow = deepClone(input.workflow);
  const originalWorkflow = input.originalWorkflow ? deepClone(input.originalWorkflow) : undefined;
  const msg = (input.failure?.message || '').toLowerCase();

  if (input.attempt > 3) {
    return {
      repaired: false,
      patchedSection: null,
      reason: 'max repair attempts exceeded',
      workflow
    };
  }

  if (msg.includes('type') || msg.includes('node type') || msg.includes('disallowed')) {
    const patched = patchInvalidNodeType(workflow, originalWorkflow);
    if (patched) return patched;
  }

  if (msg.includes('connection') || msg.includes('node') || input.failure?.sectionPath === 'connections') {
    const patched = patchBrokenConnection(workflow);
    if (patched) return patched;
  }

  if (msg.includes('activate') || msg.includes('active')) {
    return patchActivationFlag(workflow);
  }

  return {
    repaired: false,
    patchedSection: null,
    reason: 'no safe section-only patch identified',
    workflow
  };
}
