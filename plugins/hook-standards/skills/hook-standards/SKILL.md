---
name: hook-standards
description: >
  Claude Code hook 的規格：什麼行為該用 hook 強制、什麼該留在 CLAUDE.md 判斷層、
  deny 與 ask 怎麼選、匹配與失敗紀律、輸出格式、註解義務，以及安裝與更新步驟。
  另附三支現行守衛（git-guard、destructive-guard、worktree-hookspath-fix）的逐支規格。
  Use when 新增或修改 Claude Code hook、編輯 settings.json 的 hooks 區塊、
  審查一支 hook 是否合格，或需要知道目前環境有哪些守衛、它們會擋下什麼。
---

## 分層原則

Hook 是強制層，`CLAUDE.md` 的常駐文字是判斷層。**兩者並存，不互相取代。**

Hook 只看得到 Bash 指令的字面。Claude 走 MCP 工具、走 `Edit`、或在還沒下指令的判斷
階段就決定要做某件事時，hook 完全看不到。把一條安全禁令只寫進 hook，等於只擋住了
Bash 那一條路徑。

因此：**安全禁令的文字不因為有了 hook 就從 `CLAUDE.md` 移出。** 新增 hook 是加上一層
強制，不是把規則搬家。

## 入選判準

一句話：**漏做一次就會出事嗎？**

| 情況 | 該進 hook 嗎 |
|---|---|
| 零例外必須被擋，且代價不可逆 | 是 |
| 壞掉時無聲——不報錯、不警告 | 是。沒有 hook 就沒有人會發現 |
| 需要看上下文才知道對不對 | 否，留在 `CLAUDE.md` |
| 只是「最好這樣做」 | 否 |

第二列是 `worktree-hookspath-fix.sh` 的存在理由：git 找不到 `core.hooksPath` 指向的目錄
就直接不跑 hook，不報錯也不警告。除非有人主動去 `git config --get core.hooksPath`，
否則沒人會發現防護已經沒了。

## deny 與 ask

| 決定 | 什麼時候用 | 例子 |
|---|---|---|
| `deny` | 零例外，且有明確的替代路徑可以講給呼叫者聽 | 直推預設分支 → 走 feature 分支開 PR |
| `ask` | 動作本身合法，對不對取決於只有呼叫者知道的上下文 | `rm -rf` 的目標路徑是不是真的那一個 |

`deny` 的理由**必須包含替代路徑**。只說「不准」會讓呼叫者原地重試或繞路，兩種都比
放行更糟。

## 匹配紀律

三條都有實戰來源，不是預防性的潔癖。

1. **錨定真實的指令位置，不比對裸字串。**
   `git-guard.sh` 早期用裸子字串比對跳過 hook 的旗標，結果 `echo "... <旗標> ..."` 被
   擋，連 hook 檔本身都無法透過 Bash 編輯。現在錨定在行首，或 `;` `&` `|` `(` `&&`
   `||` 之後。殘留誤判：引號內看起來像 git 指令的字串仍可能命中——要根治需要真正的
   shell parser，不值得那個複雜度，所以寫進 catalog 的「不攔什麼」欄位而不是假裝沒有。

2. **列舉選項，不用開放式 pattern。**
   `git[^;&|]*push` 會命中 `git log --grep push`，而它不 push 任何東西。`git-guard.sh`
   改為列舉 git 的 global option（`-C`、`-c`、`--git-dir=`、`--work-tree=`、
   `--no-pager`、`-P`）再接 `push`。

3. **解析失敗一律退回最保守的答案，絕不因此放行。**
   `git-guard.sh` 判斷「這個指令推去哪個 repo」的順序是 `git -C <path>` → push 之前
   最後一個 `cd` → session cwd。路徑含變數、subshell、glob，或根本不是工作樹時，退回
   session cwd 再判一次，不會因為解析不出來就放行。
   這條的來源是一次誤擋：早期版本問的是「session repo 在不在預設分支」，而不是「這個
   指令推去哪個 repo 的哪個分支」，於是在 repo B 推 feature 分支，被 repo A 的 checkout
   狀態擋下。

## 失敗紀律

- **任何錯誤 `exit 0`，絕不阻斷 session。** hook 自己壞掉不該讓使用者無法工作。
- **冪等。** 同一支腳本可能掛在多個事件上（例如 `SessionStart` 加 `PostToolUse`），
  重複執行不得產生第二次副作用。
- **修復型 hook 必須提供停用開關**，用 env var，例如 `CLAUDE_HOOKSPATH_FIX_DISABLE=1`。
  它會改寫狀態，壞掉時要有一條不改檔案就能關掉的路徑。純 `deny`／`ask` 的守衛不強制
  ——移除註冊就等於關掉，而守衛多一個開關等於多一條繞過路徑。三支現行守衛裡只有
  `worktree-hookspath-fix.sh` 有開關，這是刻意的分界。
- **外部工具不可用時的行為必須是明確的選擇。** 三支守衛都用 `jq` 解析 stdin；`jq` 不在
  時取到空字串、比對不中、放行——那是 fail-open。這個取捨可以接受，但要寫進
  `references/hook-catalog.md` 的「不攔什麼」，不能讓它變成沒人知道的預設。
- **環境類修正不動全域設定。** 優先用 env var、臨時設定檔、單次指令參數。動全域設定
  留下的副作用不會出現在任何一次 review 的 diff 裡。

## 輸出格式

輸入從 stdin 進來。Bash 指令在 `.tool_input.command`。用 `jq` 取值時一律給 `// ""`
預設值——`jq` 不存在或欄位缺席都不能讓 hook 崩掉。

`PreToolUse` 用 stdout 回一個 JSON 決定：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "為什麼被擋，以及替代路徑"
  }
}
```

`permissionDecision` 取 `deny` 或 `ask`。**不輸出 JSON 就是放行**，所以「什麼都不做」
必須是安全的預設。

`SessionStart` 用 `additionalContext` 注入文字：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "要注入的內容"
  }
}
```

注入前先 strip：shell 的 herestring 會補一個換行，不 strip 的話「無事發生」也會注入
一個 `\n`。

## 註解義務

每支 hook 的檔頭必須回答三個問題：

1. 它擋什麼、修什麼
2. **為什麼這是 hook，而不是 `CLAUDE.md` 的一行字**
3. 踩過的坑：曾經誤擋什麼、為什麼改成現在的形狀

第 3 點不是註解禮儀。誤擋修好之後留下的形狀通常看起來很繞，下一個人會想把它「簡化」
掉——除非檔案裡寫著上次為什麼不能那樣寫。

`scripts/hook-standards-policy.test.mjs` 會檢查每支腳本的檔頭有沒有回答第 2 點。

## 安裝與更新

本 plugin 內的腳本是真身，但 Claude Code **不會自動註冊它們**。

複製到個人層並給執行權限：

```bash
cp "$HOME/.claude/plugins/cache/jurislm-tools/hook-standards/<version>/skills/hook-standards/scripts/"*.sh "$HOME/.claude/hooks/"
```

```bash
chmod +x "$HOME"/.claude/hooks/*.sh
```

註冊寫進 `~/.claude/settings.json` 的 `hooks` 區塊。編輯 `settings.json` 依
`update-config` Skill 操作，不要憑記憶手改 JSON。

兩個刻意的設計，改動前先讀懂：

- **不要讓 `settings.json` 直接指向 plugin 內的路徑。** 快取路徑帶版號
  （`~/.claude/plugins/cache/jurislm-tools/<plugin>/<version>/`），每次 release 就換一個
  目錄。舊目錄不會自動清掉，所以指過去的實際結果通常不是「路徑斷掉」，而是**繼續跑
  舊版腳本**；目錄真的被清掉時才變成 hook 靜默不執行。兩種都不報錯。更新 plugin 之後
  要重新複製一次。
- **本 plugin 不提供 `hooks/hooks.json`，`plugin.json` 也不帶 `hooks` 欄位。** 兩者都會讓
  Claude Code 自動掛上事件——manifest 的 `hooks` 欄位可以指向任意路徑，而且與預設位置
  是**合併**而不是取代。任一存在都會與個人層 `settings.json` 既有的註冊雙重觸發，同一個
  Bash 指令跑兩次 guard。`scripts/hook-standards-policy.test.mjs` 兩條路徑都擋。

## 現行守衛

逐支規格見 `references/hook-catalog.md`，含每支「明確不攔什麼」的已知盲點。

| 腳本 | 事件 | 做什麼 |
|---|---|---|
| `git-guard.sh` | `PreToolUse` / Bash | 擋跳過 hook 的旗標、擋 push 到預設分支 |
| `destructive-guard.sh` | `PreToolUse` / Bash | 破壞性指令改為先問再放行 |
| `worktree-hookspath-fix.sh` | `SessionStart`、`PostToolUse` / EnterWorktree | 自癒 worktree 被寫入的絕對 `core.hooksPath` |
