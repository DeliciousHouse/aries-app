import path from 'node:path'
import {
  appendText,
  collectUncheckedBoxes,
  currentDateInfo,
  emitSummary,
  listFiles,
  memoryDir,
  normalizeMarkdownWhitespace,
  parseArgs,
  readText,
  relative,
  repoRoot,
  writeText,
} from './lib/common.mjs'

const flags = parseArgs()
const dryRun = flags.has('--dry-run')
const audits = ['docs-drift', 'backlog-hygiene', 'broken-links', 'stale-files', 'weak-prompts']
const { date, stamp } = currentDateInfo()
const dayNumber = Number(date.replace(/-/g, ''))
const focus = audits[dayNumber % audits.length]
const markdownFiles = listFiles(repoRoot, (file) => file.endsWith('.md'))

function findBrokenLinks() {
  const failures = []
  for (const file of markdownFiles) {
    const content = readText(file)
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]
      if (!target || target.startsWith('http://') || target.startsWith('https://') || target.startsWith('#')) continue
      const cleanTarget = target.split('#')[0]
      const resolved = path.resolve(path.dirname(file), cleanTarget)
      if (!cleanTarget || resolved.includes('mailto:')) continue
      if (!readText(resolved, null) && !readText(`${resolved}.md`, null)) {
        failures.push(`${relative(file)} -> ${target}`)
      }
    }
  }
  return failures
}

function findWeakPrompts() {
  const hits = []
  for (const file of listFiles(repoRoot, (candidate) => /\.(md|ts|tsx|mjs|json)$/i.test(candidate))) {
    const content = readText(file)
    if (/\b(TODO|TBD|placeholder|lorem ipsum|fill me in)\b/i.test(content)) {
      hits.push(relative(file))
    }
  }
  return hits.slice(0, 12)
}

function findStaleFiles() {
  return listFiles(repoRoot, (file) => /\.(md|ts|tsx|mjs)$/i.test(file))
    .filter((file) => {
      const content = readText(file)
      return content.trim().length === 0 || content.includes('TODO')
    })
    .map(relative)
    .slice(0, 12)
}

function backlogItems() {
  return ['PRIORITIES.md', 'ROADMAP.md', 'HEARTBEAT.md']
    .flatMap((file) => collectUncheckedBoxes(readText(path.join(repoRoot, file))))
    .slice(0, 12)
}

const findings = {
  'docs-drift': markdownFiles.filter((file) => /README|SETUP|HANDOFF|MANIFEST/.test(path.basename(file))).map(relative).slice(0, 12),
  'backlog-hygiene': backlogItems(),
  'broken-links': findBrokenLinks(),
  'stale-files': findStaleFiles(),
  'weak-prompts': findWeakPrompts(),
}[focus]

const normalized = markdownFiles
  .filter((file) => /^(README|SETUP|ROADMAP|PRIORITIES|HEARTBEAT|MEMORY|OPERATING_STRUCTURE|SOUL|AGENTS|USER|IDENTITY|docs\/.*|skills\/.*)/.test(relative(file)))
  .slice(0, 40)

let fixCount = 0
if (!dryRun) {
  for (const file of normalized) {
    if (normalizeMarkdownWhitespace(file)) fixCount += 1
  }
}

const logBlock = [
  `## Overnight self-improvement — ${stamp}`,
  `- focus: ${focus}`,
  `- findings: ${findings.length}`,
  `- low-risk fixes applied: ${dryRun ? 'dry-run only' : fixCount}`,
  findings.length ? `- examples: ${findings.slice(0, 5).join(' | ')}` : '- examples: none',
  '',
].join('\n')

if (!dryRun) {
  appendText(path.join(memoryDir, `${date}.md`), logBlock)
}

emitSummary([
  dryRun ? 'SELF-IMPROVE DRY RUN' : 'SELF-IMPROVE OK',
  `- focus: ${focus}`,
  `- findings: ${findings.length}`,
  `- low-risk fixes: ${dryRun ? 0 : fixCount}`,
  `- memory log: memory/${date}.md`,
  findings.length ? `- examples: ${findings.slice(0, 3).join('; ')}` : '- examples: none',
])
