#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { createApp, loadConfig, expandHome } from '../src/server.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const config = loadConfig(process.env.ORCH_CONFIG || path.join(ROOT, 'config.json'))
const BASE = `http://127.0.0.1:${config.port}`
const USAGE = `usage:
  orch serve                                   start the dashboard + agent runner (${BASE})
  orch delegate [--dir <abs>] [--agent opencode|agy] [--model <m>] [--chain delegate|handoff] "<task>"`

const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'serve') {
  const { server, runner } = createApp()
  // Agents run in their own process group, so stop them explicitly or they outlive orch.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const id of runner.runs.keys()) runner.kill(id); process.exit(0) })
  server.on('error', (err) => { console.error(err.code === 'EADDRINUSE' ? `orch is already running on ${BASE}` : err.message); process.exit(1) })
  server.listen(config.port, '127.0.0.1', () => console.log(`orch dashboard: ${BASE}`))
} else if (cmd === 'delegate') {
  await delegate(rest)
} else {
  console.log(USAGE)
  process.exit(cmd ? 1 : 0)
}

async function delegate(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { dir: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' }, chain: { type: 'string' } },
  })
  const task = positionals.join(' ').trim()
  if (!task) { console.error(USAGE); process.exit(1) }
  const dir = values.dir || expandHome(config.defaultDir || '') || process.cwd()
  await ensureServer()

  // Subscribe before starting the run so no event is missed.
  const ac = new AbortController()
  const events = await fetch(`${BASE}/events`, { signal: ac.signal })
  const res = await api('POST', '/api/runs', { task, dir: path.resolve(dir), agent: values.agent, model: values.model, chain: values.chain, source: 'cli' })
  if (res.error) { console.error(`orch: ${res.error}`); process.exit(1) }
  const id = res.id
  console.log(`orch run ${id} queued — watch it at ${BASE}`)
  process.on('SIGINT', async () => { await api('POST', `/api/runs/${id}/kill`, {}); process.exit(130) })
  process.on('SIGTERM', async () => { await api('POST', `/api/runs/${id}/kill`, {}); process.exit(143) })

  let buf = ''
  const decoder = new TextDecoder()
  try {
    for await (const chunk of events.body) {
      buf += decoder.decode(chunk, { stream: true })
      const msgs = buf.split('\n\n')
      buf = msgs.pop()
      for (const m of msgs) {
        if (!m.startsWith('data: ')) continue
        const msg = JSON.parse(m.slice(6))
        if (msg.type === 'event' && msg.ev.runId === id && msg.ev.kind !== 'text' && msg.ev.kind !== 'done') {
          console.log(`  [${msg.ev.model}] ${msg.ev.kind === 'tool' ? '' : msg.ev.kind + ': '}${msg.ev.text}`)
        }
        if (msg.type === 'run' && msg.run.id === id && ['done', 'failed', 'killed'].includes(msg.run.status)) {
          const r = msg.run
          console.log(`\norch run ${id} ${r.status} (${r.agent} ${r.model})${r.error ? ': ' + r.error : ''}`)
          if (r.final) console.log(`\n${r.final}`)
          ac.abort()
          process.exit(r.status === 'done' ? 0 : 1)
        }
      }
    }
  } catch {} // the stream breaks when the server goes away; reported below
  console.error(`\norch: lost connection to the server before run ${id} finished`)
  process.exit(1)
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.json()
}

async function ensureServer() {
  const up = () => fetch(`${BASE}/api/state`).then((r) => r.ok, () => false)
  if (await up()) return
  spawn(process.execPath, [import.meta.filename, 'serve'], { detached: true, stdio: 'ignore', env: process.env }).unref()
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await up()) return
  }
  console.error(`orch: could not start the server on ${BASE}`)
  process.exit(1)
}
