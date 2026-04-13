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

function pathEntries() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function executableCandidates(command, cwd) {
  const candidates = []
  const upper = command.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const envOverride = process.env[`${upper}_BIN`]
  if (envOverride) candidates.push(envOverride)

  if (command === 'node') {
    candidates.push(process.execPath)
  }

  const sibling = path.join(path.dirname(process.execPath), command)
  candidates.push(sibling)

  if (cwd) {
    candidates.push(path.join(cwd, 'node_modules', '.bin', command))
  }

  for (const entry of pathEntries()) {
    candidates.push(path.join(entry, command))
  }

  return [...new Set(candidates)]
}

export function resolveBinary(command, { cwd = repoRoot } = {}) {
  for (const candidate of executableCandidates(command, cwd)) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export function checkPreflight({ cwd = repoRoot, binaries = [], paths = [] } = {}) {
  const resolvedBinaries = {}
  const missingBinaries = []

  for (const entry of binaries) {
    const spec = typeof entry === 'string' ? { command: entry } : entry
    const command = spec.command
    const resolved = resolveBinary(command, { cwd: spec.cwd || cwd })
    if (!resolved) {
      missingBinaries.push(spec)
      continue
    }
    resolvedBinaries[command] = resolved
  }

  const pathChecks = paths.map((entry) => {
    const spec = typeof entry === 'string' ? { path: entry, type: 'file' } : entry
    const target = spec.path
    const kind = spec.type || 'file'
    const present = existsSync(target)
    if (!present) {
      return { ...spec, ok: false, reason: 'missing' }
    }

    if (kind === 'file') {
      const ok = statSync(target).isFile()
      return { ...spec, ok, reason: ok ? 'ok' : 'not-file' }
    }

    if (kind === 'dir') {
      const ok = statSync(target).isDirectory()
      return { ...spec, ok, reason: ok ? 'ok' : 'not-dir' }
    }

    return { ...spec, ok: true, reason: 'ok' }
  })

  const missingPaths = pathChecks.filter((entry) => !entry.ok)

  return {
    ok: missingBinaries.length === 0 && missingPaths.length === 0,
    cwd,
    resolvedBinaries,
    missingBinaries,
    pathChecks,
    missingPaths,
  }
}

export function preflightLines(label, result) {
  const lines = [
    `${label} PREFLIGHT ${result.ok ? 'OK' : 'FAILED'}`,
    `- cwd: ${result.cwd}`,
  ]

  const binaryEntries = Object.entries(result.resolvedBinaries)
  lines.push(`- binaries: ${binaryEntries.length}`)
  for (const [command, resolved] of binaryEntries) {
    lines.push(`  - ${command}: ${resolved}`)
  }
  for (const spec of result.missingBinaries) {
    lines.push(`  - missing binary: ${spec.command}`)
  }

  if (result.pathChecks.length > 0) {
    lines.push(`- paths: ${result.pathChecks.length}`)
    for (const check of result.pathChecks) {
      lines.push(`  - ${check.label || check.path}: ${check.ok ? 'ok' : check.reason} (${check.path})`)
    }
  }

  return lines
}

export function preflightOrExit(label, config, { preflightOnly = false } = {}) {
  const result = checkPreflight(config)
  if (!result.ok || preflightOnly) {
    emitSummary(preflightLines(label, result))
  }
  if (!result.ok) {
    process.exit(1)
  }
  return result
}

export function run(command, args = [], options = {}) {
  const cwd = options.cwd || repoRoot
  const resolvedCommand = resolveBinary(command, { cwd }) || command
  const result = spawnSync(resolvedCommand, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })

  return {
    ok: result.status === 0,
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: resolvedCommand,
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
