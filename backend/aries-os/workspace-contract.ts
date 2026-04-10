import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { resolveCodePath, resolveCodeRoot, resolveDataRoot, resolveGeneratedRoot } from '@/lib/runtime-paths';
import type {
  AriesOsFileItem,
  AriesOsMarkdownDocument,
  AriesOsMetric,
  AriesOsQuickLink,
  AriesOsSection,
  AriesOsWorkspaceData,
} from '@/frontend/aries-os/types';

const codeRoot = resolveCodeRoot();

function safeReadText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function relativePath(filePath: string): string {
  return path.relative(codeRoot, filePath) || path.basename(filePath);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Los_Angeles',
  }).format(value);
}

function formatAgo(value: number): string {
  const diffMs = Date.now() - value;
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.round(diffDays / 30);
  return `${diffMonths}mo ago`;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[>*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeText(text: string, fallback: string): string {
  const cleaned = stripMarkdown(text);
  if (!cleaned) return fallback;
  return cleaned.length > 140 ? `${cleaned.slice(0, 137).trimEnd()}...` : cleaned;
}

function listFiles(directoryPath: string, options?: { recursive?: boolean; limit?: number; includeDirectories?: boolean }): string[] {
  if (!existsSync(directoryPath)) return [];
  const recursive = options?.recursive ?? true;
  const includeDirectories = options?.includeDirectories ?? false;
  const limit = options?.limit ?? Number.POSITIVE_INFINITY;
  const results: string[] = [];

  const walk = (currentPath: string) => {
    const entries = readdirSync(currentPath, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules' && entry.name !== '.next')
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (includeDirectories) {
          results.push(fullPath);
          if (results.length >= limit) return;
        }
        if (recursive) {
          walk(fullPath);
          if (results.length >= limit) return;
        }
        continue;
      }

      results.push(fullPath);
      if (results.length >= limit) return;
    }
  };

  walk(directoryPath);
  return results;
}

function toFileItem(targetPath: string, summaryFallback: string): AriesOsFileItem {
  const stats = statSync(targetPath);
  const isDirectory = stats.isDirectory();
  const itemCount = isDirectory ? readdirSync(targetPath).length : undefined;
  const ext = isDirectory ? 'dir' : path.extname(targetPath).replace(/^\./, '') || 'file';
  const textSummary = !isDirectory && /\.(md|txt|json|html|css|tsx?|mjs)$/i.test(targetPath)
    ? summarizeText(safeReadText(targetPath), summaryFallback)
    : summaryFallback;

  return {
    id: relativePath(targetPath),
    name: path.basename(targetPath),
    path: relativePath(targetPath),
    kind: isDirectory ? 'directory' : 'file',
    extension: ext,
    sizeLabel: isDirectory ? `${itemCount ?? 0} items` : formatBytes(stats.size),
    updatedAt: formatDate(stats.mtimeMs),
    updatedAgo: formatAgo(stats.mtimeMs),
    summary: textSummary,
    itemCount,
  };
}

function sortByUpdatedDesc<T extends { path: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const leftTime = statSync(path.join(codeRoot, left.path)).mtimeMs;
    const rightTime = statSync(path.join(codeRoot, right.path)).mtimeMs;
    return rightTime - leftTime;
  });
}

function extractHeadings(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^##?\s+/.test(line))
    .map((line) => line.replace(/^##?\s+/, '').trim());
}

function extractSections(markdown: string): AriesOsSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: AriesOsSection[] = [];
  let current: AriesOsSection | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{2,3}\s+/.test(line)) {
      current = { title: line.replace(/^#{2,3}\s+/, '').trim(), items: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      current.items.push(line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim());
    }
  }

  return sections.filter((section) => section.items.length > 0);
}

function toMarkdownDocument(filePath: string, fallbackTitle?: string): AriesOsMarkdownDocument {
  const markdown = safeReadText(filePath);
  const stats = statSync(filePath);
  const lines = markdown.split(/\r?\n/).filter(Boolean);
  const titleLine = lines.find((line) => /^#\s+/.test(line));
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : fallbackTitle || path.basename(filePath);

  return {
    id: relativePath(filePath),
    title,
    path: relativePath(filePath),
    updatedAt: formatDate(stats.mtimeMs),
    updatedAgo: formatAgo(stats.mtimeMs),
    summary: summarizeText(markdown, `No summary available for ${relativePath(filePath)}.`),
    markdown,
    headings: extractHeadings(markdown),
  };
}

function listMarkdownDocuments(directoryPath: string, limit: number): AriesOsMarkdownDocument[] {
  return listFiles(directoryPath, { recursive: false, limit: limit * 3 })
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => toMarkdownDocument(entry))
    .sort((left, right) => {
      const leftTime = statSync(path.join(codeRoot, left.path)).mtimeMs;
      const rightTime = statSync(path.join(codeRoot, right.path)).mtimeMs;
      return rightTime - leftTime;
    })
    .slice(0, limit);
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter((entry) => existsSync(entry))));
}

function collectFileItems(paths: string[], fallback: string, limit: number): AriesOsFileItem[] {
  return uniquePaths(paths)
    .map((entry) => toFileItem(entry, fallback))
    .sort((left, right) => {
      const leftTime = statSync(path.join(codeRoot, left.path)).mtimeMs;
      const rightTime = statSync(path.join(codeRoot, right.path)).mtimeMs;
      return rightTime - leftTime;
    })
    .slice(0, limit);
}

function makeMetrics(items: AriesOsMetric[]): AriesOsMetric[] {
  return items;
}

function quickLink(id: string, label: string, href: string, description: string, icon: AriesOsQuickLink['icon']): AriesOsQuickLink {
  return { id, label, href, description, icon };
}

function countChecklistItems(text: string): number {
  return text.split(/\r?\n/).filter((line) => /^[-*]\s+\[ \]/.test(line.trim())).length;
}

export function getAriesOsWorkspaceData(): AriesOsWorkspaceData {
  const packageJson = JSON.parse(safeReadText(resolveCodePath('package.json')) || '{}') as {
    scripts?: Record<string, string>;
  };
  const prioritiesPath = resolveCodePath('PRIORITIES.md');
  const prioritiesMarkdown = safeReadText(prioritiesPath);
  const systemReferencePath = resolveCodePath('docs', 'SYSTEM-REFERENCE.md');
  const briefsDirectory = resolveCodePath('docs', 'briefs');
  const memoryDirectory = resolveCodePath('memory');
  const stateSessionsDirectory = resolveCodePath('state', 'sessions');
  const outputDirectory = resolveCodePath('output');
  const artifactsDirectory = resolveCodePath('.artifacts');
  const validatedDirectory = resolveCodePath('generated', 'validated');
  const runtimeGeneratedDirectory = resolveGeneratedRoot();

  const briefs = listMarkdownDocuments(briefsDirectory, 12);
  const memoryNotes = listMarkdownDocuments(memoryDirectory, 12).filter((entry) => !entry.path.includes('/.dreams/'));
  const selfImprovementNotes = memoryNotes.filter((entry) => /overnight self-improvement/i.test(entry.markdown));

  const contractFiles = collectFileItems(
    [
      resolveCodePath('PRIORITIES.md'),
      resolveCodePath('AGENTS.md'),
      resolveCodePath('PROTECTED_SYSTEMS.md'),
      resolveCodePath('docs', 'SYSTEM-REFERENCE.md'),
      resolveCodePath('generated', 'validated', 'production', 'production-contract.md'),
      resolveCodePath('generated', 'validated', 'production', 'workflow-target-map.json'),
      resolveCodePath('generated', 'validated', 'project-progress.json'),
    ],
    'Canonical repo contract surface.',
    7,
  );

  const sessionFiles = collectFileItems(
    listFiles(stateSessionsDirectory, { recursive: false, limit: 18 }).filter((entry) => entry.endsWith('.json')),
    'Serialized ACP/runtime session state.',
    10,
  );

  const prototypes = collectFileItems(
    listFiles(outputDirectory, { recursive: true, limit: 64 })
      .filter((entry) => /\.(md|html|json|css|tar\.gz)$/i.test(entry))
      .slice(-24),
    'Generated prototype or creative artifact.',
    12,
  );

  const overnightBuilds = collectFileItems(
    [
      ...listFiles(validatedDirectory, { recursive: true, limit: 24 }).filter((entry) => /\.(md|json|example)$/i.test(entry)),
      ...listFiles(runtimeGeneratedDirectory, { recursive: true, limit: 24 }).filter((entry) => /\.(md|json|html|css)$/i.test(entry)),
    ],
    'Validated automation output or frozen contract artifact.',
    12,
  );

  const buildLogs = collectFileItems(
    listFiles(artifactsDirectory, { recursive: true, limit: 40 }).filter((entry) => /\.(html|json|png)$/i.test(entry)),
    'Captured build or smoke-test artifact.',
    12,
  );

  const prioritySections = extractSections(prioritiesMarkdown);
  const checklistCount = countChecklistItems(prioritiesMarkdown);
  const systemReference = existsSync(systemReferencePath) ? toMarkdownDocument(systemReferencePath, 'System reference') : null;

  return {
    generatedAt: formatDate(Date.now()),
    runtime: {
      displayName: 'Aries OS',
      productionOnly: true,
      port: 8100,
      codeRoot: resolveCodeRoot(),
      dataRoot: resolveDataRoot(),
      scripts: {
        build: packageJson.scripts?.build || 'next build',
        start: packageJson.scripts?.start || 'node scripts/start-runtime.mjs',
        dev: packageJson.scripts?.dev || 'next dev -p 8100 --turbopack',
      },
    },
    ops: {
      metrics: makeMetrics([
        {
          label: 'Contract files',
          value: String(contractFiles.length),
          detail: 'Canonical repo truth surfaces wired into the shell.',
        },
        {
          label: 'Priority sections',
          value: String(prioritySections.length),
          detail: 'Actionable sections parsed from PRIORITIES.md.',
        },
        {
          label: 'Open checklists',
          value: String(checklistCount),
          detail: 'Unchecked list items currently found in canonical priorities.',
        },
        {
          label: 'Tracked sessions',
          value: String(sessionFiles.length),
          detail: 'Session state files currently on disk under state/sessions.',
        },
      ]),
      tools: [
        quickLink('ops-dashboard', 'Open runtime dashboard', '/dashboard', 'Open the authenticated dashboard surface in a new tab.', 'layout-dashboard'),
        quickLink('ops-review', 'Open review queue', '/review', 'Inspect approval checkpoints without replacing Aries OS.', 'workflow'),
        quickLink('ops-docs', 'Open documentation', '/documentation', 'Jump to repo-facing docs in a new tab.', 'book-open'),
        quickLink('ops-settings', 'Open settings', '/settings', 'Launch operator settings separately.', 'settings-2'),
      ],
      prioritySections,
      contractFiles,
      sessionFiles,
    },
    brain: {
      metrics: makeMetrics([
        {
          label: 'Daily briefs',
          value: String(briefs.length),
          detail: 'Markdown briefs discovered under docs/briefs.',
        },
        {
          label: 'Memory notes',
          value: String(memoryNotes.length),
          detail: 'Durable notes currently available in memory/.',
        },
        {
          label: 'System reference',
          value: systemReference ? 'Live' : 'Missing',
          detail: systemReference ? systemReference.updatedAgo : 'docs/SYSTEM-REFERENCE.md is missing.',
        },
        {
          label: 'Latest brief',
          value: briefs[0]?.updatedAgo || 'Unavailable',
          detail: briefs[0]?.title || 'No brief files found yet.',
        },
      ]),
      tools: [
        quickLink('brain-docs', 'Open docs hub', '/documentation', 'Open repo docs without replacing the shell.', 'book-open'),
        quickLink('brain-results', 'Open results', '/results', 'Launch reporting surfaces in a new tab.', 'brain'),
        quickLink('brain-api', 'Open API docs', '/api-docs', 'Inspect API documentation separately.', 'scroll-text'),
      ],
      briefs,
      systemReference,
      memoryNotes,
    },
    lab: {
      metrics: makeMetrics([
        {
          label: 'Prototype artifacts',
          value: String(prototypes.length),
          detail: 'Recent output/* artifacts detected on disk.',
        },
        {
          label: 'Overnight builds',
          value: String(overnightBuilds.length),
          detail: 'Recent generated/validated and runtime generated outputs.',
        },
        {
          label: 'Self-improvement notes',
          value: String(selfImprovementNotes.length),
          detail: 'Memory notes containing overnight self-improvement logs.',
        },
        {
          label: 'Build logs',
          value: String(buildLogs.length),
          detail: 'Captured smoke/test artifacts under .artifacts.',
        },
      ]),
      tools: [
        quickLink('lab-features', 'Open feature registry', '/features', 'Inspect current feature-facing routes in a new tab.', 'sparkles'),
        quickLink('lab-campaigns', 'Open campaigns', '/campaigns', 'Jump into campaign artifacts separately.', 'rocket'),
        quickLink('lab-platforms', 'Open platforms', '/platforms', 'Review connected platform surfaces in a new tab.', 'wrench'),
      ],
      prototypes,
      overnightBuilds,
      selfImprovementNotes,
      buildLogs,
    },
  };
}
