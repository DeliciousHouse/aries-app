import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import AriesOnboardingFlow from '../frontend/aries-v1/onboarding-flow';
import { listPendingWorkspaceInvites, WORKSPACE_CHOOSER_PATH } from '../backend/tenant/workspace-chooser';
import { TenantContextError } from '../lib/tenant-context';
import { DATABASE_UNAVAILABLE_ERROR } from '../lib/auth-error-message';
import { installJsdom } from './helpers/jsdom-env';

const require = createRequire(import.meta.url);
function loadPage(file: string, dependencies: Record<string, unknown>) {
  const exports: { default?: (...args: any[]) => Promise<any> } = {};
  const source = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  runInNewContext(source, {
    exports, console: { error() {} },
    require: (id: string) => dependencies[id] ?? require(id),
  });
  return exports.default!;
}

for (const scenario of [
  { name: 'no invitations overrides stale dashboard', count: 0, expected: '/onboarding/start' },
  { name: 'one invitation', count: 1, expected: WORKSPACE_CHOOSER_PATH },
  { name: 'multiple invitations', count: 2, expected: WORKSPACE_CHOOSER_PATH },
  { name: 'active member', active: true, expected: '/dashboard' },
  { name: 'flag OFF', flag: false, expected: '/dashboard' },
  { name: 'signed out', signedOut: true, expected: '/login' },
  { name: 'incomplete claims', incomplete: true, expected: '/dashboard' },
  { name: 'invite lookup failure', failure: true, expected: `/login?error=${encodeURIComponent(DATABASE_UNAVAILABLE_ERROR)}` },
]) {
  test(`post-login: ${scenario.name}, with scoped lookup and client release`, async () => {
    let releases = 0;
    let connections = 0;
    let lookups = 0;
    const client = {
      release() { releases++; },
      async query(sql: string, params: unknown[]) {
        lookups++;
        assert.match(sql, /m.user_id = \$1 AND m.status = 'invited'/);
        assert.deepEqual(params, [42]);
        if (scenario.failure) throw new Error('unavailable');
        return { rows: Array.from({ length: scenario.count ?? 0 }, (_, i) => ({ organization_id: i + 1 })) };
      },
    };
    const page = loadPage('app/auth/post-login/page.tsx', {
      'next/navigation': { redirect(destination: string) { throw new Error(destination); } },
      '@/auth': { auth: async () => scenario.signedOut ? null : { user: { id: '42' } } },
      '@/lib/db': { __esModule: true, default: { connect: async () => { connections++; return client; } } },
      '@/backend/tenant/multi-workspace-env': { isMultiWorkspaceEnabled: () => scenario.flag !== false },
      '@/backend/tenant/workspace-chooser': { listPendingWorkspaceInvites, WORKSPACE_CHOOSER_PATH },
      '@/lib/auth-error-message': { DATABASE_UNAVAILABLE_ERROR },
      '@/lib/auth-user-journey': { resolvePostLoginDestinationForUser: async () => '/dashboard' },
      '@/lib/tenant-context': { TenantContextError, loadTenantContextForUser: async () => {
        if (!scenario.active) throw new TenantContextError(scenario.incomplete ? 'tenant_claims_incomplete' : 'tenant_membership_missing', 'synthetic');
      } },
    });
    await assert.rejects(page(), (error: Error) => error.message === scenario.expected);
    assert.equal(connections, scenario.signedOut ? 0 : 1);
    assert.equal(releases, connections);
    assert.equal(lookups, scenario.signedOut || scenario.active || scenario.incomplete || scenario.flag === false ? 0 : 1);
  });
}

for (const enabled of [false, true]) {
  test(`onboarding start renders missing membership with server variant flag ${enabled}`, async () => {
    let releases = 0;
    const page = loadPage('app/onboarding/start/page.tsx', {
      'next/navigation': { redirect() { throw new Error('unexpected redirect'); } },
      '@/auth': { auth: async () => ({ user: { id: '42' } }) },
      '@/lib/db': { __esModule: true, default: { connect: async () => ({ release() { releases++; } }) } },
      '@/frontend/aries-v1/onboarding-flow': { __esModule: true, default: AriesOnboardingFlow },
      '@/lib/onboarding-gate': { evaluateOnboardingGate() { throw new Error('must not evaluate without a tenant'); } },
      '@/lib/tenant-context': { TenantContextError, resolveTenantContextForSession: async () => { throw new TenantContextError('tenant_membership_missing', 'synthetic'); } },
      '@/backend/tenant/multi-workspace-env': { isMultiWorkspaceEnabled: () => true },
      '@/backend/onboarding/variant-board-env': { isOnboardingVariantBoardEnabled: () => enabled },
    });
    const result = await page({ searchParams: Promise.resolve({}) });
    assert.equal(result.type, AriesOnboardingFlow);
    assert.equal(result.props.initialAuthenticated, true);
    assert.equal(result.props.initialVariantBoardEnabled, enabled);
    assert.equal(releases, 1);
  });
}

const text = (node: { children: unknown[] }): string => node.children.map((child) =>
  typeof child === 'string' ? child : child && typeof child === 'object' && 'children' in child ? text(child as { children: unknown[] }) : '',
).join('');
const draft = {
  draftId: 'synthetic-first-run', businessName: 'Example Studio', businessType: 'Retail',
  websiteUrl: 'https://example.invalid', approverName: 'Example', channels: ['facebook'],
  goal: 'Grow brand awareness', offer: 'New collection', brandVoice: '', notes: '', competitorUrl: '', preview: null,
};

for (const scenario of [
  { name: 'variant ON', authenticated: true, enabled: true },
  { name: 'variant OFF', authenticated: true, enabled: false },
  { name: 'default flag', authenticated: true },
  { name: 'anonymous', authenticated: false, enabled: true },
  { name: 'blocked', authenticated: true, enabled: true, blocked: true },
  { name: 'non-final', authenticated: true, enabled: true, step: 'goal' },
]) {
  test(`rendered finish: ${scenario.name}`, async (t) => {
    installJsdom();
    window.history.replaceState({}, '', `/onboarding/start?draft=${draft.draftId}&step=${scenario.step ?? 'channels'}`);
    window.localStorage.clear();
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    globals.self = globalThis;
    const pushes: string[] = [];
    const writes: Record<string, unknown>[] = [];
    let resolveSave!: () => void;
    const save = new Promise<void>((resolve) => { resolveSave = resolve; });
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      assert.match(String(url), /^\/api\/onboarding\/draft\?draft=synthetic-first-run$/);
      if (init?.method === 'PATCH') {
        writes.push(JSON.parse(String(init.body)));
        await save;
      }
      return Response.json({ draft });
    });
    const router = { push: (href: string) => pushes.push(href), replace() {}, refresh() {}, back() {}, forward() {}, prefetch: async () => {} };
    let root!: ReactTestRenderer;
    t.after(async () => { resolveSave(); if (root) await act(async () => root.unmount()); });
    await act(async () => {
      root = create(React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(window.location.search) },
          React.createElement(AriesOnboardingFlow, { initialAuthenticated: scenario.authenticated, initialVariantBoardEnabled: scenario.enabled }),
        ),
      ));
    });
    if (scenario.blocked) {
      const channel = root.root.find((node) => node.type === 'button' && text(node).includes('Facebook Page'));
      await act(async () => { channel.props.onClick(); });
    }
    const label = scenario.step ? 'Continue' : scenario.authenticated ? 'Create my first post' : 'Save and continue';
    const button = root.root.find((node) => node.type === 'button' && text(node) === label);
    const explanation = root.root.findAll((node) => node.props.id === 'onboarding-generation-explanation');
    const hasExplanation = scenario.authenticated && !scenario.step;
    assert.equal(explanation.length, hasExplanation ? 1 : 0);
    if (hasExplanation) {
      assert.equal(text(explanation[0]), scenario.enabled
        ? 'Aries will generate 3 drafts for you to review. Nothing is published automatically.'
        : 'Aries will generate your first content plan for you to review. Nothing is published automatically.');
      assert.match(button.props['aria-describedby'], /onboarding-generation-explanation/);
    }
    if (scenario.blocked) {
      assert.equal(button.props.disabled, true);
      assert.match(button.props['aria-describedby'], /onboarding-advance-blocker/);
    } else if (!scenario.step) {
      assert.equal(button.props.disabled, false);
      await act(async () => { button.props.onClick(); });
      const busy = root.root.find((node) => node.type === 'button' && text(node) === 'Saving setup...');
      assert.equal(busy.props.disabled, true);
      assert.equal(pushes.length, 0);
      await act(async () => { resolveSave(); });
      assert.equal(writes.filter((body) => body.status === 'ready_for_auth').length, 1);
      assert.equal(pushes.length, 1);
      if (scenario.authenticated) assert.equal(pushes[0], `/onboarding/resume?draft=${draft.draftId}`);
      else assert.match(pushes[0], /\/login\?/);
    }
  });
}
