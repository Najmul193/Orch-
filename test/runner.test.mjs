import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { Runner, planEntries } from '../src/runner.mjs'

const fakeAgent = {
  cmd: process.execPath,
  argv: (task, model) => [new URL('fake-agent.mjs', import.meta.url).pathname, model, task],
  resume: () => '',
  parser: () => (d) => (d.warn ? [{ kind: 'warn', text: d.warn }] : d.error ? [{ kind: 'error', text: d.error }] : [{ kind: 'text', text: d.text }]),
}

function makeRunner(chain) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'))
  const config = { maxParallel: 2, cooldownMinutes: 15, chains: { delegate: chain } }
  return new Runner(config, dataDir, { fake: fakeAgent })
}

async function finished(runner, run) {
  while (!['done', 'failed', 'killed'].includes(run.status)) await once(runner, 'run')
  return run
}

test('rate-limited entry cools down and the next one finishes the task', async () => {
  const runner = makeRunner([{ agent: 'fake', model: 'limited' }, { agent: 'fake', model: 'ok' }])
  const run = await finished(runner, runner.start({ task: 't', dir: os.tmpdir() }))
  assert.equal(run.status, 'done')
  assert.equal(run.model, 'ok')
  assert.equal(run.final, 'done by ok after retry')
  assert.deepEqual(run.attempts.map((a) => [a.model, a.ok]), [['limited', false], ['ok', true]])
  assert.ok(runner.cooldowns['fake:limited'] > Date.now())

  // Second run skips the cooling entry entirely.
  const run2 = await finished(runner, runner.start({ task: 't', dir: os.tmpdir() }))
  assert.deepEqual(run2.attempts.map((a) => a.model), ['ok'])
})

test('a non-limit failure falls through without a cooldown and tells the next agent', async () => {
  const runner = makeRunner([{ agent: 'fake', model: 'broken' }, { agent: 'fake', model: 'ok' }])
  const run = await finished(runner, runner.start({ task: 'my task', dir: os.tmpdir() }))
  assert.equal(run.status, 'done')
  assert.equal(run.final, 'done by ok after retry')
  assert.equal(runner.cooldowns['fake:broken'], undefined)
})

test('a provider-overloaded error benches the model briefly and moves on', async () => {
  const runner = makeRunner([{ agent: 'fake', model: 'overloaded' }, { agent: 'fake', model: 'ok' }])
  const run = await finished(runner, runner.start({ task: 't', dir: os.tmpdir() }))
  assert.equal(run.status, 'done')
  assert.equal(run.model, 'ok')
  const cool = runner.cooldowns['fake:overloaded'] - Date.now()
  assert.ok(cool > 0 && cool <= 2 * 60_000 + 5000, `expected a short bench, got ${cool}ms`)
})

test('all entries failing marks the run failed; disabled entries are skipped', async () => {
  const runner = makeRunner([{ agent: 'fake', model: 'ok', enabled: false }, { agent: 'fake', model: 'broken' }])
  const run = await finished(runner, runner.start({ task: 't', dir: os.tmpdir() }))
  assert.equal(run.status, 'failed')
  assert.match(run.error, /model crashed/)
  assert.deepEqual(run.attempts.map((a) => a.model), ['broken'])
})

test('a failed tool is a warning, not a run failure', async () => {
  const runner = makeRunner([{ agent: 'fake', model: 'toolerr' }, { agent: 'fake', model: 'ok' }])
  const run = await finished(runner, runner.start({ task: 't', dir: os.tmpdir() }))
  assert.equal(run.status, 'done')
  assert.equal(run.model, 'toolerr') // did not fall through to "ok"
  assert.equal(run.attempts.length, 1)
  assert.equal(run.final, 'done toolerr')
})

test('kill stops a running agent', async () => {
  const runner = makeRunner([{ agent: 'fake', model: 'slow' }, { agent: 'fake', model: 'ok' }])
  const run = runner.start({ task: 't', dir: os.tmpdir() })
  while (!run.child) await once(runner, 'event')
  const child = run.child
  assert.ok(runner.kill(run.id))
  await once(child, 'close')
  assert.equal(run.status, 'killed')
  assert.equal(run.attempts.length, 1) // did not fall through to "ok"
})

test('history is reloaded from disk', async () => {
  const runner = makeRunner([{ agent: 'fake', model: 'ok' }])
  const run = await finished(runner, runner.start({ task: 'remember me', dir: os.tmpdir() }))
  const again = new Runner(runner.config, path.dirname(runner.dir), { fake: fakeAgent })
  const loaded = again.runs.get(run.id)
  assert.equal(loaded.status, 'done')
  assert.equal(loaded.task, 'remember me')
})

test('planEntries puts an explicit model or agent first', () => {
  const chain = [{ agent: 'opencode', model: 'a/x' }, { agent: 'agy', model: 'g' }, { agent: 'opencode', model: 'b/y', enabled: false }]
  assert.deepEqual(planEntries(chain, { model: 'g' }).map((e) => e.model), ['g', 'a/x'])
  assert.deepEqual(planEntries(chain, { model: 'c/z' })[0], { agent: 'opencode', model: 'c/z' })
  assert.deepEqual(planEntries(chain, { agent: 'agy' }).map((e) => e.model), ['g', 'a/x'])
})
