#!/bin/bash
# Claude Code hook → session-monitor 상태 파일 기록
STATE="${1:-working}"
STATE_DIR="${SESSION_MONITOR_DIR:-$HOME/.claude/session-monitor}"
mkdir -p "$STATE_DIR"

CLAUDE_PID="${PPID}"
TERM_PID=$(ps -o ppid= -p "$CLAUDE_PID" 2>/dev/null | tr -d ' ')
CWD="${PWD}"
WORKTREE="$(basename "$CWD")"
BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null || echo "")
TIMESTAMP="$(date +%s)000"
STATE_FILE="${STATE_DIR}/${CLAUDE_PID}.json"

# stdin 읽기
STDIN_DATA=""
if [ ! -t 0 ]; then
  STDIN_DATA=$(cat)
fi

# 이전 메시지 보존
PREV_MESSAGE=""
if [ -f "$STATE_FILE" ]; then
  PREV_MESSAGE=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('message', ''))" 2>/dev/null || echo "")
fi

# 메시지 결정: working일 때만 새 메시지, 나머지는 이전 메시지 유지
MESSAGE="$PREV_MESSAGE"
if [ -n "$STDIN_DATA" ] && [ "$STATE" = "working" ]; then
  NEW_MSG=$(echo "$STDIN_DATA" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    msg = d.get('user_prompt', d.get('prompt', ''))
    print(msg[:80])
except: pass
" 2>/dev/null)
  if [ -n "$NEW_MSG" ]; then
    MESSAGE="$NEW_MSG"
  fi
fi

if [ -n "$BRANCH" ] && [ "$BRANCH" != "$WORKTREE" ]; then
  LABEL="${BRANCH}"
else
  LABEL="${WORKTREE}"
fi

MESSAGE_ESCAPED=$(echo "$MESSAGE" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null || echo '""')

cat > "$STATE_FILE" <<EOF
{
  "pid": "${CLAUDE_PID}",
  "termPid": "${TERM_PID}",
  "state": "${STATE}",
  "cwd": "${CWD}",
  "worktree": "${WORKTREE}",
  "branch": "${BRANCH}",
  "label": "${LABEL}",
  "message": ${MESSAGE_ESCAPED},
  "timestamp": ${TIMESTAMP}
}
EOF
