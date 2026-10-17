---
name: opencode-delegate
description: Hand small, well-defined coding chores to free agents (opencode, Antigravity) through orch, while Claude keeps the complex work. Use when the user asks to delegate, offload or "send to opencode/antigravity", or when a task splits into independent mechanical pieces (boilerplate, renames, docstrings, simple tests, small scripts, file summaries) that don't need Claude's judgment.
---

# Delegating small tasks with orch

`orch` (source: `/Users/rivan/orchastration`) runs tasks on free agents: opencode free models
and Antigravity (`agy`). It picks the first available model from its delegate chain and
automatically falls back to the next one when a model is rate limited or fails. Every run shows
live on the dashboard at http://127.0.0.1:7777.

The agents edit files **and run shell commands** in the folder you give them, without any
permission prompts. So you stay responsible for everything they change.

## What to delegate

Delegate: boilerplate, repetitive edits across files, renames, docstrings/comments,
unit tests for an existing, clear function, small standalone scripts, format
conversions, summarizing a file or log.

Keep for yourself: design and architecture, debugging non-obvious bugs, anything
security-sensitive, anything touching secrets or credentials, final review of
the delegated work, and anything where a wrong answer is costly or hard to spot.

## How to delegate

```bash
orch delegate --dir <absolute project path> "<self-contained task>"
```

- If `orch` is not on PATH, use `node /Users/rivan/orchastration/bin/orch.mjs delegate ...`.
- It starts the orch server if it isn't running, prints the agent's actions while it works,
  then its final message. Exit code 0 means done, 1 means every agent failed.
- Write the task so it stands alone: the agent can't see this conversation. Name exact
  files, the change you want, constraints (style, don't touch X) and how to know it's done.
- One `orch delegate` per independent task. For several at once, run them with
  `run_in_background` and keep working on the complex part meanwhile. Never give two runs
  the same files.
- Always pass `--dir` with a project directory, never the home directory itself.
- Optional: `--agent agy` to prefer Antigravity, or `--model <id>` for one model
  (e.g. `--model claude-sonnet-4-6` for a harder chore). The chain still backs it up.
- Free models may keep prompts for training, so don't send private or confidential code
  to them; do that work yourself.

## After it finishes

1. Check what changed: `git -C <dir> diff` (or read the touched files if there's no git).
2. Check it: run the tests/linter, or read the change closely.
3. Fix small issues yourself; if it's badly wrong, do the task yourself instead of
   retrying again and again.
4. Tell the user which parts were delegated (and to which model), so they know where the work came from.
