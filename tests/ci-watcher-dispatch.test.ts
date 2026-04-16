import test from 'node:test'
import assert from 'node:assert/strict'

// @ts-ignore relative .mjs automation module has no generated declaration surface yet
const modPromise = import('../scripts/automations/lib/ci-watcher-dispatch.mjs')

test('planDispatch spawns issues with no matching session', async () => {
  const mod = await modPromise
  const plan = mod.planDispatch({
    issues: [
      { number: 42, title: 'CI: build failing' },
      { number: 43, title: 'CI: tsc failing' },
    ],
    sessions: [
      { id: 'aa-1', issueId: null, status: 'working' },
    ],
  })
  assert.equal(plan.toSpawn.length, 2)
  assert.deepEqual(
    plan.toSpawn.map((x: { number: number }) => x.number).sort(),
    [42, 43],
  )
  assert.equal(plan.toSkip.length, 0)
})

test('planDispatch skips issues that already have a session (any status)', async () => {
  const mod = await modPromise
  const plan = mod.planDispatch({
    issues: [
      { number: 42, title: 'CI: build failing' },
      { number: 43, title: 'CI: tsc failing' },
      { number: 44, title: 'CI: lint failing' },
    ],
    sessions: [
      { id: 'aa-9', issueId: '42', status: 'working' },
      // Non-terminal sessions should dedup — even completed/merged ones still present in ls.
      { id: 'aa-8', issueId: '43', status: 'merged' },
      { id: 'aa-7', issueId: null, status: 'working' },
    ],
  })
  assert.equal(plan.toSkip.length, 2)
  assert.deepEqual(
    plan.toSkip.map((x: { number: number }) => x.number).sort(),
    [42, 43],
  )
  assert.equal(plan.toSpawn.length, 1)
  assert.equal(plan.toSpawn[0].number, 44)
})

test('planDispatch matches issueId as string even when issue number is numeric', async () => {
  const mod = await modPromise
  const plan = mod.planDispatch({
    issues: [{ number: 100, title: 'CI' }],
    sessions: [{ id: 'aa-1', issueId: 100, status: 'working' }],
  })
  assert.equal(plan.toSpawn.length, 0)
  assert.equal(plan.toSkip.length, 1)
})

test('parseIssuesJson tolerates malformed payloads', async () => {
  const mod = await modPromise
  assert.deepEqual(mod.parseIssuesJson(''), [])
  assert.deepEqual(mod.parseIssuesJson('not-json'), [])
  assert.deepEqual(mod.parseIssuesJson('{"not":"array"}'), [])
  const ok = mod.parseIssuesJson(
    JSON.stringify([
      { number: 1, title: 'a' },
      { number: '2', title: 'b' },
      { title: 'missing number' },
    ]),
  )
  assert.deepEqual(ok, [
    { number: 1, title: 'a' },
    { number: 2, title: 'b' },
  ])
})

test('parseSessionsJson tolerates malformed payloads', async () => {
  const mod = await modPromise
  assert.deepEqual(mod.parseSessionsJson(''), [])
  assert.deepEqual(mod.parseSessionsJson('not-json'), [])
  assert.deepEqual(mod.parseSessionsJson('{"not":"array"}'), [])
  const ok = mod.parseSessionsJson(
    JSON.stringify([
      { id: 'aa-1', issueId: '7' },
      'invalid',
      null,
    ]),
  )
  assert.equal(ok.length, 1)
  assert.equal(ok[0].id, 'aa-1')
})
