# orch

Lets Claude Code hand small tasks to free agents (opencode, Antigravity `agy`). When Claude hits its usage limit, the work continues on the next free agent automatically. A live dashboard shows which agent is doing what.

```bash
npm link                 # puts `orch` on your PATH (no dependencies, Node 22+)
./start.sh               # dashboard + runner in the background on http://127.0.0.1:7777 (log: data/orch.log)
./stop.sh                # stops orch and any agents it is running
orch serve               # same as start.sh, but in the foreground
orch delegate --dir /abs/project "add docstrings to src/util.js"   # what Claude runs
orch delegate "explain what this repo does"                        # --dir optional: uses config.json → defaultDir (~/clt)
npm test
```

- **Delegation:** Claude uses `orch delegate` through the `opencode-delegate` skill. `~/.claude/skills/opencode-delegate` is a symlink to `skill/`.
- **Fallback:** each task tries the models in `config.json` → `chains.delegate` in order. A model that is rate limited sits out for `cooldownMinutes`.
- **Claude limit handoff:** orch watches `~/.claude/projects/*/*.jsonl` for "You've hit your … limit". It then hands that session's goal, recent turns and edited files to `chains.handoff` in the session's folder. You can turn this off with "Auto-handoff" in the dashboard.
- **Run history:** runs are saved in `data/runs/<id>.jsonl`. The dashboard shows the command to keep talking to any agent in a terminal.
- **Permissions:** agents run with edits and shell commands allowed and no prompts (`agy --dangerously-skip-permissions`). Only delegate in folders you're happy for them to change.
# Orch-
