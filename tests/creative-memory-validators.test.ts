import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFrontendSafeValue, assertNoCompetitorDirectExample, assertValidPermissionScope, parseCreativeMemoryBrief, validatePromptContextBudget } from '../validators/creative-memory';

test('Creative Memory validators reject invalid permission scopes', () => assert.throws(()=>assertValidPermissionScope('public_direct_clone'), /Invalid permission scope/));
test('Creative Memory validators block competitor direct examples', () => assert.throws(()=>assertNoCompetitorDirectExample({sourceType:'competitor_meta_ad', directExample:true}), /Competitor/));
test('Creative Memory validators require exact image text', () => assert.throws(()=>parseCreativeMemoryBrief({creativeType:'native educational image', imageText:[]}), /exact image text/i));
test('Creative Memory validators enforce context budget', () => assert.throws(()=>validatePromptContextBudget({tokenEstimate:4000,maxTokens:3500}), /budget/));
test('Creative Memory validators block raw filesystem paths', () => assert.throws(()=>assertFrontendSafeValue({url:'/home/node/secret.png'}), /raw filesystem path/));
test('Creative Memory validators accept safe asset refs', () => assert.doesNotThrow(()=>assertFrontendSafeValue({servedAssetRef:'/api/marketing/jobs/j/assets/a'})));
