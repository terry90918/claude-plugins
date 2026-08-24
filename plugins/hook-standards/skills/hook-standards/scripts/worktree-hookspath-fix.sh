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
NOTED=""

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

    # (a) worktree 層級（config.worktree）——harness 下毒的位置，且優先序高於 shared。
    #
    # ⚠️ 只在 extensions.worktreeConfig 已啟用時才碰。git-config 的定義是：該 extension
    # 未啟用時 `--worktree` **等同 `--local`**，於是這裡的 --unset 動到的會是 repo 的
    # 共用設定，把使用者刻意設定的 hooks 目錄無聲刪掉——一個設了
    # core.hooksPath=/opt/company-hooks 的普通 repo，被開過一次 session 就失去
    # commit／push gate。已實測重現，見 scripts/worktree-hookspath-fix.test.mjs。
    #
    # 這個閘門不會失去任何功能：extensions.worktreeConfig 未啟用時本來就不存在
    # config.worktree，也就沒有 worktree 層級的值該被 unset。
    # `--local` 是必要的：git 只認 **repo 層級** 的這個 extension，但不加 scope 的
    # `--get` 會一路讀到 global 與 system。使用者的 ~/.gitconfig 裡有一行
    # extensions.worktreeConfig = true 就足以騙過這個閘門——git 沒有啟用 worktree
    # config，`--worktree` 仍等同 `--local`，破壞性 unset 原封不動回來。已實測重現。
    #
    # `--type=bool` 也是必要的：git 認 true／TRUE／1／yes／on，字面比對 "true" 會讓
    # 另外四種寫法的 repo 失去修復。
    if [ "$(git -C "$wt" config --local --type=bool --get extensions.worktreeConfig 2>/dev/null)" = "true" ]; then
        val=$(git -C "$wt" config --worktree --get core.hooksPath 2>/dev/null) || val=""
        if [ -n "$val" ] && is_foreign_abs "$val" "$wt"; then
            if git -C "$wt" config --worktree --unset core.hooksPath 2>/dev/null; then
                FIXED="${FIXED}
- \`$(basename "$wt")\`：移除 worktree 層級的絕對 hooksPath（\`$val\`）→ 改由 shared config 接手"
            fi
        fi
    fi

    # (b) shared 層級（.git/config）——**只回報，不改寫**。
    #
    # 舊版會把絕對值改寫成相對路徑，條件只有「同名目錄存在於 worktree 頂層」，
    # 完全不檢查那個目錄裡有什麼。checkout 出來的分支若帶一個同名目錄，
    # core.hooksPath 就被改指到分支內容，之後每一次 commit／push 都會執行它。
    #
    # 而且 harness 的病灶寫在 config.worktree，不在 shared config——(b) 從來就不是在
    # 修那個病。改寫的風險換不到對應的價值，所以只把觀察講出來，讓人自己決定。
    # `.git/config` 是所有 worktree 共用的同一個檔案，所以這裡只回報一次。逐個
    # worktree 各報一次會讓同一件事重複出現 N 遍，而它永遠不會被解決——那是每個
    # session 都要付的 context 成本，也會稀釋同一則訊息裡「已修正」那一段的份量。
    if [ -z "$NOTED" ]; then
        val=$(git -C "$wt" config --local --get core.hooksPath 2>/dev/null) || val=""
        if [ -n "$val" ] && is_foreign_abs "$val" "$wt"; then
            NOTED="${NOTED}
- shared \`.git/config\`：\`core.hooksPath\` 指向工作樹之外（\`$val\`）"
        fi
    fi
done <<EOF
$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
EOF

[ -z "$FIXED" ] && [ -z "$NOTED" ] && emit ""

REPORT="## ⚠️ git hook 路徑（SessionStart hook 自動偵測，非使用者指令）"

if [ -n "$FIXED" ]; then
    REPORT="${REPORT}

Claude Code 建立 worktree 時會寫入指向**主 repo** 的絕對 \`core.hooksPath\`（anthropics/claude-code#60620），
使該 worktree 執行主目錄 checkout 的 hook 檔、而非自己分支的版本——且**壞掉時完全無聲**。

已修正：
${FIXED}

代表在此之前，受影響 worktree 的 husky gate（pre-commit / commit-msg / pre-push）可能並未按預期版本執行。"
fi

if [ -n "$NOTED" ]; then
    REPORT="${REPORT}

僅回報，**未改動**：
${NOTED}

這可能是刻意設定的共用 hooks 目錄，也可能是漂移。本 hook 不自動改寫 shared config——
改寫的判準只能看路徑形狀，分不出這兩者，而改錯的代價是把 hook 指到未經檢查的內容。
要處理請自己確認來源後手動調整。"
fi

emit "$REPORT"
