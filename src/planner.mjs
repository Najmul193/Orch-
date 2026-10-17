import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { agents } from './agents.mjs'
import { classify } from './classify.mjs'
import { rankFree } from './pool.mjs'

// Pick the model that best suits this task. Local model first for simple,
// self-contained, non-file work; otherwise the best free model for the tag.
// Pure and sync: no I/O, never throws. Returns { tag, pick, order, local }.
const FILE_WORK = /\b(file|files|folder|directory|path|repo|repository|code|script|bug|fix|edit|write|create|delete|rename|refactor|implement|install|run|command|commit|git|test|api|server|css|html|component|function|class|database|query|build|deploy|config)\b/i
const DEEP = /\b(research|investigate|compare|comparison|analy[sz]e|evaluate|survey|benchmark|break down|step[- ]by[- ]step|multiple|several|each|pros and cons|report|strategy|roadmap|plan out|in depth|detailed|comprehensive|overview|then|also)\b/i

// Only short, self-contained, non-file work belongs on the local model.
export function isLocalFriendly(task, tag) {
  const text = String(task)
  if (text.length > 240) return false
  if (FILE_WORK.test(text)) return false
  if (tag === 'research' || tag === 'data') return false // these get split and distributed
  if (isComplex(task, tag)) return false
  return tag === 'docs' || tag === 'general'
}

// Is this task big enough to be worth splitting across several agents at once?
export function isComplex(task, tag) {
  const t = String(task)
  if (t.length > 280) return true
  if (/(^|\n)\s*(\d+[.)]|[-*])\s+\S/.test(t)) return true // a list of items asked for at once
  if (tag === 'research' || tag === 'data') return t.length > 25
  if (DEEP.test(t) && t.length > 70) return true
  if ((t.match(/\band\b/gi) || []).length >= 2 && t.length > 120) return true
  return false
}

export function route(task, config = {}, pool = {}) {
  const { tag } = classify(task)
  const complex = isComplex(task, tag)
  const local = config.local
  if (local?.enabled && local.model && isLocalFriendly(task, tag)) {
    return { tag, complex: false, pick: { agent: 'local', model: local.model }, order: [], local: true }
  }
  const routing = config.routing || {}
  const wanted = routing[tag] || routing.general || []
  const order = rankFree(pool.free || [], wanted)
  return { tag, complex, pick: order[0] ? { agent: 'opencode', model: order[0] } : null, order, local: false }
}

// When the planner model is unavailable but the task is clearly big, split it into
// a few independent angles anyway so the work still runs in parallel.
export function fallbackSplit(task, tag) {
  if (!['research', 'data', 'general'].includes(tag)) return []
  if (!isComplex(task, tag)) return []
  const t = String(task).trim()
  return [
    { title: 'Facts & figures', prompt: `Collect the latest concrete facts, numbers and named sources about this task. Be specific and cite where each fact comes from. Task: ${t}` },
    { title: 'Drivers, risks & views', prompt: `Lay out the key drivers, risks and competing viewpoints for this task. Give the strongest argument on each side. Task: ${t}` },
    { title: 'Implications & next steps', prompt: `Explain the practical implications and what to watch or do next for this task. Task: ${t}` },
  ]
}

// Ask a model to break a task into independent pieces so several agents can work at
// once. Uses the local model when enabled (fast, free). Best-effort: any failure,
// timeout, or a single-piece answer just returns [] and the task runs as one agent.
export async function split(task, { model, dir, config } = {}) {
  const useLocal = config?.local?.enabled && config.local.model
  const agent = useLocal ? 'local' : 'opencode'
  const plannerModel = useLocal ? config.local.model : (model || config?.plannerModel || 'opencode/glm-5.3-flash-free')
  // A small local model can be slow to answer; don't let it stall the whole run —
  // time out sooner and let fallbackSplit take over.
  const timeoutMs = config?.plannerTimeoutMs || (useLocal ? 25_000 : 45_000)
  const text = await runOnce(splitPrompt(task), plannerModel, dir, agent, config, timeoutMs).catch(() => '')
  return parseSplit(text)
}

function splitPrompt(task) {
  return [
    'You split work for parallel AI agents. Return ONLY a JSON array, no prose, no code fences.',
    'Each element is {"title": "short label", "prompt": "a self-contained instruction an agent can finish alone (name files, constraints, how to know it is done)"}.',
    'Rules:',
    '- If the task is ONE connected piece that must happen in order, return an array of exactly ONE element.',
    '- If it contains 2-3 genuinely independent parts that do not depend on each other, return one element per part.',
    '- Never invent work that was not asked for. Keep every element clearly traceable to the task.',
    '',
    'Task:',
    task,
  ].join('\n')
}

function parseSplit(text) {
  if (!text) return []
  const clean = String(text).replace(/```(?:json)?/gi, '')
  const s = clean.indexOf('[')
  const e = clean.lastIndexOf(']')
  if (s === -1 || e <= s) return []
  let arr
  try { arr = JSON.parse(clean.slice(s, e + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []
  const out = []
  const seen = new Set()
  for (const item of arr) {
    const prompt = (typeof item === 'string' ? item : item?.prompt ?? item?.task ?? '').trim()
    const title = (typeof item === 'object' ? (item?.title ?? item?.name ?? '') : '').trim() || prompt.slice(0, 80)
    if (prompt.length < 12) continue
    const key = prompt.toLowerCase().replace(/\s+/g, ' ').slice(0, 60)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ title, prompt })
    if (out.length >= 4) break
  }
  return out
}

// One-shot model call: run `prompt` on `agent`/`model` and return the final text.
function runOnce(prompt, model, dir, agent = 'opencode', config = {}, timeoutMs = 45_000) {
  const def = agents[agent] || agents.opencode
  return new Promise((resolve, reject) => {
    const env = def.env ? { ...process.env, ...def.env(config) } : process.env
    const child = spawn(def.cmd, def.argv(prompt, model, dir), { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; reject(new Error('planner timeout')) }, timeoutMs)
    createInterface({ input: child.stdout }).on('line', (line) => {
      let d
      try { d = JSON.parse(line) } catch { return }
      for (const ev of def.parser()(d)) if (ev.text && (ev.kind === 'text' || ev.kind === 'done')) out = ev.text
    })
    child.stderr.on('data', (b) => { err = (err + b).slice(-2000) })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && out) resolve(out)
      else reject(new Error(err.trim() || `planner exit ${code}`))
    })
  })
}
