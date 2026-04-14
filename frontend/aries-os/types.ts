export type AriesOsIconName =
  | 'activity'
  | 'book-open'
  | 'bot'
  | 'brain'
  | 'briefcase-business'
  | 'clipboard-list'
  | 'compass'
  | 'file-stack'
  | 'folder-kanban'
  | 'layout-dashboard'
  | 'microscope'
  | 'rocket'
  | 'scroll-text'
  | 'settings-2'
  | 'sparkles'
  | 'terminal'
  | 'workflow'
  | 'wrench';

export interface AriesOsMetric {
  label: string;
  value: string;
  detail: string;
}

export interface AriesOsQuickLink {
  id: string;
  label: string;
  href: string;
  description: string;
  icon: AriesOsIconName;
}

export interface AriesOsSection {
  title: string;
  items: string[];
}

export interface AriesOsFileItem {
  id: string;
  name: string;
  path: string;
  kind: 'file' | 'directory';
  extension: string;
  sizeLabel: string;
  updatedAt: string;
  updatedAgo: string;
  summary: string;
  itemCount?: number;
}

export interface AriesOsMarkdownDocument {
  id: string;
  title: string;
  path: string;
  updatedAt: string;
  updatedAgo: string;
  summary: string;
  markdown: string;
  headings: string[];
}

export interface AriesOsStandupChief {
  chiefId: string;
  title: string;
  reportStatus: 'complete' | 'partial' | 'failed';
  currentStatus: string;
  activeTaskId: string | null;
  blockedCount: number;
  needsRouting: boolean;
}

export interface AriesOsStandupEntry {
  id: string;
  title: string;
  date: string;
  status: 'complete' | 'partial' | 'failed';
  generatedAt: string | null;
  preview: string;
  transcriptPath: string;
  boardPath: string | null;
  reportDirectory: string | null;
  transcriptBody: string;
  chiefs: AriesOsStandupChief[];
}

export interface AriesOsRuntimeContract {
  displayName: string;
  productionOnly: boolean;
  port: number;
  codeRoot: string;
  dataRoot: string;
  scripts: {
    build: string;
    start: string;
    dev: string;
  };
}

export interface AriesOsWorkspaceData {
  generatedAt: string;
  runtime: AriesOsRuntimeContract;
  initialView?: string | null;
  ops: {
    metrics: AriesOsMetric[];
    tools: AriesOsQuickLink[];
    prioritySections: AriesOsSection[];
    contractFiles: AriesOsFileItem[];
    sessionFiles: AriesOsFileItem[];
    standups: AriesOsStandupEntry[];
  };
  brain: {
    metrics: AriesOsMetric[];
    tools: AriesOsQuickLink[];
    briefs: AriesOsMarkdownDocument[];
    systemReference: AriesOsMarkdownDocument | null;
    memoryNotes: AriesOsMarkdownDocument[];
  };
  lab: {
    metrics: AriesOsMetric[];
    tools: AriesOsQuickLink[];
    prototypes: AriesOsFileItem[];
    overnightBuilds: AriesOsFileItem[];
    selfImprovementNotes: AriesOsMarkdownDocument[];
    buildLogs: AriesOsFileItem[];
  };
}
