'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Bot,
  Brain,
  BriefcaseBusiness,
  Compass,
  FileStack,
  FolderKanban,
  LayoutDashboard,
  Microscope,
  Rocket,
  ScrollText,
  Settings2,
  Sparkles,
  Terminal,
  Workflow,
  Wrench,
} from 'lucide-react';

import type {
  AriesOsFileItem,
  AriesOsIconName,
  AriesOsMarkdownDocument,
  AriesOsMetric,
  AriesOsQuickLink,
  AriesOsSection,
  AriesOsWorkspaceData,
} from './types';
import styles from './shell.module.css';

type ModuleId = 'ops' | 'brain' | 'lab';
type TabId =
  | 'dashboard'
  | 'priorities'
  | 'contracts'
  | 'sessions'
  | 'daily-briefs'
  | 'system-reference'
  | 'memory'
  | 'prototypes'
  | 'overnight-builds'
  | 'self-improvement'
  | 'build-logs';

type ModuleConfig = {
  id: ModuleId;
  title: string;
  description: string;
  hue: {
    accent: string;
    glow: string;
  };
  badge: AriesOsIconName;
  tabs: Array<{ id: TabId; label: string; icon: AriesOsIconName }>;
};

const moduleConfigs: Record<ModuleId, ModuleConfig> = {
  ops: {
    id: 'ops',
    title: 'Ops',
    description: 'Execution pressure, contracts, and current session visibility.',
    hue: {
      accent: '#F6B94C',
      glow: 'rgba(246, 185, 76, 0.35)',
    },
    badge: 'briefcase-business',
    tabs: [
      { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
      { id: 'priorities', label: 'Priorities', icon: 'compass' },
      { id: 'contracts', label: 'Contracts', icon: 'scroll-text' },
      { id: 'sessions', label: 'Sessions', icon: 'workflow' },
    ],
  },
  brain: {
    id: 'brain',
    title: 'Brain',
    description: 'Daily briefs, reference material, and durable operating memory.',
    hue: {
      accent: '#66B8FF',
      glow: 'rgba(102, 184, 255, 0.32)',
    },
    badge: 'brain',
    tabs: [
      { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
      { id: 'daily-briefs', label: 'Daily Briefs', icon: 'book-open' },
      { id: 'system-reference', label: 'System Reference', icon: 'scroll-text' },
      { id: 'memory', label: 'Memory', icon: 'bot' },
    ],
  },
  lab: {
    id: 'lab',
    title: 'Lab',
    description: 'Prototype outputs, overnight builds, self-improvement, and artifact logs.',
    hue: {
      accent: '#59F28C',
      glow: 'rgba(89, 242, 140, 0.30)',
    },
    badge: 'microscope',
    tabs: [
      { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
      { id: 'prototypes', label: 'Prototypes', icon: 'folder-kanban' },
      { id: 'overnight-builds', label: 'Overnight Builds', icon: 'rocket' },
      { id: 'self-improvement', label: 'Self-Improve', icon: 'sparkles' },
      { id: 'build-logs', label: 'Build Logs', icon: 'terminal' },
    ],
  },
};

const iconMap: Record<AriesOsIconName, typeof Activity> = {
  activity: Activity,
  'book-open': BookOpen,
  bot: Bot,
  brain: Brain,
  'briefcase-business': BriefcaseBusiness,
  compass: Compass,
  'file-stack': FileStack,
  'folder-kanban': FolderKanban,
  'layout-dashboard': LayoutDashboard,
  microscope: Microscope,
  rocket: Rocket,
  'scroll-text': ScrollText,
  'settings-2': Settings2,
  sparkles: Sparkles,
  terminal: Terminal,
  workflow: Workflow,
  wrench: Wrench,
};

function Icon({ name, className }: { name: AriesOsIconName; className?: string }) {
  const LucideIcon = iconMap[name];
  return <LucideIcon className={className} size={18} strokeWidth={1.8} />;
}

function MetricCard({ metric, icon }: { metric: AriesOsMetric; icon: AriesOsIconName }) {
  return (
    <div className={styles.metric}>
      <div className={styles.metricHead}>
        <Icon name={icon} className={styles.metricIcon} />
        <div>
          <p className={styles.metricLabel}>{metric.label}</p>
          <h3 className={styles.metricValue}>{metric.value}</h3>
        </div>
      </div>
      <p className={styles.metricDetail}>{metric.detail}</p>
    </div>
  );
}

function ToolButton({ tool }: { tool: AriesOsQuickLink }) {
  return (
    <a className={styles.toolButton} href={tool.href} target="_blank" rel="noreferrer">
      <Icon name={tool.icon} />
      <span>
        <span className={styles.toolTitle}>{tool.label}</span>
        <span className={styles.toolText}>{tool.description}</span>
      </span>
      <ArrowUpRight size={16} />
    </a>
  );
}

function FileCard({ item, prototype = false }: { item: AriesOsFileItem; prototype?: boolean }) {
  return (
    <article className={[styles.fileCard, prototype ? styles.fileCardPrototype : ''].filter(Boolean).join(' ')}>
      <div className={styles.fileMeta}>
        <span className={styles.typePill}>{item.kind}</span>
        <span className={styles.statPill}>{item.extension}</span>
        <span className={styles.statPill}>{item.sizeLabel}</span>
        <span className={styles.statPill}>{item.updatedAgo}</span>
      </div>
      <h3 className={styles.fileTitle}>{item.name}</h3>
      <p className={styles.copy}>{item.summary}</p>
      <div className={styles.fileMeta}>
        <span className={styles.pathPill}>{item.path}</span>
        <span className={styles.statPill}>{item.updatedAt}</span>
      </div>
    </article>
  );
}

function DetailsList({ sections }: { sections: AriesOsSection[] }) {
  if (sections.length === 0) {
    return <EmptyState label="No sections found" copy="No checklist sections were parsed from the current file." />;
  }

  return (
    <div className={styles.detailsStack}>
      {sections.map((section, index) => (
        <details key={`${section.title}-${index}`} className={styles.details} open={index === 0}>
          <summary>
            <span>
              <p className={styles.cardKicker}>Section</p>
              <strong>{section.title}</strong>
            </span>
            <span className={styles.statPill}>{section.items.length} items</span>
          </summary>
          <div className={styles.detailsBody}>
            <ul className={styles.markdown}>
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </details>
      ))}
    </div>
  );
}

function EmptyState({ label, copy }: { label: string; copy: string }) {
  return (
    <div className={styles.emptyState}>
      <p className={styles.emptyKicker}>Empty state</p>
      <h3 className={styles.panelTitle}>{label}</h3>
      <p className={styles.emptyCopy}>{copy}</p>
    </div>
  );
}

function MarkdownView({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);

  return (
    <div className={styles.markdown}>
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          if (block.level === 1) return <h1 key={index}>{block.text}</h1>;
          if (block.level === 2) return <h2 key={index}>{block.text}</h2>;
          if (block.level === 3) return <h3 key={index}>{block.text}</h3>;
          return <h4 key={index}>{block.text}</h4>;
        }
        if (block.type === 'list') {
          return (
            <ul key={index}>
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ordered-list') {
          return (
            <ol key={index}>
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          );
        }
        if (block.type === 'blockquote') {
          return <blockquote key={index}>{block.text}</blockquote>;
        }
        if (block.type === 'code') {
          return <pre key={index}>{block.text}</pre>;
        }
        return <p key={index}>{block.text}</p>;
      })}
    </div>
  );
}

function parseMarkdown(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const blocks: Array<
    | { type: 'heading'; level: number; text: string }
    | { type: 'paragraph'; text: string }
    | { type: 'list'; items: string[] }
    | { type: 'ordered-list'; items: string[] }
    | { type: 'blockquote'; text: string }
    | { type: 'code'; text: string }
  > = [];

  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index] ?? '';
    const line = rawLine.trim();

    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const buffer: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        buffer.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: 'code', text: buffer.join('\n') });
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push({ type: 'ordered-list', items });
      continue;
    }

    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'blockquote', text: quote.join(' ') });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      const next = lines[index].trim();
      if (/^(#{1,4}|[-*]|\d+\.|>|```)/.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
      continue;
    }

    index += 1;
  }

  return blocks;
}

function DailyBriefRail({
  briefs,
  selectedBriefId,
  onSelect,
}: {
  briefs: AriesOsMarkdownDocument[];
  selectedBriefId: string | null;
  onSelect: (id: string) => void;
}) {
  if (briefs.length === 0) {
    return <EmptyState label="No daily briefs yet" copy="docs/briefs is empty, so Brain has nothing truthful to render." />;
  }

  return (
    <div className={styles.historyList}>
      {briefs.map((brief) => (
        <button
          key={brief.id}
          type="button"
          onClick={() => onSelect(brief.id)}
          className={[styles.historyItem, selectedBriefId === brief.id ? styles.historyItemActive : ''].filter(Boolean).join(' ')}
        >
          <p className={styles.historyMeta}>{brief.updatedAgo}</p>
          <h3 className={styles.historyTitle}>{brief.title}</h3>
          <p className={styles.copy}>{brief.summary}</p>
          <div className={styles.historyMeta}>
            <span className={styles.pathPill}>{brief.path}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

export default function AriesOsShell({ data }: { data: AriesOsWorkspaceData }) {
  const [activeModule, setActiveModule] = useState<ModuleId>('ops');
  const [tabOrder, setTabOrder] = useState<Record<ModuleId, TabId[]>>({
    ops: moduleConfigs.ops.tabs.map((tab) => tab.id),
    brain: moduleConfigs.brain.tabs.map((tab) => tab.id),
    lab: moduleConfigs.lab.tabs.map((tab) => tab.id),
  });
  const [selectedTabs, setSelectedTabs] = useState<Record<ModuleId, TabId>>({
    ops: 'dashboard',
    brain: 'dashboard',
    lab: 'dashboard',
  });
  const [draggedTab, setDraggedTab] = useState<{ moduleId: ModuleId; tabId: TabId } | null>(null);
  const [selectedBriefId, setSelectedBriefId] = useState<string | null>(data.brain.briefs[0]?.id ?? null);

  useEffect(() => {
    if (!data.brain.briefs.find((brief) => brief.id === selectedBriefId)) {
      setSelectedBriefId(data.brain.briefs[0]?.id ?? null);
    }
  }, [data.brain.briefs, selectedBriefId]);

  const config = moduleConfigs[activeModule];
  const activeTabId = selectedTabs[activeModule];
  const activeTabs = tabOrder[activeModule]
    .map((tabId) => config.tabs.find((tab) => tab.id === tabId))
    .filter((tab): tab is NonNullable<typeof tab> => Boolean(tab));
  const selectedBrief = data.brain.briefs.find((brief) => brief.id === selectedBriefId) ?? data.brain.briefs[0] ?? null;

  const themeStyle = {
    '--module-accent': config.hue.accent,
    '--module-glow': config.hue.glow,
  } as CSSProperties;

  function reorderTabs(moduleId: ModuleId, targetTabId: TabId) {
    if (!draggedTab || draggedTab.moduleId !== moduleId || draggedTab.tabId === targetTabId) {
      return;
    }
    setTabOrder((current) => {
      const next = [...current[moduleId]];
      const sourceIndex = next.indexOf(draggedTab.tabId);
      const targetIndex = next.indexOf(targetTabId);
      if (sourceIndex === -1 || targetIndex === -1) {
        return current;
      }
      next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, draggedTab.tabId);
      return { ...current, [moduleId]: next };
    });
  }

  return (
    <div className={styles.shell} style={themeStyle}>
      <div className={styles.shellInner}>
        <section className={styles.topbar}>
          <div className={[styles.surface, styles.brandPanel].join(' ')}>
            <div className={styles.brandLockup}>
              <div className={styles.brandGlyph}>
                <Icon name={config.badge} className={styles.tabIcon} />
              </div>
              <div>
                <p className={styles.kicker}>Production shell</p>
                <h1 className={styles.title}>{data.runtime.displayName}</h1>
                <p className={styles.subtitle}>
                  Ops, Brain, and Lab now live inside one truthful filesystem-backed shell with draggable feature tabs and new-tab launch surfaces.
                </p>
              </div>
            </div>
            <div>
              <p className={styles.metaLabel}>Generated</p>
              <p className={styles.copy}>{data.generatedAt}</p>
              <p className={styles.metaLabel}>Build mode</p>
              <p className={styles.copy}>{data.runtime.productionOnly ? 'Production-only runtime' : 'Mixed runtime'}</p>
            </div>
          </div>

          <div className={[styles.surface, styles.runtimePanel].join(' ')}>
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.kicker}>Runtime contract</p>
                <h2 className={styles.panelTitle}>8100 + truthful paths</h2>
              </div>
            </div>
            <div className={styles.runtimeGrid}>
              <div className={styles.runtimeCell}>
                <p className={styles.metaLabel}>Port</p>
                <p className={styles.runtimeText}>{data.runtime.port}</p>
              </div>
              <div className={styles.runtimeCell}>
                <p className={styles.metaLabel}>Start</p>
                <p className={styles.runtimeText}>{data.runtime.scripts.start}</p>
              </div>
              <div className={styles.runtimeCell}>
                <p className={styles.metaLabel}>Code root</p>
                <p className={styles.runtimeText}>{data.runtime.codeRoot}</p>
              </div>
              <div className={styles.runtimeCell}>
                <p className={styles.metaLabel}>Data root</p>
                <p className={styles.runtimeText}>{data.runtime.dataRoot}</p>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.surface}>
          <aside className={styles.moduleRail}>
            {(Object.keys(moduleConfigs) as ModuleId[]).map((moduleId) => {
              const module = moduleConfigs[moduleId];
              return (
                <button
                  key={moduleId}
                  type="button"
                  className={[styles.moduleButton, activeModule === moduleId ? styles.moduleButtonActive : ''].filter(Boolean).join(' ')}
                  onClick={() => setActiveModule(moduleId)}
                >
                  <div className={styles.moduleBadge}>
                    <Icon name={module.badge} className={styles.tabIcon} />
                  </div>
                  <h2 className={styles.moduleTitle}>{module.title}</h2>
                  <p className={styles.moduleCopy}>{module.description}</p>
                  <span className={styles.moduleTag}>{module.tabs.length} tabs live</span>
                </button>
              );
            })}

            <div className={styles.metricStack}>
              {(activeModule === 'ops' ? data.ops.metrics : activeModule === 'brain' ? data.brain.metrics : data.lab.metrics).map(
                (metric, index) => (
                  <MetricCard
                    key={`${metric.label}-${index}`}
                    metric={metric}
                    icon={activeModule === 'ops' ? ['activity', 'compass', 'scroll-text', 'workflow'][index] as AriesOsIconName : activeModule === 'brain' ? ['brain', 'book-open', 'scroll-text', 'bot'][index] as AriesOsIconName : ['microscope', 'rocket', 'sparkles', 'terminal'][index] as AriesOsIconName}
                  />
                ),
              )}
            </div>
          </aside>

          <main className={styles.mainPane}>
            <header className={[styles.panel, styles.mainHeader].join(' ')}>
              <div className={styles.mainHeaderText}>
                <p className={styles.kicker}>{config.title} module</p>
                <div className={styles.moduleTitleRow}>
                  <h2 className={styles.panelTitle}>{config.description}</h2>
                  <span className={styles.statPill}>Default tab: Dashboard</span>
                </div>
              </div>
              <div className={styles.toolSelector}>
                {(activeModule === 'ops' ? data.ops.tools : activeModule === 'brain' ? data.brain.tools : data.lab.tools).map((tool) => (
                  <ToolButton key={tool.id} tool={tool} />
                ))}
              </div>
            </header>

            <div className={styles.tabStrip}>
              {activeTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  draggable
                  onDragStart={() => setDraggedTab({ moduleId: activeModule, tabId: tab.id })}
                  onDragEnd={() => setDraggedTab(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => reorderTabs(activeModule, tab.id)}
                  onClick={() => setSelectedTabs((current) => ({ ...current, [activeModule]: tab.id }))}
                  className={[styles.tab, activeTabId === tab.id ? styles.tabActive : ''].filter(Boolean).join(' ')}
                >
                  <Icon name={tab.icon} className={styles.tabIcon} />
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            {activeModule === 'ops' && activeTabId === 'dashboard' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Dashboard</p>
                      <h3 className={styles.panelTitle}>Current operating contract</h3>
                    </div>
                    <span className={styles.statPill}>Filesystem truth</span>
                  </div>
                  <div className={styles.fileList}>
                    {data.ops.contractFiles.map((item) => (
                      <FileCard key={item.id} item={item} />
                    ))}
                  </div>
                </section>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Priority ledger</p>
                      <h3 className={styles.panelTitle}>Top parsed sections</h3>
                    </div>
                  </div>
                  <div className={styles.scrollPane}>
                    <DetailsList sections={data.ops.prioritySections} />
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'ops' && activeTabId === 'priorities' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Priorities</p>
                      <h3 className={styles.panelTitle}>Active work without fabricated status</h3>
                    </div>
                  </div>
                  <div className={styles.scrollPane}>
                    <DetailsList sections={data.ops.prioritySections} />
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'ops' && activeTabId === 'contracts' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Contracts</p>
                      <h3 className={styles.panelTitle}>Repo authority surfaces</h3>
                    </div>
                  </div>
                  <div className={styles.fileList}>
                    {data.ops.contractFiles.length > 0 ? (
                      data.ops.contractFiles.map((item) => <FileCard key={item.id} item={item} />)
                    ) : (
                      <EmptyState label="No contract files found" copy="Expected contract files are missing from the workspace." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'ops' && activeTabId === 'sessions' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Sessions</p>
                      <h3 className={styles.panelTitle}>Serialized runtime sessions on disk</h3>
                    </div>
                  </div>
                  <div className={styles.fileList}>
                    {data.ops.sessionFiles.length > 0 ? (
                      data.ops.sessionFiles.map((item) => <FileCard key={item.id} item={item} />)
                    ) : (
                      <EmptyState label="No session files" copy="state/sessions has no JSON session payloads right now." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'brain' && activeTabId === 'dashboard' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Latest brief</p>
                      <h3 className={styles.panelTitle}>{selectedBrief?.title ?? 'No brief selected'}</h3>
                    </div>
                    {selectedBrief ? <span className={styles.statPill}>{selectedBrief.updatedAgo}</span> : null}
                  </div>
                  <div className={styles.scrollPane}>
                    {selectedBrief ? (
                      <MarkdownView markdown={selectedBrief.markdown} />
                    ) : (
                      <EmptyState label="No briefs yet" copy="docs/briefs does not have any markdown files yet." />
                    )}
                  </div>
                </section>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Reference materials</p>
                      <h3 className={styles.panelTitle}>System reference and memory</h3>
                    </div>
                  </div>
                  <div className={styles.detailsStack}>
                    {data.brain.systemReference ? (
                      <details className={styles.details} open>
                        <summary>
                          <span>
                            <p className={styles.cardKicker}>System reference</p>
                            <strong>{data.brain.systemReference.title}</strong>
                          </span>
                          <span className={styles.statPill}>{data.brain.systemReference.updatedAgo}</span>
                        </summary>
                        <div className={styles.detailsBody}>
                          <p className={styles.copy}>{data.brain.systemReference.summary}</p>
                          <p className={styles.fileMeta}><span className={styles.pathPill}>{data.brain.systemReference.path}</span></p>
                        </div>
                      </details>
                    ) : (
                      <EmptyState label="System reference missing" copy="docs/SYSTEM-REFERENCE.md is not available." />
                    )}
                    {data.brain.memoryNotes.slice(0, 5).map((note, index) => (
                      <details key={note.id} className={styles.details} open={index === 0}>
                        <summary>
                          <span>
                            <p className={styles.cardKicker}>Memory</p>
                            <strong>{note.title}</strong>
                          </span>
                          <span className={styles.statPill}>{note.updatedAgo}</span>
                        </summary>
                        <div className={styles.detailsBody}>
                          <p className={styles.copy}>{note.summary}</p>
                          <p className={styles.fileMeta}><span className={styles.pathPill}>{note.path}</span></p>
                        </div>
                      </details>
                    ))}
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'brain' && activeTabId === 'daily-briefs' ? (
              <div className={[styles.contentGrid, styles.contentGridSplit].join(' ')}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>History rail</p>
                      <h3 className={styles.panelTitle}>Daily brief archive</h3>
                    </div>
                  </div>
                  <div className={styles.scrollPane}>
                    <DailyBriefRail briefs={data.brain.briefs} selectedBriefId={selectedBriefId} onSelect={setSelectedBriefId} />
                  </div>
                </section>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Renderer</p>
                      <h3 className={styles.panelTitle}>{selectedBrief?.title ?? 'No brief selected'}</h3>
                    </div>
                    {selectedBrief ? <span className={styles.pathPill}>{selectedBrief.path}</span> : null}
                  </div>
                  <div className={styles.scrollPane}>
                    {selectedBrief ? (
                      <MarkdownView markdown={selectedBrief.markdown} />
                    ) : (
                      <EmptyState label="No brief selected" copy="Pick a brief from the left rail to inspect priorities and follow-ups." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'brain' && activeTabId === 'system-reference' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>System reference</p>
                      <h3 className={styles.panelTitle}>{data.brain.systemReference?.title ?? 'Missing system reference'}</h3>
                    </div>
                    {data.brain.systemReference ? <span className={styles.statPill}>{data.brain.systemReference.updatedAgo}</span> : null}
                  </div>
                  <div className={styles.scrollPane}>
                    {data.brain.systemReference ? (
                      <MarkdownView markdown={data.brain.systemReference.markdown} />
                    ) : (
                      <EmptyState label="System reference missing" copy="docs/SYSTEM-REFERENCE.md could not be loaded." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'brain' && activeTabId === 'memory' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Memory notes</p>
                      <h3 className={styles.panelTitle}>Latest durable context files</h3>
                    </div>
                  </div>
                  <div className={styles.detailsStack}>
                    {data.brain.memoryNotes.length > 0 ? (
                      data.brain.memoryNotes.map((note, index) => (
                        <details key={note.id} className={styles.details} open={index === 0}>
                          <summary>
                            <span>
                              <p className={styles.cardKicker}>Memory note</p>
                              <strong>{note.title}</strong>
                            </span>
                            <span className={styles.statPill}>{note.updatedAgo}</span>
                          </summary>
                          <div className={styles.detailsBody}>
                            <p className={styles.fileMeta}><span className={styles.pathPill}>{note.path}</span></p>
                            <MarkdownView markdown={note.markdown} />
                          </div>
                        </details>
                      ))
                    ) : (
                      <EmptyState label="No memory notes" copy="memory/ does not contain readable markdown notes right now." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'lab' && activeTabId === 'dashboard' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Prototype deck</p>
                      <h3 className={styles.panelTitle}>Recent output artifacts</h3>
                    </div>
                  </div>
                  <div className={styles.fileList}>
                    {data.lab.prototypes.length > 0 ? (
                      data.lab.prototypes.slice(0, 6).map((item) => <FileCard key={item.id} item={item} prototype />)
                    ) : (
                      <EmptyState label="No prototypes" copy="output/ is empty, so Lab has nothing truthful to surface yet." />
                    )}
                  </div>
                </section>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Automation traces</p>
                      <h3 className={styles.panelTitle}>Overnight builds + self-improvement</h3>
                    </div>
                  </div>
                  <div className={styles.detailsStack}>
                    <details className={styles.details} open>
                      <summary>
                        <span>
                          <p className={styles.cardKicker}>Overnight builds</p>
                          <strong>{data.lab.overnightBuilds.length} tracked artifacts</strong>
                        </span>
                      </summary>
                      <div className={styles.detailsBody}>
                        <div className={styles.fileList}>
                          {data.lab.overnightBuilds.slice(0, 4).map((item) => (
                            <FileCard key={item.id} item={item} />
                          ))}
                        </div>
                      </div>
                    </details>
                    <details className={styles.details}>
                      <summary>
                        <span>
                          <p className={styles.cardKicker}>Self-improvement</p>
                          <strong>{data.lab.selfImprovementNotes.length} memory notes</strong>
                        </span>
                      </summary>
                      <div className={styles.detailsBody}>
                        {data.lab.selfImprovementNotes.length > 0 ? (
                          <div className={styles.detailsStack}>
                            {data.lab.selfImprovementNotes.slice(0, 4).map((note) => (
                              <Fragment key={note.id}>
                                <p className={styles.fileMeta}><span className={styles.pathPill}>{note.path}</span></p>
                                <p className={styles.copy}>{note.summary}</p>
                              </Fragment>
                            ))}
                          </div>
                        ) : (
                          <EmptyState label="No self-improvement notes" copy="No memory files include the overnight self-improvement marker yet." />
                        )}
                      </div>
                    </details>
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'lab' && activeTabId === 'prototypes' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Prototypes</p>
                      <h3 className={styles.panelTitle}>output/* and campaign artifact snapshots</h3>
                    </div>
                  </div>
                  <div className={styles.fileList}>
                    {data.lab.prototypes.length > 0 ? (
                      data.lab.prototypes.map((item) => <FileCard key={item.id} item={item} prototype />)
                    ) : (
                      <EmptyState label="No prototype artifacts" copy="output/ does not contain markdown, HTML, JSON, CSS, or archive artifacts yet." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'lab' && activeTabId === 'overnight-builds' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Overnight builds</p>
                      <h3 className={styles.panelTitle}>generated/validated plus runtime generated output</h3>
                    </div>
                  </div>
                  <div className={styles.fileList}>
                    {data.lab.overnightBuilds.length > 0 ? (
                      data.lab.overnightBuilds.map((item) => <FileCard key={item.id} item={item} />)
                    ) : (
                      <EmptyState label="No overnight builds" copy="generated/validated and runtime generated roots are empty right now." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'lab' && activeTabId === 'self-improvement' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Self-improvement</p>
                      <h3 className={styles.panelTitle}>Overnight notes pulled straight from memory/</h3>
                    </div>
                  </div>
                  <div className={styles.detailsStack}>
                    {data.lab.selfImprovementNotes.length > 0 ? (
                      data.lab.selfImprovementNotes.map((note, index) => (
                        <details key={note.id} className={styles.details} open={index === 0}>
                          <summary>
                            <span>
                              <p className={styles.cardKicker}>Memory note</p>
                              <strong>{note.title}</strong>
                            </span>
                            <span className={styles.statPill}>{note.updatedAgo}</span>
                          </summary>
                          <div className={styles.detailsBody}>
                            <p className={styles.fileMeta}><span className={styles.pathPill}>{note.path}</span></p>
                            <MarkdownView markdown={note.markdown} />
                          </div>
                        </details>
                      ))
                    ) : (
                      <EmptyState label="No self-improvement logs" copy="memory/ contains no markdown entries with an overnight self-improvement section yet." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {activeModule === 'lab' && activeTabId === 'build-logs' ? (
              <div className={styles.contentGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div>
                      <p className={styles.cardKicker}>Build logs</p>
                      <h3 className={styles.panelTitle}>Smoke and screenshot artifacts from .artifacts</h3>
                    </div>
                  </div>
                  <div className={styles.fileList}>
                    {data.lab.buildLogs.length > 0 ? (
                      data.lab.buildLogs.map((item) => <FileCard key={item.id} item={item} />)
                    ) : (
                      <EmptyState label="No build logs" copy=".artifacts does not contain HTML, JSON, or PNG traces right now." />
                    )}
                  </div>
                </section>
              </div>
            ) : null}
          </main>
        </section>
      </div>

      <nav className={styles.dock} aria-label="Aries OS dock">
        {(Object.keys(moduleConfigs) as ModuleId[]).map((moduleId) => (
          <button
            key={moduleId}
            type="button"
            className={[styles.dockItem, activeModule === moduleId ? styles.dockItemActive : ''].filter(Boolean).join(' ')}
            onClick={() => setActiveModule(moduleId)}
            aria-label={`Open ${moduleConfigs[moduleId].title}`}
            title={moduleConfigs[moduleId].title}
          >
            <Icon name={moduleConfigs[moduleId].badge} />
          </button>
        ))}
        <a className={styles.dockItem} href="/" target="_blank" rel="noreferrer" aria-label="Open home" title="Open home">
          <Icon name="layout-dashboard" />
        </a>
        <a className={styles.dockItem} href="/documentation" target="_blank" rel="noreferrer" aria-label="Open docs" title="Open docs">
          <Icon name="book-open" />
        </a>
      </nav>
    </div>
  );
}
