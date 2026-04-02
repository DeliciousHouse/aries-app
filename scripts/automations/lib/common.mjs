import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
export const docsDir = path.join(repoRoot, 'docs')
export const briefsDir = path.join(docsDir, 'briefs')
export const memoryDir = path.join(repoRoot, 'memory')

export function parseArgs(argv = process.argv.slice(2)) {
  return new Set(argv)
}

export function hasFlag(flags, name) {
  return flags.has(name)
}

export function ensureDir(target) {
  mkdirSync(target, { recursive: true })
}

export function readText(filePath, fallback = '') {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return fallback
  }
}

export function writeText(filePath, content) {
  ensureDir(path.dirname(filePath))
  writeFileSync(filePath, content)
}

export function appendText(filePath, content) {
  ensureDir(path.dirname(filePath))
  appendFileSync(filePath, content)
}

export function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })

  return {
    ok: result.status === 0,
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

export function retry(task, { attempts = 3 } = {}) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return task(attempt)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export function currentDateInfo(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)

  const stamp = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(now)

  return { date, stamp }
}

export function listFiles(dir, predicate) {
  if (!existsSync(dir)) return []
  const output = []
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!predicate || predicate(full)) {
        output.push(full)
      }
    }
  }
  walk(dir)
  return output.sort()
}

export function normalizeMarkdownWhitespace(filePath) {
  const original = readText(filePath, null)
  if (original === null) return false
  const normalized = `${original.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
  if (normalized === original) return false
  writeText(filePath, normalized)
  return true
}

export function collectUncheckedBoxes(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*]\s+\[ \]/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+\[ \]\s*/, '').trim())
}

export function gitChangedFiles(rangeArgs = ['status', '--short']) {
  const result = run('git', rangeArgs)
  if (!result.ok) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function relative(filePath) {
  return path.relative(repoRoot, filePath) || '.'
}

export function fileAgeDays(filePath) {
  const stats = statSync(filePath)
  return (Date.now() - stats.mtimeMs) / (24 * 60 * 60 * 1000)
}

export function emitSummary(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines)
  process.stdout.write(`${text.trim()}\n`)
}
