#!/bin/bash
# session-monitor.sh 상태 전이 테스트
# Usage: bash session-monitor.test.sh

set -euo pipefail

SCRIPT="$HOME/.claude/hooks/session-monitor.sh"
TEST_DIR=$(mktemp -d)
export SESSION_MONITOR_DIR="$TEST_DIR"

PASS=0
FAIL=0

run_hook() {
  local state="$1"
  local stdin_data="${2:-}"
  if [ -n "$stdin_data" ]; then
    echo "$stdin_data" | bash "$SCRIPT" "$state"
  else
    bash "$SCRIPT" "$state"
  fi
}

# 가장 최근 json 파일의 필드 읽기
get_field() {
  local field="$1"
  local file
  file=$(ls -t "$TEST_DIR"/*.json 2>/dev/null | head -1)
  if [ -z "$file" ]; then
    echo "NO_FILE"
    return
  fi
  python3 -c "import json; print(json.load(open('$file')).get('$field', ''))" 2>/dev/null || echo ""
}

get_state() {
  get_field "state"
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local test_name="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✅ $test_name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $test_name (expected: '$expected', got: '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_empty() {
  local actual="$1"
  local test_name="$2"
  if [ -n "$actual" ] && [ "$actual" != "NO_FILE" ]; then
    echo "  ✅ $test_name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $test_name (expected non-empty, got: '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  session-monitor.sh 테스트"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# --- 1. 기본 상태 기록 ---
echo ""
echo "1. 기본 상태 기록"

run_hook "working"
assert_eq "working" "$(get_state)" "working 상태 기록"

run_hook "done"
assert_eq "done" "$(get_state)" "done 상태 기록"

run_hook "waiting"
assert_eq "waiting" "$(get_state)" "waiting 상태 기록"

run_hook "blocked"
assert_eq "blocked" "$(get_state)" "blocked 상태 기록"

# --- 2. 상태 전이 ---
echo ""
echo "2. 상태 전이"

run_hook "working"
assert_eq "working" "$(get_state)" "초기 working"

run_hook "blocked"
assert_eq "blocked" "$(get_state)" "working → blocked"

run_hook "working"
assert_eq "working" "$(get_state)" "blocked → working (권한 승인 후)"

run_hook "done"
assert_eq "done" "$(get_state)" "working → done"

# --- 3. 전체 플로우: 프롬프트 → 권한대기 → 승인 → 완료 ---
echo ""
echo "3. 전체 플로우"

run_hook "working"
assert_eq "working" "$(get_state)" "Step 1: 프롬프트 입력 → working"

run_hook "blocked"
assert_eq "blocked" "$(get_state)" "Step 2: 권한 필요 → blocked"

run_hook "working"
assert_eq "working" "$(get_state)" "Step 3: 권한 승인, PostToolUse → working"

run_hook "blocked"
assert_eq "blocked" "$(get_state)" "Step 4: 또 다른 권한 필요 → blocked"

run_hook "working"
assert_eq "working" "$(get_state)" "Step 5: 다시 승인 → working"

run_hook "done"
assert_eq "done" "$(get_state)" "Step 6: 응답 완료 → done"

run_hook "waiting"
assert_eq "waiting" "$(get_state)" "Step 7: 입력 대기 → waiting"

run_hook "working"
assert_eq "working" "$(get_state)" "Step 8: 새 프롬프트 → working"

# --- 4. JSON 필드 검증 ---
echo ""
echo "4. JSON 필드 검증"

run_hook "working"
assert_not_empty "$(get_field 'pid')" "pid 필드 존재"
assert_not_empty "$(get_field 'termPid')" "termPid 필드 존재"
assert_not_empty "$(get_field 'cwd')" "cwd 필드 존재"
assert_not_empty "$(get_field 'worktree')" "worktree 필드 존재"
assert_not_empty "$(get_field 'timestamp')" "timestamp 필드 존재"

# JSON 유효성
FILE=$(ls -t "$TEST_DIR"/*.json 2>/dev/null | head -1)
python3 -c "import json; json.load(open('$FILE'))" 2>/dev/null
assert_eq "0" "$?" "JSON 유효성"

# --- 5. 메시지 추출 ---
echo ""
echo "5. 메시지 추출"

run_hook "working" '{"user_prompt": "버그 수정해줘"}'
assert_eq "버그 수정해줘" "$(get_field 'message')" "working: user_prompt 추출"

run_hook "blocked" '{"message": "Bash 실행 권한 필요"}'
assert_eq "버그 수정해줘" "$(get_field 'message')" "blocked: 이전 메시지 유지"

run_hook "done" ''
assert_eq "버그 수정해줘" "$(get_field 'message')" "done: 이전 메시지 유지"

run_hook "waiting" ''
assert_eq "버그 수정해줘" "$(get_field 'message')" "waiting: 이전 메시지 유지"

run_hook "working" '{"user_prompt": "새로운 질문"}'
assert_eq "새로운 질문" "$(get_field 'message')" "working: 새 프롬프트로 메시지 갱신"

# --- 6. 라벨 생성 ---
echo ""
echo "6. 라벨 생성"

run_hook "working"
assert_not_empty "$(get_field 'label')" "label 필드 존재"
assert_not_empty "$(get_field 'worktree')" "worktree 필드 존재"

LABEL=$(get_field 'label')
BRANCH=$(get_field 'branch')
WORKTREE=$(get_field 'worktree')
echo "  ℹ️  branch=$BRANCH, label=$LABEL, worktree=$WORKTREE"

# --- Cleanup ---
rm -rf "$TEST_DIR"

# --- Summary ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ 전체 통과: $PASS/$TOTAL"
else
  echo "  ❌ 실패: $FAIL/$TOTAL"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

exit "$FAIL"
