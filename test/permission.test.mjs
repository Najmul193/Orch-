import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { Runner } from '../src/runner.mjs'

const fakePath = new URL('fake-agent.mjs', import.meta.url).pathname
const agent = {
  cmd: process.execPath,
  argv: (task, model) => [fakePath, model, task],
  resume: () => '',
  parser: () => (d) => (d.error ? [{ kind: 'error', text: d.error }]
    : d.type === 'tool' ? [{ kind: 'tool', text: d.text }]
    : [{ kind: 'text', text: d.text }]),
}

function makeRunner({ chain, config = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-perm-'))
  const cfg = { maxParallel: 3, cooldownMinutes: 15, chains: { delegate: chain }, ...config }
  return new Runner(cfg, dataDir, { fake: agent })
}
const finished = async (runner, run) => { while (!['done', 'failed', 'killed'].includes(run.status)) await once(runner, 'run'); return run }


test('a file task in an untrusted folder waits for permission, then runs when allowed', async () => {
  const runner = makeRunner({ chain: [{ agent: 'fake', model: 'ok', enabled: true }], config: { permissions: { mode: 'ask', trusted: [] } } })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-perm-'))
  const run = runner.start({ task: 'fix the bug in src/app.js', dir, chain: 'delegate' })
  assert.equal(run.status, 'waiting')
  assert.equal(run.permission.kind, 'folder')
  assert.equal(run.permission.detail, dir)
  assert.equal(runner.resolvePermission(run.permission.id, true), true)
  await finished(runner, run)
  assert.equal(run.status, 'done')
})

test('denying a permission kills the run', async () => {
  const runner = makeRunner({ chain: [{ agent: 'fake', model: 'ok', enabled: true }], config: { permissions: { mode: 'ask', trusted: [] } } })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-perm-'))
  const run = runner.start({ task: 'refactor the parser module', dir })
  assert.equal(run.status, 'waiting')
  runner.resolvePermission(run.permission.id, false)
  await finished(runner, run)
  assert.equal(run.status, 'killed')
  assert.match(run.error, /permission denied/)
})

test('a trusted folder runs with no prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-perm-'))
  const runner = makeRunner({ chain: [{ agent: 'fake', model: 'ok', enabled: true }], config: { permissions: { mode: 'ask', trusted: [dir] } } })
  const run = runner.start({ task: 'fix the bug in src/app.js', dir })
  await finished(runner, run)
  assert.equal(run.status, 'done')
})

test('"always allow" remembers the folder', async () => {
  const runner = makeRunner({ chain: [{ agent: 'fake', model: 'ok', enabled: true }], config: { permissions: { mode: 'ask', trusted: [] } } })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-perm-'))
  const run = runner.start({ task: 'edit the css for the banner', dir })
  assert.equal(run.status, 'waiting')
  runner.resolvePermission(run.permission.id, true, true)
  await finished(runner, run)
  assert.deepEqual(runner.config.permissions.trusted, [dir])
})

test('permissions mode "off" skips the folder prompt', async () => {
  const runner = makeRunner({ chain: [{ agent: 'fake', model: 'ok', enabled: true }], config: { permissions: { mode: 'off', trusted: [] } } })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-perm-'))
  const run = runner.start({ task: 'fix the bug in src/app.js', dir })
  await finished(runner, run)
  assert.equal(run.status, 'done')
})

test('reading a file outside the project asks first, then grants that folder', async () => {
  const runner = makeRunner({ chain: [{ agent: 'fake', model: 'ok', enabled: true }], config: { permissions: { mode: 'ask', trusted: [] } } })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-perm-'))
  const run = runner.start({ task: 'summarize what is on my desktop', dir })
  assert.equal(run.status, 'waiting')
  assert.equal(run.permission.kind, 'file')
  assert.match(run.permission.detail, /Desktop/)
  runner.resolvePermission(run.permission.id, true, true)
  await finished(runner, run)
  assert.equal(run.status, 'done')
  assert.ok(runner.config.permissions.trusted.some((d) => d.endsWith('Desktop')))
})

test('a risky command pauses a running agent for approval', async () => {
  const runner = makeRunner({ chain: [{ agent: 'fake', model: 'risky', enabled: true }], config: { permissions: { mode: 'ask', trusted: [] } } })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-perm-'))
  const run = runner.start({ task: 'hello there', dir }) // general, so no folder prompt
  const waiting = await Promise.race([
    (async () => { while (run.status !== 'waiting') await once(runner, 'run'); return run })(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('never paused for the risky command')), 5000)),
  ])
  assert.equal(waiting.permission.kind, 'command')
  assert.match(waiting.permission.detail, /rm -rf/)
  runner.resolvePermission(waiting.permission.id, true)
  await finished(runner, run)
  assert.equal(run.status, 'done')
})
