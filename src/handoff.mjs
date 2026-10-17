import fs from 'node:fs'

const MAX_PROMPT = 8000
const WRAPPERS = /<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics)>[\s\S]*?<\/\1>/g
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const cut = (s, n) => (s.length > n ? s.slice(0, n) + ' …[cut]' : s)

// Text a person actually typed, or '' for tool results, meta lines, slash-command echoes.
export function humanText(d) {
  if (d.type !== 'user' || d.isMeta || d.isSidechain) return ''
  if (d.origin && d.origin.kind !== 'human') return ''
  const c = d.message?.content
  const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : ''
  const text = raw.replace(WRAPPERS, '').trim()
  return /^<(command-|local-command)|^\[Request interrupted/.test(text) ? '' : text
}

export function buildHandoffPrompt(lines, cwd) {
  let goal = ''
  const turns = []
  const edited = new Set()
  for (const d of lines) {
    if (d.isSidechain) continue
    const human = humanText(d)
    if (human) {
      goal ||= human
      turns.push(`User: ${cut(human, 1500)}`)
      continue
    }
    if (d.type !== 'assistant' || d.isApiErrorMessage || !Array.isArray(d.message?.content)) continue
    for (const b of d.message.content) {
      if (b.type === 'text' && b.text.trim()) turns.push(`Claude: ${cut(b.text.trim(), 1500)}`)
      if (b.type === 'tool_use' && EDIT_TOOLS.has(b.name)) edited.add(b.input?.file_path ?? b.input?.notebook_path)
    }
  }
  edited.delete(undefined)

  const head = `Claude Code hit its usage limit while working in ${cwd}. You are taking over. Continue the task from where it stopped.\n\n## Original request\n${cut(goal || '(not found in transcript)', 2500)}\n`
  const files = edited.size ? `\n## Files Claude edited\n${[...edited].map((f) => `- ${f}`).join('\n')}\n` : ''
  const tail = '\n## What to do\n1. If this is a git repo, run `git status` and `git diff` to see the current state.\n2. Continue the unfinished work. Do not redo finished parts.\n3. End with a short summary of what you did and what is left.\n'
  const recent = turns.slice(-10)
  const convo = () => `\n## Recent conversation (oldest first)\n${recent.join('\n\n')}\n`
  while (recent.length > 1 && (head + convo() + files + tail).length > MAX_PROMPT) recent.shift()
  return { goal, prompt: head + convo() + files + tail }
}

// Transcripts can be huge: read the start (for the goal) and the end (for recent turns).
export function readTranscript(file, headBytes = 512 * 1024, tailBytes = 2 * 1024 * 1024) {
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  try {
    const read = (start, len) => {
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      return buf.toString('utf8')
    }
    const text = size <= headBytes + tailBytes ? read(0, size) : read(0, headBytes) + '\n' + read(size - tailBytes, tailBytes)
    return text.split('\n').flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  } finally {
    fs.closeSync(fd)
  }
}
