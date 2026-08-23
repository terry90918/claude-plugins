#!/usr/bin/env bash
# PreToolUse guard: stop before destructive or irreversible shell commands.
#
# Why: the global rule is "ask before destructive or irreversible operations".
# This hook is the enforcement layer for the shell-command shape of that rule;
# the prohibition text stays in ~/.claude/CLAUDE.md for everything a hook
# cannot see.
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || printf '')
lower=$(printf '%s' "$cmd" | tr '[:upper:]' '[:lower:]')

ask() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

case "$lower" in
  *"rm -rf"*|*"rm -fr"*|*"rm -r -f"*)
    ask "全域安全禁令：破壞性操作動手前先問。這是遞迴強制刪除，沒有資源回收筒。確認目標路徑正確、且不需要先備份，再放行。"
    ;;
  *"drop table"*|*"drop database"*|*"drop schema"*|*"truncate table"*)
    ask "全域安全禁令：破壞性資料庫操作動手前先問。這會刪掉資料且無法用 git 還原。確認有備份、且目標資料庫正確，再放行。"
    ;;
  *"migrate reset"*|*"migration reset"*|*"db push --force"*|*"db push --accept-data-loss"*)
    ask "全域安全禁令：這個指令會重置或強制覆寫 schema 並丟失資料。schema 只往前走 —— 開一個新的 migration，不要 reset。"
    ;;
esac

exit 0
