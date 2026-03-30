# Claude Session Monitor

VSCode extension to monitor multiple Claude Code CLI sessions at a glance.

## Features

- **TreeView** in Source Control sidebar — sessions grouped by worktree
- **StatusBar** summary — working/attention count with yellow highlight
- **Click to jump** — click a session to focus its terminal
- **State tracking** — working, done, waiting for input, permission blocked
- **Last prompt** — shows your last message for each session
- **Acknowledged state** — click to dim, re-highlights on state change

## States

| Icon | State | Color | Description |
|------|-------|-------|-------------|
| `$(sync~spin)` | working | — | Claude is processing |
| `$(check)` | done | yellow | Task completed |
| `$(bell)` | waiting | yellow | Waiting for your input |
| `$(shield)` | blocked | red | Permission approval needed |

## Install

```bash
git clone https://github.com/strawji02/claude-session-monitor.git
cd claude-session-monitor
./install.sh
```

Then add the hook entries to `~/.claude/settings.json` (the install script will show you what to add).

## How it works

1. Claude Code hooks write session state to `~/.claude/session-monitor/*.json`
2. VSCode extension watches that directory
3. TreeView + StatusBar update in real-time
4. Terminal matching via process tree (termPid)

## Test

```bash
bash hooks/session-monitor.test.sh
```

## Requirements

- VSCode 1.93+
- Claude Code CLI with hooks support
