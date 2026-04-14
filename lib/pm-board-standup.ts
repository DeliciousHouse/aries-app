import fs from 'node:fs';
import path from 'node:path';

export type PmBoardStandupChief = {
  chiefId: string;
  title: string;
  reportStatus: 'complete' | 'partial' | 'failed';
  currentStatus: string;
  activeTaskId: string | null;
  blockedCount: number;
  needsRouting: boolean;
};

export type PmBoardStandupSnapshot = {
  id: string;
  title: string;
  date: string;
  status: 'complete' | 'partial' | 'failed';
  generatedAt: string | null;
  preview: string;
  boardPath: string | null;
  transcriptPath: string;
  reportDirectory: string | null;
  transcriptBody: string;
  chiefs: PmBoardStandupChief[];
};

const sharedTeamsRoot = '/home/node/.openclaw/projects/shared/teams';
const meetingsRoot = path.join(sharedTeamsRoot, 'meetings');
const standupsRoot = path.join(sharedTeamsRoot, 'standups');

function exists(targetPath: string) {
  return fs.existsSync(targetPath);
}

function parseFrontmatter(source: string) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {} as Record<string, string>, body: source.trim() };
  }

  const [, rawFrontmatter, body] = match;
  const frontmatter = rawFrontmatter.split('\n').reduce<Record<string, string>>((accumulator, line) => {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      return accumulator;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    accumulator[key] = value;
    return accumulator;
  }, {});

  return { frontmatter, body: body.trim() };
}

function firstBullet(section: string) {
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bullet = lines.find((line) => /^-\s+/.test(line));
  return bullet ? bullet.replace(/^-\s+/, '') : lines[0] || 'No standup summary is available.';
}

function extractSection(body: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |\\Z)`, 'm');
  const match = body.match(regex);
  return match?.[1]?.trim() || '';
}

function safeReadJson<T>(filePath: string): T | null {
  if (!exists(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readChiefReports(date: string): PmBoardStandupChief[] {
  const directory = path.join(standupsRoot, date);
  if (!exists(directory)) {
    return [];
  }

  return fs.readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => safeReadJson<Record<string, any>>(path.join(directory, entry)))
    .filter((payload): payload is Record<string, any> => Boolean(payload))
    .map((payload) => ({
      chiefId: typeof payload.chiefId === 'string' ? payload.chiefId : 'unknown',
      title: typeof payload.title === 'string' ? payload.title : 'Unnamed chief',
      reportStatus: payload.reportStatus === 'complete' || payload.reportStatus === 'failed' ? payload.reportStatus : 'partial',
      currentStatus: typeof payload.currentStatus === 'string' ? payload.currentStatus : 'unknown',
      activeTaskId: typeof payload.activeTaskId === 'string' ? payload.activeTaskId : null,
      blockedCount: Array.isArray(payload.blockers) ? payload.blockers.length : 0,
      needsRouting: Array.isArray(payload.needsJarvisRouting) ? payload.needsJarvisRouting.length > 0 : false,
    }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

export function getLatestPmBoardStandup(): PmBoardStandupSnapshot | null {
  if (!exists(meetingsRoot)) {
    return null;
  }

  const latestFile = fs.readdirSync(meetingsRoot)
    .filter((entry) => entry.endsWith('.md') && entry !== 'README.md')
    .map((entry) => path.join(meetingsRoot, entry))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];

  if (!latestFile) {
    return null;
  }

  const source = fs.readFileSync(latestFile, 'utf8');
  const { frontmatter, body } = parseFrontmatter(source);
  const stats = fs.statSync(latestFile);
  const date = frontmatter.date || path.basename(latestFile).match(/(\d{4}-\d{2}-\d{2})/)?.[1] || new Date(stats.mtimeMs).toISOString().slice(0, 10);
  const chiefs = readChiefReports(date);
  const reportDirectoryAbsolute = path.join(standupsRoot, date);

  return {
    id: frontmatter.standup_id || path.basename(latestFile, '.md'),
    title: frontmatter.title || `Daily Standup — ${date}`,
    date,
    status: frontmatter.status === 'complete' || frontmatter.status === 'failed' ? frontmatter.status : 'partial',
    generatedAt: frontmatter.generated_at || null,
    preview: firstBullet(extractSection(body, 'Top Summary') || extractSection(body, 'Standup Health') || body),
    boardPath: frontmatter.board_path || null,
    transcriptPath: latestFile,
    reportDirectory: exists(reportDirectoryAbsolute) ? reportDirectoryAbsolute : null,
    transcriptBody: body,
    chiefs,
  };
}
