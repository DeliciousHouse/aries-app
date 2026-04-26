import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFrontendSafeValue, assertNoCompetitorDirectExample, assertValidPermissionScope, parseCreativeMemoryBrief, sanitizeServedAssetRef, validatePromptContextBudget } from '../validators/creative-memory';

test('Creative Memory validators reject invalid permission scopes', () => assert.throws(()=>assertValidPermissionScope('public_direct_clone'), /Invalid permission scope/));
test('Creative Memory validators block competitor direct examples', () => assert.throws(()=>assertNoCompetitorDirectExample({sourceType:'competitor_meta_ad', directExample:true}), /Competitor/));
test('Creative Memory validators require exact image text', () => assert.throws(()=>parseCreativeMemoryBrief({creativeType:'native educational image', imageText:[]}), /exact image text/i));
test('Creative Memory validators enforce context budget', () => assert.throws(()=>validatePromptContextBudget({tokenEstimate:4000,maxTokens:3500}), /budget/));
test('Creative Memory validators block raw filesystem paths', () => assert.throws(()=>assertFrontendSafeValue({url:'/home/node/secret.png'}), /raw filesystem path/));
test('Creative Memory validators accept safe asset refs', () => assert.doesNotThrow(()=>assertFrontendSafeValue({servedAssetRef:'/api/marketing/jobs/j/assets/a'})));
test('Creative Memory validators reject asset refs with traversal, query, or unsafe segments', () => {
  for (const ref of ['/api/marketing/jobs/../assets/a', '/api/marketing/jobs/j/assets/a?raw=https://evil.example/x.png', '/materials/a/b#frag', '/materials/a/<script>']) assert.equal(sanitizeServedAssetRef(ref), null);
});
test('Creative Memory validators allow benign informational URLs outside sensitive asset fields', () => assert.doesNotThrow(()=>assertFrontendSafeValue({websiteUrl:'https://example.com'})));
test('Creative Memory validators still block raw cloud asset URLs', () => assert.throws(()=>assertFrontendSafeValue({note:'https://storage.googleapis.com/bucket/file.png'}), /raw external asset URL/));
