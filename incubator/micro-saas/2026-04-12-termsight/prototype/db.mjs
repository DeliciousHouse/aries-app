import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, 'termsight-data.json');

function load() {
  if (!existsSync(dbPath)) return { policies: [], snapshots: [], changes: [], nextId: 1 };
  return JSON.parse(readFileSync(dbPath, 'utf-8'));
}

function save(data) {
  writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

function nextId(data) {
  return data.nextId++;
}

export function addPolicy(name, url, checkFrequency = 'daily') {
  const data = load();
  const id = nextId(data);
  data.policies.push({
    id, name, url, check_frequency: checkFrequency,
    created_at: new Date().toISOString(),
    last_checked_at: null, last_changed_at: null,
  });
  save(data);
  return { lastInsertRowid: id };
}

export function getPolicies() {
  return load().policies.sort((a, b) => b.id - a.id);
}

export function getPolicy(id) {
  return load().policies.find(p => p.id === id);
}

export function deletePolicy(id) {
  const data = load();
  data.policies = data.policies.filter(p => p.id !== id);
  data.snapshots = data.snapshots.filter(s => s.policy_id !== id);
  data.changes = data.changes.filter(c => c.policy_id !== id);
  save(data);
}

export function addSnapshot(policyId, content, contentHash) {
  const data = load();
  const id = nextId(data);
  data.snapshots.push({
    id, policy_id: policyId, content, content_hash: contentHash,
    fetched_at: new Date().toISOString(),
  });
  const policy = data.policies.find(p => p.id === policyId);
  if (policy) policy.last_checked_at = new Date().toISOString();
  save(data);
  return { lastInsertRowid: id };
}

export function getLatestSnapshot(policyId) {
  const snaps = load().snapshots.filter(s => s.policy_id === policyId);
  return snaps.sort((a, b) => new Date(b.fetched_at) - new Date(a.fetched_at))[0] || null;
}

export function getSnapshots(policyId) {
  return load().snapshots
    .filter(s => s.policy_id === policyId)
    .map(({ content, ...rest }) => rest)
    .sort((a, b) => new Date(b.fetched_at) - new Date(a.fetched_at));
}

export function getSnapshot(id) {
  return load().snapshots.find(s => s.id === id) || null;
}

export function addChange(policyId, oldSnapshotId, newSnapshotId, diffText, aiSummary, riskFlags) {
  const data = load();
  const id = nextId(data);
  data.changes.push({
    id, policy_id: policyId,
    old_snapshot_id: oldSnapshotId, new_snapshot_id: newSnapshotId,
    diff_text: diffText, ai_summary: aiSummary,
    risk_flags: JSON.stringify(riskFlags),
    detected_at: new Date().toISOString(),
  });
  const policy = data.policies.find(p => p.id === policyId);
  if (policy) policy.last_changed_at = new Date().toISOString();
  save(data);
  return { lastInsertRowid: id };
}

export function getChanges(policyId) {
  return load().changes
    .filter(c => c.policy_id === policyId)
    .sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at));
}

export function getAllChanges() {
  const data = load();
  return data.changes
    .map(c => {
      const policy = data.policies.find(p => p.id === c.policy_id);
      return { ...c, policy_name: policy?.name || 'Unknown', policy_url: policy?.url || '' };
    })
    .sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at))
    .slice(0, 50);
}

export default { load, save };
