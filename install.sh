#!/bin/bash
set -euo pipefail

echo "=== Claude Session Monitor - Install ==="

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_DIR="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"

# 1. Hook 스크립트 설치
echo "1. Hook 스크립트 설치..."
mkdir -p "$HOOK_DIR"
cp "$REPO_DIR/hooks/session-monitor.sh" "$HOOK_DIR/session-monitor.sh"
chmod +x "$HOOK_DIR/session-monitor.sh"
echo "   ✅ $HOOK_DIR/session-monitor.sh"

# 2. VSCode 확장 빌드 + 설치
echo "2. VSCode 확장 빌드..."
cd "$REPO_DIR"
npm install --silent 2>/dev/null
npx tsc -p ./ 2>/dev/null

if command -v vsce &>/dev/null; then
  vsce package --allow-missing-repository 2>/dev/null
else
  npx --yes @vscode/vsce package --allow-missing-repository 2>/dev/null
fi

VSIX=$(ls -t *.vsix 2>/dev/null | head -1)
if [ -n "$VSIX" ]; then
  code --install-extension "$VSIX" --force 2>/dev/null
  echo "   ✅ VSCode 확장 설치 완료"
else
  echo "   ❌ VSIX 빌드 실패"
  exit 1
fi

# 3. Hook 설정 안내
echo ""
echo "3. ~/.claude/settings.json에 hook 추가가 필요합니다."
echo "   아래 내용을 hooks 섹션에 추가하세요:"
echo ""
cat <<'HOOKS'
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/session-monitor.sh working"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/session-monitor.sh done"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/session-monitor.sh blocked"
          }
        ]
      },
      {
        "matcher": "idle_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/session-monitor.sh waiting"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/session-monitor.sh working"
          }
        ]
      }
    ]
HOOKS
echo ""
echo "=== 설치 완료! VSCode를 Reload하세요. ==="
