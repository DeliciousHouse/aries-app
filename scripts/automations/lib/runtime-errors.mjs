import crypto from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { emitSummary, ensureDir, readText, repoRoot, run, writeText } from './common.mjs'

export const runtimeIncidentLogPath = path.join(repoRoot, 'data', 'runtime-error-incidents.json')

export const severityOrder = ['critical', 'high', 'medium', 'low']

function nowIso() {
  return new Date().toISOString()
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function defaultChecks({ withBuild = false, withAutomationVerify = false } = {}) {
  const checks = [
    {
      id: 'workspace-verify',
      title: 'Workspace verification failed',
      severity: 'high',
      command: 'npm',
      args: ['run', 'workspace:verify'],
      timeoutMs: 30000,
      validationCommand: 'npm run workspace:verify',
      repairHints: [
        'Inspect scripts/verify-canonical-workspace.mjs and any missing or renamed workspace files.',
        'Prefer restoring expected paths or updating the verifier contract with the smallest safe patch.',
      ],
    },
    {
      id: 'runtime-precheck',
      title: 'Runtime precheck failed',
      severity: 'high',
      command: 'npm',
      args: ['run', 'precheck'],
      timeoutMs: 30000,
      validationCommand: 'npm run precheck',
      repairHints: [
        'Inspect scripts/runtime-precheck.mjs and the files or env contract it validates.',
        'Prefer fixing missing files or mismatched script contracts before broader changes.',
      ],
    },
  ]

  if (withAutomationVerify) {
    checks.push({
      id: 'automation-verify',
      title: 'Automation verification failed',
      severity: 'medium',
      command: 'npm',
      args: ['run', 'automation:verify'],
      timeoutMs: 180000,
      validationCommand: 'npm run automation:verify',
      repairHints: [
        'Inspect scripts/automations/verify-automations.mjs and the failing automation script.',
        'Keep fixes bounded to the broken automation contract rather than unrelated cleanup.',
      ],
    })
  }

  if (withBuild) {
    checks.push({
      id: 'build',
      title: 'Build failed',
      severity: 'high',
      command: 'npm',
      args: ['run', 'build'],
      timeoutMs: 300000,
      validationCommand: 'npm run build',
      repairHints: [
        'Use the first concrete build error as the root cause candidate.',
        'Prefer the smallest targeted code change, then rerun the build before marking resolved.',
      ],
    })
  }

  return checks
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .trim()
}

function firstUsefulLine(text) {
  return normalizeWhitespace(text)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || 'Command failed without stderr/stdout output.'
}

function truncate(text, max = 4000) {
  const normalized = normalizeWhitespace(text)
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

function summarizeStructuredText(text) {
  const normalized = normalizeWhitespace(text)
  if (!normalized.startsWith('{')) return null

  const parsed = safeJsonParse(normalized, null)
  if (!parsed || typeof parsed !== 'object') return null

  if (Array.isArray(parsed.providerMisconfigurations) && parsed.providerMisconfigurations.length > 0) {
    const first = parsed.providerMisconfigurations[0]
    const missingEnv = Array.isArray(first.missingEnv) ? first.missingEnv.join(', ') : 'unknown env'
    return `provider misconfiguration: ${first.provider || 'unknown provider'} missing ${missingEnv}`
  }

  if (Array.isArray(parsed.missing) && parsed.missing.length > 0) {
    return `missing required paths: ${parsed.missing.slice(0, 3).join(', ')}`
  }

  if (Array.isArray(parsed.missingScripts) && parsed.missingScripts.length > 0) {
    return `missing package scripts: ${parsed.missingScripts.join(', ')}`
  }

  if (typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error.trim()
  }

  if (parsed.ok === false) {
    const keys = Object.keys(parsed).filter((key) => key !== 'ok')
    if (keys.length > 0) {
      return `check failed: ${keys.join(', ')}`
    }
  }

  return null
}

function summarizeFailure(result) {
  const stderr = truncate(result.stderr || '')
  const stdout = truncate(result.stdout || '')
  const primary = summarizeStructuredText(stderr || stdout) || firstUsefulLine(stderr || stdout)
  return {
    errorMessage: primary,
    details: truncate([stderr, stdout].filter(Boolean).join('\n\n---\n\n'), 8000),
  }
}

function severityRank(value) {
  const index = severityOrder.indexOf(value)
  return index === -1 ? severityOrder.length : index
}

function createFingerprint(source, errorMessage) {
  return crypto.createHash('sha1').update(`${source}\n${normalizeWhitespace(errorMessage)}`).digest('hex')
}

function createIncidentId(source, fingerprint) {
  const suffix = fingerprint.slice(0, 8)
  const stamp = Date.now().toString(36)
  return `inc-${source}-${stamp}-${suffix}`
}

const MARKETING_JOB_FAILURE_SOURCE = 'marketing-job-failure'
const MARKETING_JOB_FAILURE_VALIDATION_COMMAND = 'node scripts/automations/runtime-error-intake.mjs scan --json'

function marketingJobRuntimeRoot() {
  const dataRoot = process.env.DATA_ROOT?.trim() || '/data'
  return path.join(dataRoot, 'generated', 'draft', 'marketing-jobs')
}

function collectMarketingJobFailureIncidents() {
  const root = marketingJobRuntimeRoot()
  if (!existsSync(root)) {
    return { active: false, incidents: [] }
  }

  const incidents = []
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.json')) continue

    const filePath = path.join(root, entry)
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue

      const jobId = typeof parsed.job_id === 'string' ? parsed.job_id.trim() : ''
      const tenantId = typeof parsed.tenant_id === 'string' ? parsed.tenant_id.trim() : ''
      const state = typeof parsed.state === 'string' ? parsed.state.trim() : ''
      const status = typeof parsed.status === 'string' ? parsed.status.trim() : ''
      if (!jobId || (state !== 'failed' && status !== 'failed')) continue

      const approvalHistory = Array.isArray(parsed.approvals?.history) ? parsed.approvals.history : []
      const currentStage = typeof parsed.current_stage === 'string' ? parsed.current_stage.trim() : 'unknown'
      const wasDenied = approvalHistory.some(
        (entry) => entry.status === 'denied' && entry.stage === currentStage
      )
      if (wasDenied) continue
      const updatedAt = typeof parsed.updated_at === 'string' ? parsed.updated_at.trim() : ''
      const lastError = parsed.last_error && typeof parsed.last_error === 'object' && !Array.isArray(parsed.last_error)
        ? parsed.last_error
        : null
      const errorCode = typeof lastError?.code === 'string' && lastError.code.trim() ? lastError.code.trim() : 'marketing_job_failed'
      const errorStage = typeof lastError?.stage === 'string' && lastError.stage.trim() ? lastError.stage.trim() : currentStage
      const errorAt = typeof lastError?.at === 'string' && lastError.at.trim() ? lastError.at.trim() : updatedAt
      const rawMessage = typeof lastError?.message === 'string' && lastError.message.trim()
        ? lastError.message.trim()
        : `Campaign workflow failed during ${errorStage || currentStage || 'unknown'} stage.`
      const fingerprint = createFingerprint(
        MARKETING_JOB_FAILURE_SOURCE,
        `${jobId}\n${errorStage}\n${errorCode}\n${rawMessage}`,
      )

      incidents.push({
        fingerprint,
        title: 'Marketing campaign workflow failed',
        service: 'aries-app',
        environment: 'repo',
        severity: errorStage === 'publish' ? 'medium' : 'high',
        source: MARKETING_JOB_FAILURE_SOURCE,
        errorMessage: `Campaign job ${jobId} failed in ${errorStage}: ${rawMessage}`,
        details: truncate(
          JSON.stringify(
            {
              jobId,
              tenantId: tenantId || null,
              runtimePath: filePath,
              state: state || null,
              status: status || null,
              currentStage: currentStage || null,
              errorStage: errorStage || null,
              errorCode,
              errorAt: errorAt || null,
              updatedAt: updatedAt || null,
              message: rawMessage,
              lastErrorDetails: lastError?.details ?? null,
            },
            null,
            2,
          ),
          8000,
        ),
        validationCommand: MARKETING_JOB_FAILURE_VALIDATION_COMMAND,
        repairHints: [
          `Inspect marketing runtime file ${filePath} and the workflow/artifact path that failed for job ${jobId}.`,
          'Prefer the smallest safe fix in the failing marketing stage or workflow contract, then rerun the intake scan to verify the incident clears.',
          'If the code fix lands but the job remains failed, rerun or resume the affected campaign workflow so the runtime state no longer reports failed.',
        ],
        marketingJobId: jobId,
        tenantId: tenantId || null,
        marketingStage: errorStage || currentStage || null,
        marketingErrorCode: errorCode,
        marketingErrorAt: errorAt || null,
        runtimePath: filePath,
      })
    } catch {
      continue
    }
  }

  return { active: true, incidents }
}

function ensureHistory(item) {
  item.history = Array.isArray(item.history) ? item.history : []
  return item.history
}

export function createEmptyRuntimeIncidentLog() {
  return {
    version: 1,
    service: 'aries-app',
    environment: 'repo',
    lastScanAt: null,
    items: [],
  }
}

export function loadRuntimeIncidentLog() {
  const fallback = createEmptyRuntimeIncidentLog()
  const raw = readText(runtimeIncidentLogPath, '')
  if (!raw.trim()) return fallback
  const parsed = safeJsonParse(raw, fallback)
  if (!parsed || typeof parsed !== 'object') return fallback
  parsed.version ||= 1
  parsed.service ||= 'aries-app'
  parsed.environment ||= 'repo'
  parsed.items = Array.isArray(parsed.items) ? parsed.items : []
  return parsed
}

export function saveRuntimeIncidentLog(log) {
  ensureDir(path.dirname(runtimeIncidentLogPath))
  writeText(runtimeIncidentLogPath, `${JSON.stringify(log, null, 2)}\n`)
}

function mergeIncident(existing, patch) {
  const merged = { ...(existing || {}) }
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = mergeIncident(merged[key], value)
      continue
    }
    merged[key] = value
  }
  return merged
}

export function markRuntimeIncident({ incidentId, patch = {}, dryRun = false } = {}) {
  if (!incidentId) throw new Error('incidentId is required')
  const log = loadRuntimeIncidentLog()
  const item = log.items.find((entry) => entry.incidentId === incidentId)
  if (!item) throw new Error(`incident ${incidentId} not found`)

  const beforeStatus = item.status
  const merged = mergeIncident(item, patch)
  const at = nowIso()
  ensureHistory(merged).push({
    at,
    event: patch.status && patch.status !== beforeStatus ? `status:${beforeStatus}->${patch.status}` : 'patched',
    details: Object.keys(patch).join(', ') || 'no-op',
  })
  merged.updatedAt = at

  const nextItems = log.items.map((entry) => (entry.incidentId === incidentId ? merged : entry))
  const nextLog = { ...log, items: nextItems }
  if (!dryRun) saveRuntimeIncidentLog(nextLog)
  return { log: nextLog, item: merged }
}

function sortIncidents(items) {
  return [...items].sort((left, right) => {
    const severityDelta = severityRank(left.severity) - severityRank(right.severity)
    if (severityDelta !== 0) return severityDelta
    const attemptDelta = (left.attemptCount || 0) - (right.attemptCount || 0)
    if (attemptDelta !== 0) return attemptDelta
    return (Date.parse(right.lastSeenAt || '') || 0) - (Date.parse(left.lastSeenAt || '') || 0)
  })
}

export function getPendingRuntimeIncidents({ includeEscalated = false } = {}) {
  const allowed = new Set(includeEscalated ? ['open', 'repair_planned', 'repairing', 'retryable', 'escalated'] : ['open', 'repair_planned', 'repairing', 'retryable'])
  return sortIncidents(loadRuntimeIncidentLog().items.filter((item) => allowed.has(item.status)))
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function upsertDetectedIncident({ detected, existingByFingerprint, nextItems, seenFingerprints, stats, scanAt }) {
  seenFingerprints.add(detected.fingerprint)
  const existing = existingByFingerprint.get(detected.fingerprint)

  if (existing) {
    const updated = {
      ...existing,
      ...detected,
      lastSeenAt: scanAt,
      lastDetectedAt: scanAt,
      updatedAt: scanAt,
      detectionCount: (existing.detectionCount || 0) + 1,
    }
    ensureHistory(updated)
    if (existing.status === 'resolved') {
      updated.status = 'open'
      updated.lastResolvedAt = null
      updated.resolutionSummary = null
      updated.history.push({ at: scanAt, event: 'reopened', details: detected.errorMessage })
      stats.reopenedIncidents += 1
    } else {
      updated.history.push({ at: scanAt, event: 'still-failing', details: detected.errorMessage })
      stats.ongoingIncidents += 1
    }
    nextItems.push(updated)
    return
  }

  nextItems.push({
    incidentId: createIncidentId(detected.source, detected.fingerprint),
    ...detected,
    status: 'open',
    attemptCount: 0,
    detectionCount: 1,
    firstSeenAt: scanAt,
    lastSeenAt: scanAt,
    lastDetectedAt: scanAt,
    lastResolvedAt: null,
    updatedAt: scanAt,
    owner: 'jarvis',
    planSummary: null,
    fixSummary: null,
    validationSummary: null,
    resolutionSummary: null,
    lastRepairAttemptAt: null,
    history: [{ at: scanAt, event: 'opened', details: detected.errorMessage }],
  })
  stats.newIncidents += 1
}

export function scanRuntimeErrors({ withBuild = false, withAutomationVerify = false, dryRun = false } = {}) {
  const checks = defaultChecks({ withBuild, withAutomationVerify })
  const marketingFailures = collectMarketingJobFailureIncidents()
  const activeSources = new Set(checks.map((check) => check.id))
  if (marketingFailures.active) {
    activeSources.add(MARKETING_JOB_FAILURE_SOURCE)
  }
  const log = loadRuntimeIncidentLog()
  const existingByFingerprint = new Map(log.items.map((item) => [item.fingerprint, item]))
  const nextItems = []
  const seenFingerprints = new Set()
  const scanAt = nowIso()
  const stats = {
    scannedChecks: checks.length + (marketingFailures.active ? 1 : 0),
    newIncidents: 0,
    ongoingIncidents: 0,
    reopenedIncidents: 0,
    resolvedIncidents: 0,
    passedChecks: 0,
    failedChecks: 0,
  }

  for (const check of checks) {
    const result = run(check.command, check.args, check.timeoutMs ? { timeout: check.timeoutMs } : {})
    if (result.ok) {
      stats.passedChecks += 1
      continue
    }

    stats.failedChecks += 1
    const failure = summarizeFailure(result)
    upsertDetectedIncident({
      detected: {
        fingerprint: createFingerprint(check.id, failure.errorMessage),
        title: check.title,
        service: 'aries-app',
        environment: 'repo',
        severity: check.severity,
        source: check.id,
        errorMessage: failure.errorMessage,
        details: failure.details,
        validationCommand: check.validationCommand,
        repairHints: check.repairHints,
      },
      existingByFingerprint,
      nextItems,
      seenFingerprints,
      stats,
      scanAt,
    })
  }

  if (marketingFailures.active) {
    if (marketingFailures.incidents.length > 0) {
      stats.failedChecks += 1
    } else {
      stats.passedChecks += 1
    }

    for (const incident of marketingFailures.incidents) {
      upsertDetectedIncident({
        detected: incident,
        existingByFingerprint,
        nextItems,
        seenFingerprints,
        stats,
        scanAt,
      })
    }
  }

  for (const existing of log.items) {
    if (!activeSources.has(existing.source)) {
      nextItems.push(existing)
      continue
    }
    if (seenFingerprints.has(existing.fingerprint)) continue
    const updated = { ...existing }
    ensureHistory(updated)
    if (updated.status !== 'resolved') {
      updated.status = 'resolved'
      updated.lastResolvedAt = scanAt
      updated.updatedAt = scanAt
      updated.resolutionSummary = updated.resolutionSummary || 'Auto-resolved on runtime health scan.'
      updated.history.push({ at: scanAt, event: 'auto-resolved', details: 'No longer detected in the latest scan.' })
      stats.resolvedIncidents += 1
    }
    nextItems.push(updated)
  }

  const nextLog = {
    ...log,
    lastScanAt: scanAt,
    items: sortIncidents(nextItems),
  }

  if (!dryRun) saveRuntimeIncidentLog(nextLog)

  return {
    scanAt,
    checks: checks.map((check) => ({ id: check.id, validationCommand: check.validationCommand })),
    stats,
    incidents: nextLog.items,
    pending: nextLog.items.filter((item) => ['open', 'repair_planned', 'repairing', 'retryable'].includes(item.status)),
  }
}

export function emitScanSummary(result, { dryRun = false } = {}) {
  const highestSeverity = result.pending.length ? result.pending[0].severity : 'none'
  emitSummary([
    `status: ${result.stats.failedChecks > 0 ? 'attention' : 'ok'}`,
    `mode: ${dryRun ? 'dry-run' : 'live'}`,
    `scanned_checks: ${result.stats.scannedChecks}`,
    `failed_checks: ${result.stats.failedChecks}`,
    `new_incidents: ${result.stats.newIncidents}`,
    `ongoing_incidents: ${result.stats.ongoingIncidents}`,
    `reopened_incidents: ${result.stats.reopenedIncidents}`,
    `resolved_incidents: ${result.stats.resolvedIncidents}`,
    `repair_queue: ${result.pending.length}`,
    `highest_severity: ${highestSeverity}`,
    `next_step: ${result.pending.length ? 'run repair loop' : 'none'}`,
  ])
}
