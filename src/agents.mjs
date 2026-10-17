// One adapter per agent CLI. parser() returns a per-run function that turns one JSON
// line from the CLI into zero or more common events: {kind, text, session?}.
// kind: text (agent message) | tool (what it is doing) | error | done (final answer)

const short = (s, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s)

const LOCAL_SHIM = new URL('../bin/local-agent.mjs', import.meta.url).pathname

export const agents = {
  opencode: {
    cmd: 'opencode',
    argv: (task, model, dir) => ['run', '--format', 'json', '--dir', dir, '-m', model, task],
    resume: (session, dir) => `cd ${dir} && opencode -s ${session}`,
    models: { argv: ['models'], parse: (out) => out.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)) },
    parser: () => (d) => {
      const session = d.sessionID
      if (d.type === 'text' && d.part?.text) return [{ kind: 'text', text: d.part.text, session }]
      if (d.type === 'tool_use') {
        const { tool, state = {} } = d.part
        const what = state.input?.command ?? state.input?.filePath ?? state.title ?? ''
        // A tool that errored (a 403 fetch, a bad path) is a normal hiccup the model can
        // work around — surface it as a warning, never as a run-ending error.
        if (state.status === 'error') return [{ kind: 'warn', text: `${tool} failed: ${short(String(state.error ?? what))}`, session }]
        return [{ kind: 'tool', text: `${tool}: ${short(String(what))}`, session }]
      }
      if (d.type === 'error') return [{ kind: 'error', text: d.error?.data?.message ?? d.error?.name ?? 'error', session }]
      return session ? [{ kind: 'meta', session }] : []
    },
  },

  agy: {
    cmd: 'agy',
    // -p takes the prompt as its value, so it must come last.
    argv: (task, model, dir) => ['--output-format', 'stream-json', '--model', model, '--dangerously-skip-permissions', '--add-dir', dir, '-p', task],
    resume: (session, dir) => `cd ${dir} && agy --conversation ${session}`,
    // lines look like "gemini-3.8-flash-high\tGemini 3.8 Flash (High)"
    models: { argv: ['models'], parse: (out) => out.split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t')[0].trim()).filter(Boolean) },
    parser: () => {
      const deltas = new Map() // step_index -> text so far
      return (d) => {
        if (d.event === 'init') return [{ kind: 'meta', session: d.conversation_id }]
        if (d.event === 'result') {
          const r = d.result
          return r.status === 'SUCCESS' ? [{ kind: 'done', text: r.response }] : [{ kind: 'error', text: r.error || r.status }]
        }
        const s = d.step_update
        if (!s) return []
        if (s.step_type === 'tool' && s.state === 'ACTIVE') {
          const what = Object.values(s.tool_info?.parameters ?? {})[0] ?? ''
          return [{ kind: 'tool', text: `${s.tool_name}: ${short(String(what))}` }]
        }
        if (s.step_type === 'agent_response') {
          const text = (deltas.get(s.step_index) ?? '') + (s.text_delta ?? '')
          deltas.set(s.step_index, text)
          if (s.state === 'DONE' && text.trim()) return [{ kind: 'text', text }]
        }
        return []
      }
    },
  },

  // Local Ollama model via bin/local-agent.mjs. Text-only: no file edits or shell.
  local: {
    cmd: process.execPath,
    argv: (task, model, dir) => [LOCAL_SHIM, model, dir, task],
    env: (config) => ({ ORCH_OLLAMA_URL: config?.local?.baseUrl || 'http://127.0.0.1:11434/v1/chat/completions' }),
    resume: (session, dir) => `cd ${dir} && ${process.execPath} ${LOCAL_SHIM} ${session}`,
    models: null,
    parser: () => (d) => {
      if (d.type === 'text' && d.text) return [{ kind: 'text', text: d.text }]
      if (d.type === 'done' && d.text) return [{ kind: 'done', text: d.text }]
      if (d.type === 'error') return [{ kind: 'error', text: d.error }]
      return []
    },
  },
}

export const isLimitError = (text) =>
  /\b429\b|rate.?limit|quota|usage limit|too many requests|resource.?exhausted|hit your .*limit/i.test(text)

// The provider itself is briefly down or overloaded (not our fault, and not a rate
// limit): worth another model, and worth benching this one for a short while.
export const isTransientError = (text) =>
  /\b5\d\d\b|server_error|upstream error|streaming response failed|temporarily overloaded|overloaded|service unavailable|bad gateway|gateway time-?out/i.test(text)
