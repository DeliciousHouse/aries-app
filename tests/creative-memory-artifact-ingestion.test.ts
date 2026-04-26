import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueAnalysis, saveManualAnalysis } from '../backend/creative-memory/analysis';
import { projectRuntimeArtifactRef } from '../backend/creative-memory/artifactIngestion';
test('artifact projection emits safe refs and not raw paths', () => { const ref=projectRuntimeArtifactRef({sourceJobId:'j1',sourceAssetId:'a1',servedAssetRef:'/api/marketing/jobs/j1/assets/a1',absolutePath:'/home/node/nope.png'}); assert(ref); assert.equal((ref as any).absolutePath, undefined); assert.equal((ref as any).storageKey, undefined); assert.equal(ref.storageKind,'runtime_asset'); });
test('analysis is deterministic v1-light stub', async () => { assert.equal(enqueueAnalysis().queued,false); const db={query:async()=>({rows:[{id:'an1'}]})}; const saved=await saveManualAnalysis({tenantId:'1'} as any, db as any, {creativeAssetId:'a1',hookType:'contrarian'}); assert.equal(saved.queued,false); });

test('artifact projection drops unsafe filesystem-like served refs', () => { const ref=projectRuntimeArtifactRef({sourceJobId:'j1',sourceAssetId:'a1',servedAssetRef:'/tmp/leak.png'}); assert.equal(ref, null); });
