import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runner } from './runner.mjs'
import { ClaudeWatch } from './claude-watch.mjs'
import { discoverPool, buildChain } from './pool.mjs'
import { buildHandoffPrompt, readTranscript } from './handoff.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const EDITABLE = ['chains', 'autoHandoff', 'maxParallel', 'cooldownMinutes', 'fanout', 'local', 'claudeHandoff', 'permissions', 'openOnPermission']

export const expandHome = (p) => p.replace(/^~(?=$|\/)/, os.homedir())

export function loadConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

// Object-valued settings are merged on update, and filled with defaults on load,
// so a partial payload can never wipe a field (e.g. the local model name).
const DEFAULTS = {
  local: { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen3:8b' },
  permissions: { mode: 'ask', trusted: [] },
}

export function createApp({ configPath = process.env.ORCH_CONFIG || path.join(ROOT, 'config.json'), dataDir = path.join(ROOT, 'data'), agentDefs } = {}) {
  const config = loadConfig(configPath)
  for (const [k, def] of Object.entries(DEFAULTS)) config[k] = { ...def, ...config[k] }
  const runner = new Runner(config, dataDir, agentDefs)
  const watch = new ClaudeWatch(expandHome(config.claudeProjectsDir || '~/.claude/projects'))
  const clients = new Set()
  const send = (msg) => { for (const res of clients) res.write(`data: ${JSON.stringify(msg)}\n\n`) }
  const cooldowns = () => Object.fromEntries(Object.entries(runner.cooldowns).filter(([, t]) => t > Date.now()))

  runner.on('event', (ev) => send({ type: 'event', ev }))
  runner.on('run', (run) => { send({ type: 'run', run }); maybeOpenForPermission(run) })
  runner.on('cooldowns', () => send({ type: 'config', config, cooldowns: cooldowns() }))
  runner.on('config', () => send({ type: 'config', config, cooldowns: cooldowns() }))
  watch.on('session', (session) => send({ type: 'session', session }))

  // When an agent is parked waiting for your permission, bring the dashboard to the
  // front so you can Allow or Deny it. One tab per request, throttled.
  const journal = new Set()
  let lastOpen = 0
  function maybeOpenForPermission(run) {
    const id = run.permission?.id
    if (!id || journal.has(id) || config.openOnPermission === false) return
    journal.add(id)
    if (Date.now() - lastOpen < 3000) return
    lastOpen = Date.now()
    console.log(`permission needed for run ${run.id} -> opening dashboard`)
    const [cmd, prefix] = process.platform === 'darwin' ? ['open', []]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '']]
      : ['xdg-open', []]
    execFile(cmd, [...prefix, `http://127.0.0.1:${config.port}`], () => {})
  }

  function handoff(sessionId) {
    const s = watch.sessions.get(sessionId)
    if (!s) throw httpError(404, 'unknown session')
    if (!s.cwd || !fs.existsSync(s.cwd)) throw httpError(400, `session folder not found: ${s.cwd}`)
    const busy = runner.list().find((r) => r.source === `claude:${sessionId}` && (r.status === 'queued' || r.status === 'running'))
    if (busy) return runner.runs.get(busy.id)
    const { goal, prompt } = buildHandoffPrompt(readTranscript(s.file), s.cwd)
    return runner.start({ task: prompt, dir: s.cwd, chain: 'handoff', source: `claude:${sessionId}`, title: `Handoff: ${goal.split('\n')[0].slice(0, 100)}` })
  }

  watch.on('limit', (s) => {
    if (!config.autoHandoff) return
    try { handoff(s.id) } catch (err) { console.error(`auto handoff for ${s.id} failed: ${err.message}`) }
  })
  // The dashboard is the only input now; only watch Claude transcripts if asked to.
  if (config.claudeHandoff !== false) watch.start()

  // Auto-pool: discover the best free models and rebuild the delegate chain so the
  // dashboard always offers fresh agents without hand-editing config.
  if (config.autoPool !== false) {
    discoverPool().then((pool) => {
      runner.pool = pool
      const chain = buildChain(pool, { prefer: config.poolPrefer, limit: config.poolLimit })
      if (chain.length) {
        config.chains.delegate = chain
        send({ type: 'config', config, cooldowns: cooldowns() })
      }
    }).catch(() => {})
  }

  const modelCache = {}
  async function listModels(agent) {
    const hit = modelCache[agent]
    if (hit && Date.now() - hit.t < 10 * 60_000) return hit.list
    const def = runner.agents[agent]
    const { stdout } = await promisify(execFile)(def.cmd, def.models.argv, { timeout: 30_000, maxBuffer: 8e6 })
    modelCache[agent] = { t: Date.now(), list: def.models.parse(stdout) }
    return modelCache[agent].list
  }

  const routes = {
    'GET /': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html')))
    },
    'GET /api/models': async () => Object.fromEntries(await Promise.all(Object.keys(runner.agents).filter((a) => runner.agents[a].models)
      .map(async (a) => [a, await listModels(a).catch(() => [])]))),
    'GET /api/state': () => ({ config, cooldowns: cooldowns(), runs: runner.list(), sessions: watch.list() }),
    'GET /events': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
    },
    'GET /api/runs/:id': (req, res, id) => {
      const run = runner.runs.get(id)
      if (!run) throw httpError(404, 'unknown run')
      return { run: runner.public(run), task: run.task, events: runner.events(id).filter((l) => l.type === 'event') }
    },
    'POST /api/runs': (req, res, _id, body) => {
      const { task, dir, chain = 'delegate', agent, model, source = 'api' } = body
      if (!task?.trim()) throw httpError(400, 'task is required')
      const target = dir?.trim() || expandHome(config.defaultDir || '') || process.cwd()
      if (!path.isAbsolute(target) || !fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) throw httpError(400, 'dir must be an existing absolute folder')
      if (!config.chains[chain]) throw httpError(400, `unknown chain: ${chain}`)
      if (target === os.homedir() || target === '/') throw httpError(400, 'refusing to run an agent in your home folder or /')
      return runner.public(runner.start({ task, dir: target, chain, agent, model, source: String(source).slice(0, 40) }))
    },
    'POST /api/runs/:id/kill': (req, res, id) => ({ killed: runner.kill(id) }),
    'POST /api/runs/:id/permission': (req, res, id, body) => {
      const { permissionId, allow, remember } = body
      if (!permissionId || typeof allow !== 'boolean') throw httpError(400, 'permissionId and allow are required')
      if (!runner.permissions.has(permissionId)) throw httpError(404, 'no such pending permission')
      return { ok: runner.resolvePermission(permissionId, allow, !!remember) }
    },
    'POST /api/sessions/:id/handoff': (req, res, id) => runner.public(handoff(id)),
    'PUT /api/config': (req, res, _id, body) => {
      const badChain = body.chains && Object.values(body.chains).some((c) => !Array.isArray(c) || c.some((e) => !runner.agents[e?.agent] || typeof e.model !== 'string'))
      if (badChain || ('maxParallel' in body && !(body.maxParallel >= 1))) throw httpError(400, 'invalid config')
      for (const k of EDITABLE) {
        if (!(k in body)) continue
        if (DEFAULTS[k]) config[k] = { ...config[k], ...body[k] } // merge objects, never drop fields
        else config[k] = body[k]
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
      send({ type: 'config', config, cooldowns: cooldowns() })
      return config
    },
    'DELETE /api/cooldowns': () => {
      runner.cooldowns = {}
      send({ type: 'config', config, cooldowns: {} })
      return {}
    },
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      // Only this machine, and only this page: block DNS rebinding and cross-site requests,
      // since a request here can start an agent that runs shell commands.
      const host = req.headers.host ?? ''
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw httpError(403, 'bad host')
      if (req.method !== 'GET') {
        if (req.headers.origin && req.headers.origin !== `http://${host}`) throw httpError(403, 'bad origin')
        if (req.method !== 'DELETE' && !req.headers['content-type']?.startsWith('application/json')) throw httpError(415, 'json only')
      }
      const parts = url.pathname.split('/')
      const id = parts[3]
      const key = `${req.method} ${id ? [...parts.slice(0, 3), ':id', ...parts.slice(4)].join('/') : url.pathname}`
      const route = routes[key]
      if (!route) throw httpError(404, 'not found')
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : JSON.parse((await readBody(req)) || '{}')
      const out = await route(req, res, id && decodeURIComponent(id), body)
      if (out !== undefined) json(res, 200, out)
    } catch (err) {
      json(res, err.status ?? 500, { error: err.message })
    }
  })

  return { server, runner, watch, config, handoff }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function json(res, status, obj) {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(httpError(413, 'too large')) })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
