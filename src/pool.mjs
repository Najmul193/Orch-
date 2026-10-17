import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { agents } from './agents.mjs'

const exec = promisify(execFile)
const isFree = (m) => /-free$/.test(m.split('/').pop())
const short = (m) => m.replace(/^opencode\//, '')

// One list of CLI-provided models for an agent, or [] if the CLI is missing/slow.
export async function discoverModels(agent, timeout = 20_000) {
  const def = agents[agent]
  if (!def?.models) return []
  try {
    const { stdout } = await exec(def.cmd, def.models.argv, { timeout, maxBuffer: 8e6 })
    return def.models.parse(stdout)
  } catch {
    return []
  }
}

// Both agents' models, split into opencode free models (the pool we prefer to use)
// and agy models (the fallback tier). Kept as one call so the flow can show them.
export async function discoverPool() {
  const [oc, agy] = await Promise.all([discoverModels('opencode'), discoverModels('agy')])
  return {
    free: oc.filter(isFree),
    agy,
    all: [...oc, ...agy],
  }
}

// Order free models by the configured preference, then whatever else showed up.
// `prefer` is a list of short names (no "opencode/" prefix).
export function rankFree(models, prefer = []) {
  const pos = (m) => {
    const i = prefer.findIndex((p) => m.includes(p))
    return i === -1 ? prefer.length + 1 : i
  }
  return [...models].sort((a, b) => pos(a) - pos(b))
}

// Rebuild the delegate chain from discovered free models: the best `limit` free
// opencode models first, then agy as the last resort tier. Returns the new chain.
export function buildChain(pool, { prefer = [], limit = 6, agent = 'opencode', fallbacks = [] } = {}) {
  const free = rankFree(pool.free, prefer).slice(0, limit).map((m) => ({ agent, model: m, enabled: true }))
  const agy = pool.agy.map((m) => ({ agent: 'agy', model: m, enabled: true }))
  const chain = [...free, ...agy, ...fallbacks]
  // drop duplicates by model id, keeping the first (highest-ranked) slot
  const seen = new Set()
  return chain.filter((e) => (seen.has(e.model) ? false : (seen.add(e.model), true)))
}
