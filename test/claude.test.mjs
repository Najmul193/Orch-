import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { buildHandoffPrompt, readTranscript } from '../src/handoff.mjs'
import { ClaudeWatch, limitText } from '../src/claude-watch.mjs'

const fixture = new URL('fixtures/claude-session.jsonl', import.meta.url).pathname
const lines = readTranscript(fixture)

test('limitText matches the real limit message only', () => {
  const hits = lines.filter((d) => limitText(d))
  assert.equal(hits.length, 1)
  assert.match(limitText(hits[0]), /resets 4pm/)
})

test('handoff prompt has the goal, recent turns and edited files, and nothing private or noisy', () => {
  const { goal, prompt } = buildHandoffPrompt(lines, '/tmp/demo-app')
  assert.equal(goal, 'Add input validation to the signup form and write tests for it.')
  assert.match(prompt, /usage limit while working in \/tmp\/demo-app/)
  assert.match(prompt, /reject passwords shorter than 8/)
  assert.match(prompt, /- \/tmp\/demo-app\/src\/signup\.js/)
  assert.match(prompt, /- \/tmp\/demo-app\/test\/signup\.test\.js/)
  for (const leak of ['SECRET-REMINDER-TEXT', 'META-CONTEXT-TEXT', 'TOOL-RESULT-TEXT', 'SIDECHAIN-TEXT', "You've hit"]) {
    assert.ok(!prompt.includes(leak), leak)
  }
})

test('handoff prompt stays under the size cap', () => {
  const big = Array.from({ length: 40 }, (_, i) => ({ type: 'user', origin: { kind: 'human' }, message: { content: `msg ${i} ` + 'x'.repeat(3000) } }))
  const { prompt } = buildHandoffPrompt(big, '/tmp')
  assert.ok(prompt.length <= 8000, String(prompt.length))
  assert.match(prompt, /msg 39/)
})

test('watcher fires once for a new limit hit, never for old ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-claude-'))
  fs.mkdirSync(path.join(dir, 'proj'))
  const file = path.join(dir, 'proj', 'sess-1.jsonl')
  fs.writeFileSync(file, fs.readFileSync(fixture)) // already contains a limit hit
  const watch = new ClaudeWatch(dir).start()
  const limits = []
  watch.on('limit', (s) => limits.push(s))
  try {
    assert.equal(watch.list()[0].status, 'limited')
    assert.equal(watch.list()[0].cwd, '/tmp/demo-app')

    const hit = { type: 'assistant', isApiErrorMessage: true, sessionId: 'sess-1', cwd: '/tmp/demo-app', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets 6am" }] } }
    fs.appendFileSync(file, JSON.stringify(hit) + '\n')
    await once(watch, 'limit')
    fs.appendFileSync(file, JSON.stringify(hit) + '\n') // same hit again: no second handoff
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(limits.length, 1)
    assert.match(limits[0].limitText, /weekly limit/)
  } finally {
    watch.stop()
  }
})
