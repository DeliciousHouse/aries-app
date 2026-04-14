#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const HOST_CODE_ROOT = '/home/node/openclaw/aries-app'
const HOST_SHARED_DATA_ROOT = '/home/node/data'
const HOST_TEMP_DATA_ROOT = '/tmp/aries-data'

function parseArgs(argv) {
  const out = { tenantId: '', windowStart: '', windowEnd: '' }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1] ?? ''
    if (arg === '--tenant-id') out.tenantId = next, i += 1
    else if (arg === '--window-start') out.windowStart = next, i += 1
    else if (arg === '--window-end') out.windowEnd = next, i += 1
  }
  return out
}

function codeRoot() {
  const explicit = process.env.CODE_ROOT?.trim()
  if (explicit) return explicit
  if (existsSync(path.join(HOST_CODE_ROOT, 'package.json'))) return HOST_CODE_ROOT
  return '/app'
}

function dataRoot() {
  const explicit = process.env.DATA_ROOT?.trim()
  if (explicit) return explicit
  if (existsSync(HOST_SHARED_DATA_ROOT)) return HOST_SHARED_DATA_ROOT
  if (existsSync(HOST_TEMP_DATA_ROOT)) return HOST_TEMP_DATA_ROOT
  if (existsSync('/data')) return '/data'
  return HOST_SHARED_DATA_ROOT
}

function marketingJobsRoot() {
  return path.join(dataRoot(), 'generated', 'draft', 'marketing-jobs')
}

function calendarSyncRoot() {
  return path.join(dataRoot(), 'generated', 'validated', 'calendar-sync')
}

function slugify(value) {
  return String(value || 'tenant').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'tenant'
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function parseTime(value) {
  const ts = Date.parse(asString(value))
  return Number.isFinite(ts) ? ts : null
}

function withinWindow(ts, startTs, endTs) {
  if (ts == null) return false
  if (startTs != null && ts < startTs) return false
  if (endTs != null && ts > endTs) return false
  return true
}

function findReviewBundle(runtimeDoc) {
  const publish = asRecord(runtimeDoc?.stages?.publish)
  const outputs = asRecord(publish?.outputs)
  const review = asRecord(outputs?.review)
  if (asRecord(review?.review_bundle)) return review.review_bundle
  if (asRecord(outputs?.review_bundle)) return outputs.review_bundle
  if (asRecord(publish?.primary_output?.review_bundle)) return publish.primary_output.review_bundle
  if (asRecord(publish?.primary_output)) return publish.primary_output
  return null
}

function extractCalendarEvents(runtimeDoc) {
  const bundle = findReviewBundle(runtimeDoc)
  const contentCalendar = asRecord(bundle?.content_calendar)
  const events = asArray(contentCalendar?.events)
  return events
    .map((event, index) => {
      const startsAt = asString(event?.starts_at)
      if (!startsAt) return null
      return {
        id: asString(event?.id, `${runtimeDoc.job_id}-calendar-${index + 1}`),
        jobId: asString(runtimeDoc?.job_id),
        tenantId: asString(runtimeDoc?.tenant_id),
        campaignName: asString(bundle?.campaign_name, asString(runtimeDoc?.brand_kit?.brand_name, 'Campaign')),
        title: asString(event?.title, 'Scheduled campaign event'),
        platform: asString(event?.platform, 'unknown'),
        status: asString(event?.status, 'planned'),
        startsAt,
        endsAt: asString(event?.ends_at) || null,
        assetPreviewId: asString(event?.asset_preview_id) || null,
        updatedAt: asString(runtimeDoc?.updated_at),
      }
    })
    .filter(Boolean)
}

function listRuntimeDocs() {
  const root = marketingJobsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(root, name))
    .map((filePath) => {
      try {
        return readJson(filePath)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

function writeSnapshot(tenantId, snapshot) {
  const root = calendarSyncRoot()
  ensureDir(root)
  const safeTenant = slugify(tenantId)
  const filePath = path.join(root, `${safeTenant}.json`)
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2))
  return filePath
}

const { tenantId, windowStart, windowEnd } = parseArgs(process.argv)
if (!tenantId) {
  console.log(JSON.stringify({
    status: 'error',
    reason: 'tenant_id_required',
    message: 'Calendar sync requires a tenant_id argument.'
  }))
  process.exit(1)
}

const startTs = parseTime(windowStart)
const endTs = parseTime(windowEnd)
const docs = listRuntimeDocs().filter((doc) => asString(doc?.tenant_id) === tenantId)
const allEvents = docs.flatMap(extractCalendarEvents)
const filteredEvents = allEvents.filter((event) => withinWindow(parseTime(event.startsAt), startTs, endTs))
filteredEvents.sort((a, b) => (parseTime(a.startsAt) || 0) - (parseTime(b.startsAt) || 0))

const snapshot = {
  status: 'ok',
  workflow: 'calendar_sync',
  tenant_id: tenantId,
  source: {
    marketing_jobs_root: marketingJobsRoot(),
    code_root: codeRoot(),
    data_root: dataRoot(),
  },
  window_start: windowStart || null,
  window_end: windowEnd || null,
  synced_at: new Date().toISOString(),
  jobs_considered: docs.length,
  event_count: filteredEvents.length,
  events: filteredEvents,
}

const artifactPath = writeSnapshot(tenantId, snapshot)
console.log(JSON.stringify({
  status: 'ok',
  workflow: 'calendar_sync',
  tenant_id: tenantId,
  jobs_considered: docs.length,
  event_count: filteredEvents.length,
  artifact_path: artifactPath,
  window_start: snapshot.window_start,
  window_end: snapshot.window_end,
  synced_at: snapshot.synced_at,
}))
