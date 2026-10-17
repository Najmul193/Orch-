import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { agents, isLimitError } from './agents.mjs'
import { route, split } from './planner.mjs'
import { classify } from './classify.mjs'

const RETRY_NOTE = '\n\nNote: a previous attempt at this task may have left partial changes. Check `git status`/`git diff` first and continue from there.'
const FINISHED = new Set(['done', 'failed', 'killed'])
// Task kinds that make an agent touch files or run commands, so they need a human OK.
const FILE_TAGS = new Set(['code', 'ui', 'data'])
// Commands that hit the filesystem, the network, or the machine hard: pause and ask first.
const RISKY = /\brm\s+-rf\b|\bsudo\b|\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|\bchmod\s+-R\b|\bchown\b|\bdd\s+if=|\bmkfs\b|\bdiskutil\b|\bshutdown\b|\breboot\b|\bkillall\b|npm\s+publish|\bcurl\b[^\n|]*\|\s*(?:ba|z|fi)?sh|\bwget\b[^\n|]*\|\s*(?:ba|z|fi)?sh/i
const HOME = process.env.HOME || ''
const NAMED_DIRS = { desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', movies: 'Movies', music: 'Music', pictures: 'Pictures', 'dropbox': 'Dropbox' }
// Folders a task wants an agent to reach outside its working directory. A headless
// agent can't ask us itself (it just denies), so we detect these first and ask the
// user once, then hand the agent access to exactly those folders.
function extPaths(task, base) {
  const out = new Set()
  const add = (raw) => {
    if (!raw) return
    const abs = raw.startsWith('~/') ? path.join(HOME, raw.slice(2)) : raw
    if (!path.isAbsolute(abs)) return
    const dir = /\.[a-z0-9]{1,6}$/i.test(abs) ? path.dirname(abs) : abs
    const segs = dir.split(path.sep).filter(Boolean).length
    const underHome = HOME && dir.startsWith(HOME + path.sep)
    if (!underHome && segs < 2) return // ignore noise like "/or"
    if (dir === base || dir.startsWith(base + path.sep) || base.startsWith(dir + path.sep)) return // already inside the project
    out.add(dir)
  }
  for (const m of task.matchAll(/(?:~|\/)[^\s'"]{2,}/g)) add(m[0].replace(/[.,;:)\]]+$/, ''))
  for (const [word, name] of Object.entries(NAMED_DIRS)) {
    if (HOME && new RegExp(`\\b${word}\\b`, 'i').test(task)) add(path.join(HOME, name))
  }
  return [...out]
}

// Order of entries to try: an explicit model first, then the rest of the chain.
export function planEntries(chain, { agent, model } = {}) {
  const on = chain.filter((e) => e.enabled !== false)
  if (model) return [{ agent: agent || (model.includes('/') ? 'opencode' : 'agy'), model }, ...on.filter((e) => e.model !== model)]
  if (agent) return [...on.filter((e) => e.agent === agent), ...on.filter((e) => e.agent !== agent)]
  return on
}

export class Runner extends EventEmitter {
  constructor(config, dataDir, agentDefs = agents, planner = { route, split }) {
    super()
    this.config = config
    this.agents = agentDefs
    this.planner = planner
    this.dir = path.join(dataDir, 'runs')
    fs.mkdirSync(this.dir, { recursive: true })
    this.runs = new Map()
    this.queue = []
    this.cooldowns = {} // "agent:model" -> ms timestamp
    this.pool = { free: [], agy: [] } // discovered models for smart routing
    this.permissions = new Map() // permission id -> pending user approval
    this.permSeq = 0
    config.permissions ??= { mode: 'ask', trusted: [] } // 'ask' | 'off'
    config.permissions.trusted ??= []
    this.#loadHistory()
  }

  start({ task, dir, chain = 'delegate', agent, model, title, source = 'cli' }) {
    const id = `${Date.now()}-${randomBytes(2).toString('hex')}`
    const run = {
      id, task, dir, chain, source, agent: null, model: null, session: null,
      title: title || task.split('\n')[0].slice(0, 120),
      status: 'queued', phase: '', final: '', error: '', attempts: [],
      createdAt: Date.now(), startedAt: null, endedAt: null,
      want: { agent, model }, plan: null, parentId: null, children: [],
    }
    this.runs.set(id, run)
    this.#write(run, { type: 'run', ...this.public(run), task })
    // Smart routing: if the caller didn't pin an agent/model, prefer the best free
    // model for this kind of task. The rest of the chain still backs it up.
    if (!model && !agent) {
      const r = this.planner.route(task, this.config, this.pool)
      // Always record the plan (tag + whether it is big enough to fan out), even
      // before the model pool is discovered and a pick exists yet.
      run.plan = { tag: r.tag, complex: r.complex, ...(r.pick ? { agent: r.pick.agent, model: r.pick.model } : {}), local: r.local }
      if (r.pick) {
        run.want = { ...r.pick }
        this.#event(run, { kind: 'info', text: `routed ${r.tag} -> ${r.local ? 'local ' : ''}${r.pick.model}` })
      }
    }
    this.#changed(run)
    if (this.#shouldFan(run)) this.#fan(run)
    else this.#enqueue(run)
    return run
  }

  #enqueue(run) {
    this.queue.push(run)
    this.#changed(run)
    this.#pump()
  }

  // Only fan out when the task is big enough to be worth several agents at once;
  // simple or local-routed tasks stay a single call.
  #shouldFan(run) {
    if (this.config.fanout === false) return false
    const p = run.plan
    if (!p || p.local) return false // a pinned model, or answered by the local model
    return p.complex === true || p.tag === 'research' || p.tag === 'data'
  }

  // Choose a different model for each subtask (round-robin over the live chain) so
  // the parts really run on several models at once instead of all hitting one.
  #spread(run, n) {
    const now = Date.now()
    const chain = planEntries(this.config.chains[run.chain] ?? [], {})
    const live = chain.filter((e) => (this.cooldowns[`${e.agent}:${e.model}`] ?? 0) <= now)
    const pool = live.length ? live : chain
    return Array.from({ length: n }, (_, i) => (pool.length ? pool[i % pool.length] : run.want))
  }

  // Planning step: try to break the task into independent pieces that several
  // agents can run at once. Falls back to a single agent when it can't.
  async #fan(run) {
    run.status = 'planning'
    run.phase = 'planning'
    this.#changed(run)
    this.#event(run, { kind: 'info', text: 'planning: can this fan out to several agents?' })
    let subtasks = []
    try { subtasks = await this.planner.split(run.task, { model: this.config.plannerModel, dir: run.dir, config: this.config }) } catch { /* planner unavailable */ }
    if (this.planner.fallbackSplit && subtasks.length < 2) subtasks = this.planner.fallbackSplit(run.task, run.plan?.tag)
    if (run.status === 'killed') return
    if (subtasks.length < 2) {
      run.status = 'queued'
      run.phase = ''
      this.#event(run, { kind: 'info', text: subtasks.length ? 'plan: one connected task, keeping a single agent' : 'plan: running as one task' })
      this.#enqueue(run)
      return
    }
    run.status = 'running'
    run.startedAt = Date.now()
    run.phase = 'fanout'
    const picks = this.#spread(run, subtasks.length)
    run.plan = { ...(run.plan || {}), subtasks: subtasks.map((s) => s.title), assign: picks.map((e) => `${e?.agent}·${String(e?.model ?? '').replace(/^opencode\//, '')}`) }
    this.#event(run, { kind: 'info', text: `fan-out: ${subtasks.length} subtasks across ${new Set(picks.map((e) => e?.model)).size} models` })
    this.#changed(run)
    run.children = subtasks.map((s, i) => this.#child(run, s, picks[i]))
    for (const cid of run.children) this.queue.push(this.runs.get(cid))
    this.#changed(run)
    this.#ensureBeat()
    this.#pump()
  }

  // Supervisor: while a fan-out has children in flight, report their progress on
  // the parent every few seconds so the diagram keeps you posted.
  #ensureBeat() {
    if (this.beat) return
    this.beat = setInterval(() => this.#reportAll(), this.config.heartbeatMs ?? 5000)
    this.beat.unref?.()
  }

  #reportAll() {
    let active = 0
    for (const run of this.runs.values()) {
      if (!run.children?.length || FINISHED.has(run.status)) continue
      active++
      this.#report(run)
    }
    if (!active && this.beat) { clearInterval(this.beat); this.beat = null }
  }

  #report(run) {
    const kids = run.children.map((id) => this.runs.get(id)).filter(Boolean)
    if (!kids.length) return
    const done = kids.filter((k) => k.status === 'done').length
    const bad = kids.filter((k) => k.status === 'failed' || k.status === 'killed').length
    const working = kids.filter((k) => ['running', 'queued', 'waiting'].includes(k.status))
    const where = working.map((k) => `${String(k.model).replace(/^opencode\//, '')} ${k.status === 'running' ? k.phase || 'working' : k.status}`).slice(0, 3).join(', ')
    run.phase = `fanout ${done}/${kids.length}`
    this.#event(run, { kind: 'info', text: `progress ${done}/${kids.length} done${bad ? `, ${bad} failed` : ''}${where ? ` · ${where}` : ''}` })
    this.#changed(run)
  }

  #child(run, sub, entry) {
    const id = `${Date.now()}-${randomBytes(2).toString('hex')}`
    const child = {
      id, task: sub.prompt, dir: run.dir, chain: run.chain, source: run.source,
      agent: null, model: null, session: null, title: sub.title,
      status: 'queued', phase: '', final: '', error: '', attempts: [],
      createdAt: Date.now(), startedAt: null, endedAt: null,
      want: entry ? { ...entry } : { ...run.want }, plan: run.plan ? { tag: run.plan.tag } : null, parentId: run.id, children: [],
    }
    this.runs.set(id, child)
    this.#write(child, { type: 'run', ...this.public(child), task: child.task })
    this.#changed(child)
    return id
  }

  // A fan-out parent finishes once every subtask has finished.
  #finishChildOf(child) {
    const parent = this.runs.get(child.parentId)
    if (!parent || FINISHED.has(parent.status)) return
    const kids = parent.children.map((id) => this.runs.get(id)).filter(Boolean)
    if (kids.some((k) => !FINISHED.has(k.status))) return
    const ok = kids.filter((k) => k.status === 'done')
    parent.attempts = kids.flatMap((k) => k.attempts || [])
    parent.final = kids.map((k) => `### ${k.title}\n\n${k.final || k.error || '(no output)'}`).join('\n\n---\n\n')
    if (ok.length === 0) this.#finish(parent, 'failed', `all ${kids.length} subtasks failed`)
    else this.#finish(parent, 'done')
  }

  kill(id) {
    const run = this.runs.get(id)
    if (!run || FINISHED.has(run.status)) return false
    const kids = (run.children || []).map((cid) => this.runs.get(cid)).filter((k) => k && !FINISHED.has(k.status))
    const targets = [run, ...kids]
    this.queue = this.queue.filter((r) => !targets.includes(r))
    this.#denyPending(run)
    this.#finish(run, 'killed', 'stopped by user') // parent first, so children don't re-finish it
    for (const k of kids) this.#finish(k, 'killed', 'stopped by user')
    for (const t of targets) {
      const ch = t.child
      if (ch) { try { process.kill(-ch.pid, 'SIGTERM') } catch { try { ch.kill('SIGTERM') } catch {} } }
    }
    return true
  }

  // A run is blocked on a permission prompt: unblock it (used when the run is killed).
  #denyPending(run) {
    for (const [id, p] of this.permissions) {
      if (p.run === run || (run.children || []).includes(p.run.id)) { this.permissions.delete(id); p.resolve({ allow: false }) }
    }
  }

  // Permission gate. Before an agent that can edit files or run shell is allowed
  // to work in a folder the user hasn't trusted, park the run as "waiting" and
  // resolve it when the user clicks Allow / Deny on the dashboard diagram.
  async #guard(run) {
    const perms = this.config.permissions
    if (!perms || perms.mode === 'off' || run.plan?.local) return true
    const tag = run.plan?.tag || classify(run.task).tag
    run.plan = { ...(run.plan || {}), tag }
    // 1. Folders the agent would edit files / run commands in (code / ui / data work).
    if (FILE_TAGS.has(tag) && !perms.trusted.includes(run.dir)) {
      // A prompt for this same folder may already be open (fan-out): share one answer.
      const shared = [...this.permissions.values()].find((p) => p.rememberKey === run.dir)
      if (shared) {
        run.status = 'waiting'
        run.permission = shared.run.permission
        this.#changed(run)
        if (!(await shared.promise).allow) return false
      } else {
        const { allow } = await this.#ask(run, { kind: 'folder', what: 'Let an agent edit files and run commands here?', detail: run.dir, remember: run.dir })
        if (!allow) return false
      }
    }
    // 2. Files outside the working directory (e.g. ~/Desktop): ask once, then grant
    //    the agent access to exactly those folders so its read tool works.
    const grants = extPaths(run.task, run.dir)
    run.grants = grants
    const need = grants.filter((d) => !perms.trusted.includes(d))
    if (need.length) {
      const { allow } = await this.#ask(run, { kind: 'file', what: 'Let the agent read files outside the project?', detail: need.join('\n'), remember: need })
      if (!allow) return false
    }
    return true
  }

  // Park the run and hand the dashboard a request it can answer from the diagram.
  #ask(run, { kind, what, detail, remember }) {
    const id = `permission-${++this.permSeq}`
    run.permission = { id, kind, what, detail: String(detail ?? '').slice(0, 300), remember: remember || '' }
    run.status = 'waiting'
    this.#changed(run)
    this.#event(run, { kind: 'info', text: `waiting for permission: ${run.permission.what}` })
    let resolve
    const promise = new Promise((r) => { resolve = r })
    this.permissions.set(id, { resolve, promise, run, rememberKey: remember })
    return promise
  }

  // Called by the dashboard when the user accepts or denies a prompt.
  resolvePermission(id, allow, remember = false) {
    const p = this.permissions.get(id)
    if (!p) return false
    this.permissions.delete(id)
    const { run } = p
    run.permission = null
    if (allow && remember && p.rememberKey) {
      const keys = Array.isArray(p.rememberKey) ? p.rememberKey : [p.rememberKey]
      const fresh = keys.filter((k) => k && !this.config.permissions.trusted.includes(k))
      if (fresh.length) { this.config.permissions.trusted.push(...fresh); this.emit('config') }
    }
    this.#event(run, { kind: 'info', text: allow ? 'permission granted' : 'permission denied' })
    if (allow && !FINISHED.has(run.status)) { run.status = 'running'; this.#changed(run) }
    p.resolve({ allow })
    return true
  }

  public(run) {
    const { child, want, task, ...rest } = run
    return { ...rest, resume: run.session ? this.agents[run.agent]?.resume(run.session, run.dir) : null }
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt).map((r) => this.public(r))
  }

  events(id) {
    try {
      return fs.readFileSync(path.join(this.dir, `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch { return [] }
  }

  #pump() {
    // Count only agent runs: a fan-out parent supervises children and must not
    // occupy a parallel slot itself.
    const running = [...this.runs.values()].filter((r) => r.status === 'running' && !r.children?.length).length
    for (let i = running; i < (this.config.maxParallel || 3) && this.queue.length; i++) {
      const run = this.queue.shift()
      this.#exec(run).catch((err) => this.#finish(run, 'failed', err.message))
    }
  }

  async #exec(run) {
    if (!(await this.#guard(run))) {
      if (!FINISHED.has(run.status)) this.#finish(run, 'killed', 'permission denied')
      return
    }
    if (FINISHED.has(run.status)) return
    run.permission = null
    run.status = 'running'
    run.startedAt = Date.now()
    this.#changed(run)
    const entries = planEntries(this.config.chains[run.chain] ?? [], run.want)
    let prompt = run.task
    for (const e of entries) {
      const key = `${e.agent}:${e.model}`
      if ((this.cooldowns[key] ?? 0) > Date.now()) {
        this.#event(run, { kind: 'info', text: `skip ${key}: cooling down` })
        continue
      }
      if (!this.agents[e.agent]) continue
      const res = await this.#attempt(run, e, prompt)
      run.attempts.push({ agent: e.agent, model: e.model, session: run.session, ok: res.ok, error: res.error })
      if (run.status === 'killed') return
      if (res.ok) return this.#finish(run, 'done')
      if (res.limited) {
        // shortcut: fixed cooldown, ignores any reset time in the error; parse it once a real free-model limit message is captured
        this.cooldowns[key] = Date.now() + (this.config.cooldownMinutes ?? 15) * 60_000
        this.emit('cooldowns', this.cooldowns)
      }
      this.#event(run, { kind: 'info', text: `${key} failed${res.limited ? ' (rate limited)' : ''}: ${res.error}. Trying next agent.` })
      prompt = run.task + RETRY_NOTE
    }
    this.#finish(run, 'failed', run.attempts.length ? `all agents failed (last: ${run.attempts.at(-1).error})` : 'no agent available (all disabled or cooling down)')
  }

  // A risky command is about to run: freeze the agent's process group, ask the
  // user, then continue or kill the agent based on the answer.
  async #pauseForCommand(run, child, command) {
    try { process.kill(-child.pid, 'SIGSTOP') } catch { try { child.kill('SIGSTOP') } catch {} }
    const { allow } = await this.#ask(run, { kind: 'command', what: 'Run this possibly risky command?', detail: command, remember: '' })
    run.pending = false
    if (allow) {
      run.approved = true
      try { process.kill(-child.pid, 'SIGCONT') } catch { try { child.kill('SIGCONT') } catch {} }
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
      this.kill(run.id)
    }
  }

  #attempt(run, entry, prompt) {
    const def = this.agents[entry.agent]
    Object.assign(run, { agent: entry.agent, model: entry.model, session: null })
    this.#changed(run)
    this.#event(run, { kind: 'info', text: `starting ${entry.agent} ${entry.model}` })
    return new Promise((resolve) => {
      let errText = ''
      let stderr = ''
      let settled = false
      const done = (code) => {
        if (settled) return
        settled = true
        run.child = null
        const ok = code === 0 && !errText
        const error = errText.trim() || stderr.trim().split('\n').at(-1) || `exit code ${code}`
        resolve({ ok, limited: !ok && isLimitError(errText + stderr), error: ok ? '' : error.slice(0, 500) })
      }
      // detached: own process group, so kill() also stops the commands the agent started
      const env = { ...process.env, ...(def.env ? def.env(this.config) : {}) }
      // Headless opencode denies reads outside its working dir; hand it just the
      // folders the user approved so its read tool works there.
      if (entry.agent === 'opencode' && run.grants?.length) {
        const external_directory = {}
        for (const d of run.grants) { external_directory[d] = 'allow'; external_directory[d + '/**'] = 'allow' }
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { external_directory } })
      }
      const child = spawn(def.cmd, def.argv(prompt, entry.model, run.dir), { cwd: run.dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      run.child = child
      const parse = def.parser()
      createInterface({ input: child.stdout }).on('line', (line) => {
        let obj
        try { obj = JSON.parse(line) } catch { return }
        for (const ev of parse(obj)) {
          if (ev.session && !run.session) { run.session = ev.session; this.#changed(run) }
          if (ev.kind === 'meta') continue
          if (ev.kind === 'tool' && ev.text && RISKY.test(ev.text) && this.config.permissions?.mode !== 'off' && !run.approved && !run.pending) {
            run.pending = true
            this.#pauseForCommand(run, child, ev.text)
          }
          if (ev.kind === 'error') errText += ev.text + '\n'
          if ((ev.kind === 'text' || ev.kind === 'done') && ev.text) run.final = ev.text
          this.#event(run, ev)
        }
      })
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000) })
      child.on('error', (err) => { errText += err.message; done(-1) })
      child.on('close', done)
    })
  }

  #finish(run, status, error = '') {
    if (FINISHED.has(run.status)) return
    this.#denyPending(run)
    Object.assign(run, { status, error, endedAt: Date.now(), phase: '', permission: null })
    this.#write(run, { type: 'end', ...this.public(run) })
    this.#changed(run)
    if (run.parentId) this.#finishChildOf(run)
    this.#pump()
  }

  #event(run, ev) {
    const line = { type: 'event', t: Date.now(), agent: run.agent, model: run.model, kind: ev.kind, text: ev.text }
    this.#write(run, line)
    this.emit('event', { runId: run.id, ...line })
  }

  #changed(run) {
    this.emit('run', this.public(run))
  }

  #write(run, obj) {
    fs.appendFileSync(path.join(this.dir, `${run.id}.jsonl`), JSON.stringify(obj) + '\n')
  }

  #loadHistory() {
    for (const f of fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl'))) {
      const lines = this.events(f.slice(0, -6))
      const start = lines.find((l) => l.type === 'run')
      if (!start) continue
      const end = lines.findLast((l) => l.type === 'end')
      const { type, ...run } = end ?? { ...start, status: 'failed', error: 'interrupted (orch stopped while it ran)' }
      this.runs.set(run.id, { ...run, task: start.task })
    }
  }
}
