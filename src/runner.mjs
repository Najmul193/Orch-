import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { agents, isLimitError } from './agents.mjs'
import { route, split } from './planner.mjs'

const RETRY_NOTE = '\n\nNote: a previous attempt at this task may have left partial changes. Check `git status`/`git diff` first and continue from there.'
const FINISHED = new Set(['done', 'failed', 'killed'])

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
      if (r.pick) {
        run.want = { ...r.pick }
        run.plan = { tag: r.tag, agent: r.pick.agent, model: r.pick.model, local: r.local }
        this.#event(run, { kind: 'info', text: `routed ${r.tag} -> ${r.local ? 'local ' : ''}${r.pick.model}` })
      }
    }
    this.#changed(run)
    if (this.config.fanout === true) this.#fan(run)
    else this.#enqueue(run)
    return run
  }

  #enqueue(run) {
    this.queue.push(run)
    this.#changed(run)
    this.#pump()
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
    run.plan = { ...(run.plan || {}), subtasks: subtasks.map((s) => s.title) }
    this.#event(run, { kind: 'info', text: `fan-out: ${subtasks.length} parallel subtasks` })
    this.#changed(run)
    run.children = subtasks.map((s) => this.#child(run, s))
    for (const cid of run.children) this.queue.push(this.runs.get(cid))
    this.#changed(run)
    this.#pump()
  }

  #child(run, sub) {
    const id = `${Date.now()}-${randomBytes(2).toString('hex')}`
    const child = {
      id, task: sub.prompt, dir: run.dir, chain: run.chain, source: run.source,
      agent: null, model: null, session: null, title: sub.title,
      status: 'queued', phase: '', final: '', error: '', attempts: [],
      createdAt: Date.now(), startedAt: null, endedAt: null,
      want: { ...run.want }, plan: null, parentId: run.id, children: [],
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
    this.#finish(run, 'killed', 'stopped by user') // parent first, so children don't re-finish it
    for (const k of kids) this.#finish(k, 'killed', 'stopped by user')
    for (const t of targets) {
      const ch = t.child
      if (ch) { try { process.kill(-ch.pid, 'SIGTERM') } catch { try { ch.kill('SIGTERM') } catch {} } }
    }
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
      const env = def.env ? { ...process.env, ...def.env(this.config) } : process.env
      const child = spawn(def.cmd, def.argv(prompt, entry.model, run.dir), { cwd: run.dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      run.child = child
      const parse = def.parser()
      createInterface({ input: child.stdout }).on('line', (line) => {
        let obj
        try { obj = JSON.parse(line) } catch { return }
        for (const ev of parse(obj)) {
          if (ev.session && !run.session) { run.session = ev.session; this.#changed(run) }
          if (ev.kind === 'meta') continue
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
    Object.assign(run, { status, error, endedAt: Date.now(), phase: '' })
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
