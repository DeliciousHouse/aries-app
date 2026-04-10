export type AriesOsIconName =
  | 'activity'
  | 'book-open'
  | 'bot'
  | 'brain'
  | 'briefcase-business'
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
  ops: {
    metrics: AriesOsMetric[];
    tools: AriesOsQuickLink[];
    prioritySections: AriesOsSection[];
    contractFiles: AriesOsFileItem[];
    sessionFiles: AriesOsFileItem[];
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
