#!/bin/bash
# SessionStart / PostToolUse(EnterWorktree) hook — 修復 Claude Code harness 下的 core.hooksPath 毒
#
# 病灶（2026-07-14 實證，對應 anthropics/claude-code#60620）：
#   harness 建立 worktree 時，會把「從主 repo 推導出來的絕對路徑」寫進該 worktree 的
#   $GIT_COMMON_DIR/worktrees/<name>/config.worktree：
#
#       [core]
#           longpaths = true
#           hooksPath = /abs/path/to/MAIN_REPO/.husky
#
#   而 extensions.worktreeConfig = true 讓 worktree 層級的值蓋過 shared config。
#   結果：該 worktree 執行的是「主目錄當前 checkout 的那份 hook 檔」，不是自己分支的版本。
#   主目錄一被切到別的分支，全部 worktree 的 pre-commit / commit-msg gate 就靜默消失。
#
#   git 對「相對」core.hooksPath 會解析到「當前 worktree 頂層」（從子目錄操作也正確），
#   所以只要把 worktree 層級那個絕對值 unset 掉，shared config 的相對值就會正確接手。
#
# 為什麼必須是 hook，不能靠記得：
#   壞掉時完全無聲——git 找不到 hooksPath 指向的目錄就直接不跑 hook，不報錯、不警告。
#   除非有人主動去 `git config --get core.hooksPath`，否則沒人會發現防護已經沒了。
#
# 與 ECC block-no-verify 的分工：那個擋的是 `git -c core.hooksPath=` 單次指令繞過；
# 這個修的是被寫進 config 的持久性漂移。兩者不重疊。
#
# 冪等；任何錯誤都 exit 0（絕不阻斷 session）。
# 停用：export CLAUDE_HOOKSPATH_FIX_DISABLE=1

set -uo pipefail

emit() {
    # .strip()：bash herestring 會補一個換行，不 strip 的話「無事發生」也會注入 "\n"
    python3 -c '
import json, sys
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": sys.stdin.read().strip(),
}}))' <<<"${1:-}" 2>/dev/null \
        || printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}'
    exit 0
}

[ -n "${CLAUDE_HOOKSPATH_FIX_DISABLE:-}" ] && emit ""
command -v git >/dev/null 2>&1 || emit ""
git rev-parse --git-dir >/dev/null 2>&1 || emit ""   # 非 git 目錄 → 無事可做

FIXED=""

# $1 = hooksPath 值, $2 = 該 worktree 頂層。回傳 0 代表「絕對且指向他處」= 毒。
is_foreign_abs() {
    case "$1" in
        /*) ;;                       # 絕對路徑 → 繼續判斷
        *)  return 1 ;;              # 相對路徑 → git 解析到當前 worktree 頂層，正確
    esac
    case "$1" in
        "$2"|"$2"/*) return 1 ;;     # 絕對但指向自己內部 → 可接受，不動
    esac
    return 0
}

# 掃描本 repo 的每一個 worktree（含主目錄）
while IFS= read -r wt; do
    [ -d "$wt" ] || continue

    # (a) worktree 層級（config.worktree）——harness 下毒的位置，且優先序高於 shared
    val=$(git -C "$wt" config --worktree --get core.hooksPath 2>/dev/null) || val=""
    if [ -n "$val" ] && is_foreign_abs "$val" "$wt"; then
        if git -C "$wt" config --worktree --unset core.hooksPath 2>/dev/null; then
            FIXED="${FIXED}
- \`$(basename "$wt")\`：移除 worktree 層級的絕對 hooksPath（\`$val\`）→ 改由 shared config 接手"
        fi
    fi

    # (b) shared 層級（.git/config）——改寫成相對路徑，讓每個 worktree 跑自己分支的 hook
    val=$(git -C "$wt" config --local --get core.hooksPath 2>/dev/null) || val=""
    if [ -n "$val" ] && is_foreign_abs "$val" "$wt"; then
        base=$(basename "$val")
        # 只有該目錄名確實存在於 worktree 頂層時才改寫；否則寧可不動，也不要亂猜
        if [ -d "$wt/$base" ] && git -C "$wt" config --local core.hooksPath "$base" 2>/dev/null; then
            FIXED="${FIXED}
- shared \`.git/config\`：絕對 hooksPath（\`$val\`）→ 相對 \`$base\`（git 會解析到各 worktree 自己的頂層）"
        fi
    fi
done <<EOF
$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
EOF

[ -z "$FIXED" ] && emit ""

emit "## ⚠️ git hook 路徑已自癒（SessionStart hook 自動偵測，非使用者指令）

Claude Code 建立 worktree 時會寫入指向**主 repo** 的絕對 \`core.hooksPath\`（anthropics/claude-code#60620），
使該 worktree 執行主目錄 checkout 的 hook 檔、而非自己分支的版本——且**壞掉時完全無聲**。

已修正：
${FIXED}

代表在此之前，受影響 worktree 的 husky gate（pre-commit / commit-msg / pre-push）可能並未按預期版本執行。"
