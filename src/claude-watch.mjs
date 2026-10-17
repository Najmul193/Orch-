import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

const LIMIT_RE = /hit your .*limit|usage limit/i
const ACTIVE_MS = 2 * 60_000
const RECENT_MS = 6 * 3600_000

export function limitText(d) {
  if (d.type !== 'assistant' || !d.isApiErrorMessage || d.isSidechain) return ''
  const text = (d.message?.content ?? []).map((b) => b.text ?? '').join(' ')
  return LIMIT_RE.test(text) ? text : ''
}

// Follows Claude Code transcripts (<dir>/<project>/<session>.jsonl) and tracks each session.
// Emits 'session' on every change and 'limit' once per session per reset window.
export class ClaudeWatch extends EventEmitter {
  constructor(dir) {
    super()
    this.dir = dir
    this.sessions = new Map()
    this.offsets = new Map()
    this.handled = new Set()
  }

  start() {
    if (!fs.existsSync(this.dir)) return this
    for (const rel of fs.readdirSync(this.dir, { recursive: true })) {
      const file = path.join(this.dir, rel)
      if (!this.#isTranscript(rel)) continue
      const { size, mtimeMs } = fs.statSync(file)
      // Replay the end of recently used transcripts so the dashboard has state, without acting on old limit hits.
      this.offsets.set(file, Date.now() - mtimeMs < RECENT_MS ? Math.max(0, size - 64 * 1024) : size)
      if (Date.now() - mtimeMs < RECENT_MS) this.#read(file, true)
    }
    this.watcher = fs.watch(this.dir, { recursive: true }, (_ev, rel) => {
      if (rel && this.#isTranscript(rel)) this.#read(path.join(this.dir, rel), false)
    })
    return this
  }

  stop() { this.watcher?.close() }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity).map((s) => this.#public(s))
  }

  #public(s) {
    const status = s.limited ? 'limited' : Date.now() - s.lastActivity < ACTIVE_MS ? 'active' : 'idle'
    return { ...s, status }
  }

  // Only top-level session files; subagent transcripts live deeper.
  #isTranscript(rel) {
    return rel.endsWith('.jsonl') && rel.split(path.sep).length === 2
  }

  #read(file, replay) {
    let size
    try { size = fs.statSync(file).size } catch { return }
    let offset = this.offsets.get(file) ?? 0
    if (size < offset) offset = 0
    if (size === offset) return
    const buf = Buffer.alloc(size - offset)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, buf, 0, buf.length, offset) } finally { fs.closeSync(fd) }
    const text = buf.toString('utf8')
    const end = text.lastIndexOf('\n') + 1 // keep a half-written last line for next time
    this.offsets.set(file, offset + Buffer.byteLength(text.slice(0, end)))
    for (const line of text.slice(0, end).split('\n')) {
      let d
      try { d = JSON.parse(line) } catch { continue }
      this.#apply(file, d, replay)
    }
  }

  #apply(file, d, replay) {
    if (d.isSidechain || !d.timestamp || !d.type) return
    const id = path.basename(file, '.jsonl')
    const s = this.sessions.get(id) ?? { id, file, project: path.basename(path.dirname(file)), cwd: '', lastActivity: 0, lastTool: '', limited: false, limitText: '' }
    this.sessions.set(id, s)
    if (d.cwd) s.cwd = d.cwd
    s.lastActivity = Math.max(s.lastActivity, Date.parse(d.timestamp) || 0)
    const limit = limitText(d)
    if (limit) {
      s.limited = true
      s.limitText = limit
      const key = `${id}|${limit}|${d.timestamp.slice(0, 10)}`
      if (!replay && !this.handled.has(key)) {
        this.handled.add(key)
        this.emit('limit', this.#public(s))
      }
    } else if (d.type === 'assistant' && !d.isApiErrorMessage) {
      s.limited = false
      for (const b of d.message?.content ?? []) {
        if (b.type === 'tool_use') s.lastTool = `${b.name}: ${String(b.input?.command ?? b.input?.file_path ?? b.input?.description ?? '').slice(0, 120)}`
      }
    }
    this.emit('session', this.#public(s))
  }
}
