#!/usr/bin/env node
// Local-model adapter: runs a prompt on an Ollama (OpenAI-compatible) endpoint and
// prints orch events as JSON lines. Text-only — it cannot edit files, so orch only
// routes self-contained, non-file tasks here. Usage: local-agent.mjs <model> <dir> <task>
import http from 'node:http'
import https from 'node:https'

const [, , model, dir, ...rest] = process.argv
const task = rest.join(' ')
const base = process.env.ORCH_OLLAMA_URL || 'http://127.0.0.1:11434/v1/chat/completions'
const timeoutMs = Number(process.env.ORCH_LOCAL_TIMEOUT_MS || 300000)

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const fail = (msg) => { emit({ type: 'error', error: msg }); process.exit(1) }

if (!model || !task) fail('usage: local-agent.mjs <model> <dir> <task>')

const body = JSON.stringify({
  model,
  stream: true,
  messages: [
    { role: 'system', content: `You are a fast local assistant. Answer directly and concisely. Working directory (read-only for you): ${dir}. You cannot run commands or edit files.` },
    { role: 'user', content: task },
  ],
})

const url = new URL(base)
const mod = url.protocol === 'https:' ? https : http
const req = mod.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
  if (res.statusCode >= 400) { let e = ''; res.on('data', (c) => (e += c)); res.on('end', () => fail(`local model HTTP ${res.statusCode}: ${e.slice(0, 300)}`)); return }
  let buf = ''
  let full = ''
  res.on('data', (chunk) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const data = s.slice(5).trim()
      if (data === '[DONE]') continue
      let d
      try { d = JSON.parse(data) } catch { continue }
      const delta = d.choices?.[0]?.delta?.content
      if (delta) full += delta
    }
  })
  res.on('end', () => {
    if (!full.trim()) return fail('local model returned no text')
    emit({ type: 'text', text: full })
    emit({ type: 'done', text: full })
    process.exit(0)
  })
})
req.on('error', (e) => fail(`local model unreachable at ${base}: ${e.message}`))
req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')) })
req.write(body)
req.end()
