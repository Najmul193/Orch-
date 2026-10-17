import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { Runner } from '../src/runner.mjs'
import { classify } from '../src/classify.mjs'
import { route, isLocalFriendly } from '../src/planner.mjs'
import { rankFree, buildChain } from '../src/pool.mjs'
import { agents } from '../src/agents.mjs'

const fakeAgent = {
  cmd: process.execPath,
  argv: (task, model) => [new URL('fake-agent.mjs', import.meta.url).pathname, model, task],
  resume: () => '',
  parser: () => (d) => (d.error ? [{ kind: 'error', text: d.error }] : [{ kind: 'text', text: d.text }]),
}

function makeRunner({ chain, config = {}, planner } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smart-'))
  const cfg = { maxParallel: 3, cooldownMinutes: 15, chains: { delegate: chain }, ...config }
  return new Runner(cfg, dataDir, { fake: fakeAgent }, planner)
}
const finished = async (runner, run) => { while (!['done', 'failed', 'killed'].includes(run.status)) await once(runner, 'run'); return run }

test('classify tags tasks', () => {
  assert.equal(classify('refactor the auth module and fix the bug').tag, 'code')
  assert.equal(classify('make the button rounded with new css').tag, 'ui')
  assert.equal(classify('write a readme and summarize the project').tag, 'docs')
  assert.equal(classify('research the best laptops and compare prices').tag, 'research')
  assert.equal(classify('parse this csv and plot a chart').tag, 'data')
  assert.equal(classify('hello there').tag, 'general')
})

test('route prefers the best free model for the tag', () => {
  const config = { routing: { code: ['strong-free', 'weak-free'] } }
  const pool = { free: ['opencode/weak-free', 'opencode/strong-free'] }
  const r = route('fix the parser bug', config, pool)
  assert.equal(r.tag, 'code')
  assert.deepEqual(r.pick, { agent: 'opencode', model: 'opencode/strong-free' })
  assert.equal(r.local, false)
})

test('route sends simple non-file work to the local model when enabled', () => {
  const config = { local: { enabled: true, model: 'qwen3:8b' }, routing: { general: ['x-free'] } }
  const r = route('summarize the idea of recursion in one line', config, { free: ['opencode/x-free'] })
  assert.deepEqual(r.pick, { agent: 'local', model: 'qwen3:8b' })
  assert.equal(r.local, true)
  assert.equal(isLocalFriendly('fix the bug in src/app.js', 'code'), false)
  assert.equal(route('write a script to rename files', config, { free: ['opencode/x-free'] }).local, false)
})

test('rankFree and buildChain order free models then agy fallback', () => {
  const pool = { free: ['opencode/weak-free', 'opencode/strong-free'], agy: ['gemini-3.8-flash-high'] }
  assert.deepEqual(rankFree(pool.free, ['strong-free']), ['opencode/strong-free', 'opencode/weak-free'])
  const chain = buildChain(pool, { prefer: ['strong-free'], limit: 1 })
  assert.deepEqual(chain, [
    { agent: 'opencode', model: 'opencode/strong-free', enabled: true },
    { agent: 'agy', model: 'gemini-3.8-flash-high', enabled: true },
  ])
})

test('fan-out splits a task and merges the children', async () => {
  const planner = {
    route: () => ({ tag: 'general', pick: null, order: [], local: false }),
    split: async () => [{ title: 'part a', prompt: 'do part a now' }, { title: 'part b', prompt: 'do part b now' }],
  }
  const runner = makeRunner({ chain: [{ agent: 'fake', model: 'ok' }], config: { fanout: true }, planner })
  const run = await finished(runner, runner.start({ task: 'two independent things', dir: os.tmpdir() }))
  assert.equal(run.status, 'done')
  assert.equal(run.children.length, 2)
  assert.match(run.final, /### part a/)
  assert.match(run.final, /### part b/)
  assert.match(run.final, /done by ok/)
})

test('a single-piece plan runs as one agent (no fan-out)', async () => {
  const planner = { route: () => ({ tag: 'general', pick: null, order: [], local: false }), split: async () => [{ title: 'only', prompt: 'do the whole thing' }] }
  const runner = makeRunner({ chain: [{ agent: 'fake', model: 'ok' }], config: { fanout: true }, planner })
  const run = await finished(runner, runner.start({ task: 'one connected task', dir: os.tmpdir() }))
  assert.equal(run.status, 'done')
  assert.equal(run.children.length, 0)
  assert.equal(run.final, 'done by ok')
})

test('local agent parser reads the shim output', () => {
  const parse = agents.local.parser()
  assert.deepEqual(parse({ type: 'text', text: 'hi there' }), [{ kind: 'text', text: 'hi there' }])
  assert.deepEqual(parse({ type: 'done', text: 'all done' }), [{ kind: 'done', text: 'all done' }])
  assert.deepEqual(parse({ type: 'error', error: 'boom' }), [{ kind: 'error', text: 'boom' }])
})
