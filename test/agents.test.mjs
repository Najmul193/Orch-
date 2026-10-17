import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { agents, isLimitError, isTransientError } from '../src/agents.mjs'

const parseFixture = (agent, file) => {
  const parse = agents[agent].parser()
  return fs.readFileSync(new URL(`fixtures/${file}`, import.meta.url), 'utf8').split('\n').filter(Boolean).flatMap((l) => parse(JSON.parse(l)))
}

test('opencode: tools, final text and session from a real run', () => {
  const evs = parseFixture('opencode', 'opencode.jsonl')
  const tools = evs.filter((e) => e.kind === 'tool').map((e) => e.text)
  assert.match(tools[0], /^write: .*hello\.txt$/)
  assert.equal(tools[1], 'bash: ls')
  assert.match(evs.findLast((e) => e.kind === 'text').text, /hello\.txt/)
  assert.equal(evs[0].session, 'ses_eb7870811ffenPdRxjCjJ2T9XF')
  assert.ok(!evs.some((e) => e.kind === 'error'))
})

test('opencode: error event', () => {
  const evs = parseFixture('opencode', 'opencode-error.jsonl')
  assert.deepEqual(evs.map((e) => e.kind), ['error'])
})

test('opencode: a failed tool is a warn, not a fatal error', () => {
  const parse = agents.opencode.parser()
  const evs = parse({ type: 'tool_use', part: { tool: 'webfetch', state: { status: 'error', error: 'StatusCode: non 2xx status code (403 GET https://example.com/x)', input: {} } } })
  assert.equal(evs[0].kind, 'warn')
  assert.match(evs[0].text, /webfetch failed: .*403/)
})

test('agy: tools, streamed text and final result from a real run', () => {
  const evs = parseFixture('agy', 'agy.jsonl')
  assert.equal(evs[0].session, '5a60a89a-7316-4548-96ce-89de05c06ade')
  assert.deepEqual(evs.filter((e) => e.kind === 'tool').map((e) => e.text.split(':')[0]), ['write_to_file', 'run_command'])
  assert.equal(evs.find((e) => e.text?.startsWith('run_command')).text, 'run_command: ls')
  const text = evs.filter((e) => e.kind === 'text')
  assert.equal(text.length, 1)
  assert.equal(evs.at(-1).kind, 'done')
  assert.equal(text[0].text, evs.at(-1).text)
})

test('agy: error result', () => {
  const evs = parseFixture('agy', 'agy-error.jsonl')
  assert.equal(evs.at(-1).kind, 'error')
  assert.match(evs.at(-1).text, /not recognized/)
})

test('model lists parse from real CLI output', () => {
  assert.deepEqual(agents.opencode.models.parse('opencode/cat-jam-free\nopencode/deepseek-v4.1-flash-free\n\nsome banner text\n'), ['opencode/cat-jam-free', 'opencode/deepseek-v4.1-flash-free'])
  assert.deepEqual(agents.agy.models.parse('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n'), ['gemini-3.8-flash-high', 'claude-sonnet-4-6'])
})

test('isLimitError', () => {
  for (const s of ['HTTP 429', 'Rate limit reached for model', 'rate_limited', 'You exceeded your current quota', 'RESOURCE_EXHAUSTED', "You've hit your session limit · resets 4pm"]) {
    assert.ok(isLimitError(s), s)
  }
  for (const s of ['model crashed', 'invalid model selection', 'exit code 1']) assert.ok(!isLimitError(s), s)
})

test('isTransientError spots provider outages, not real failures', () => {
  for (const s of [
    'Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded',
    '{"message":"...","type":"server_error"}',
    'HTTP 502 Bad Gateway',
    '503 Service Unavailable',
  ]) assert.ok(isTransientError(s), s)
  for (const s of ['model crashed', 'HTTP 429 rate limit', 'invalid model selection', 'exit code 1']) assert.ok(!isTransientError(s), s)
})
