import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createDiff } from './differ.mjs';
import { fetchPolicyText, hashContent, detectRiskFlags, generateMockAiSummary } from './scraper.mjs';
import {
  addPolicy, getPolicies, getPolicy, deletePolicy,
  addSnapshot, getLatestSnapshot, getSnapshots, getSnapshot,
  addChange, getChanges, getAllChanges
} from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/api/policies', (_req, res) => {
  res.json(getPolicies());
});

app.post('/api/policies', (req, res) => {
  const { name, url, check_frequency } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const result = addPolicy(name, url, check_frequency || 'daily');
  res.status(201).json({ id: result.lastInsertRowid });
});

app.delete('/api/policies/:id', (req, res) => {
  deletePolicy(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/policies/:id/check', async (req, res) => {
  const policy = getPolicy(Number(req.params.id));
  if (!policy) return res.status(404).json({ error: 'Policy not found' });

  try {
    const text = await fetchPolicyText(policy.url);
    const hash = hashContent(text);
    const existing = getLatestSnapshot(policy.id);

    if (existing && existing.content_hash === hash) {
      return res.json({ status: 'unchanged', message: 'No changes detected' });
    }

    const snapResult = addSnapshot(policy.id, text, hash);
    const newSnapshotId = snapResult.lastInsertRowid;

    if (existing) {
      const diff = createDiff(existing.content, text);
      const riskFlags = detectRiskFlags(diff);
      const aiSummary = generateMockAiSummary(diff, riskFlags);
      addChange(policy.id, existing.id, newSnapshotId, diff, aiSummary, riskFlags);
      return res.json({ status: 'changed', message: 'Changes detected', riskFlags });
    }

    res.json({ status: 'initial', message: 'Initial snapshot saved' });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch policy: ${err.message}` });
  }
});

app.post('/api/policies/:id/paste', (req, res) => {
  const policy = getPolicy(Number(req.params.id));
  if (!policy) return res.status(404).json({ error: 'Policy not found' });

  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const hash = hashContent(content);
  const existing = getLatestSnapshot(policy.id);

  if (existing && existing.content_hash === hash) {
    return res.json({ status: 'unchanged', message: 'No changes detected' });
  }

  const snapResult = addSnapshot(policy.id, content, hash);
  const newSnapshotId = snapResult.lastInsertRowid;

  if (existing) {
    const diff = createDiff(existing.content, content);
    const riskFlags = detectRiskFlags(diff);
    const aiSummary = generateMockAiSummary(diff, riskFlags);
    addChange(policy.id, existing.id, newSnapshotId, diff, aiSummary, riskFlags);
    return res.json({ status: 'changed', message: 'Changes detected', riskFlags });
  }

  res.json({ status: 'initial', message: 'Initial snapshot saved' });
});

app.get('/api/policies/:id/snapshots', (req, res) => {
  res.json(getSnapshots(Number(req.params.id)));
});

app.get('/api/snapshots/:id', (req, res) => {
  const snap = getSnapshot(Number(req.params.id));
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });
  res.json(snap);
});

app.get('/api/policies/:id/changes', (req, res) => {
  const changes = getChanges(Number(req.params.id));
  res.json(changes.map(c => ({ ...c, risk_flags: JSON.parse(c.risk_flags || '[]') })));
});

app.get('/api/changes', (_req, res) => {
  const changes = getAllChanges();
  res.json(changes.map(c => ({ ...c, risk_flags: JSON.parse(c.risk_flags || '[]') })));
});

app.get('/api/changes/:id/diff', (req, res) => {
  const change = getAllChanges().find(c => c.id === Number(req.params.id));
  if (!change) return res.status(404).json({ error: 'Change not found' });

  const oldSnap = change.old_snapshot_id ? getSnapshot(change.old_snapshot_id) : null;
  const newSnap = getSnapshot(change.new_snapshot_id);

  res.json({
    diff_text: change.diff_text,
    ai_summary: change.ai_summary,
    risk_flags: JSON.parse(change.risk_flags || '[]'),
    old_content: oldSnap?.content || '',
    new_content: newSnap?.content || '',
  });
});

app.post('/api/check-all', async (_req, res) => {
  const policies = getPolicies();
  const results = [];

  for (const policy of policies) {
    try {
      const text = await fetchPolicyText(policy.url);
      const hash = hashContent(text);
      const existing = getLatestSnapshot(policy.id);

      if (existing && existing.content_hash === hash) {
        results.push({ id: policy.id, name: policy.name, status: 'unchanged' });
        continue;
      }

      const snapResult = addSnapshot(policy.id, text, hash);
      const newSnapshotId = snapResult.lastInsertRowid;

      if (existing) {
        const diff = createDiff(existing.content, text);
        const riskFlags = detectRiskFlags(diff);
        const aiSummary = generateMockAiSummary(diff, riskFlags);
        addChange(policy.id, existing.id, newSnapshotId, diff, aiSummary, riskFlags);
        results.push({ id: policy.id, name: policy.name, status: 'changed', riskFlags });
      } else {
        results.push({ id: policy.id, name: policy.name, status: 'initial' });
      }
    } catch (err) {
      results.push({ id: policy.id, name: policy.name, status: 'error', error: err.message });
    }
  }

  res.json(results);
});

app.listen(PORT, () => {
  console.log(`TermSight running at http://localhost:${PORT}`);
});
