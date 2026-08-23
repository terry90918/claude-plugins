# 現行守衛逐支規格

每支固定六欄。**「不攔什麼」是已知盲點，不是遺漏**——寫出來是為了讓下一個人知道
邊界在哪，而不是重新發現一次。

腳本本身在 `../scripts/`，那裡是真身；`~/.claude/hooks/` 是複製過去的副本。

## git-guard.sh

**事件與 matcher** — `PreToolUse`，matcher `Bash`，條件 `Bash(git *)`，timeout 10 秒。

**攔什麼** — 兩件事，各自獨立判斷：

1. 在真實指令位置出現的「跳過 hook」旗標。錨點是行首或 `;` `&` `|` `(` `&&` `||`
   之後，後接選配的 `sudo`，再接 `git` 與子指令。
2. push 到目標 repo 的預設分支。兩種形狀都算：指令文字裡出現該分支名
   （` <branch> `、`:<branch> `、` <branch>:`），或當前 HEAD 就是預設分支。

目標 repo 的解析順序是 `git -C <path>` → push 之前最後一個 `cd <path>` → session cwd。
預設分支從 `refs/remotes/<remote>/HEAD` 讀，不假設叫 `main`；remote 不假設叫 `origin`。

**決定** — 兩者都是 `deny`。理由文字都附替代路徑：旗標壞掉就修 hook 不要繞過；要推
就走 feature 分支開 PR。

**不攔什麼**

- **push 的 refspec 完全不解析。** 實測 `git push origin +main` 與
  `git push origin HEAD:refs/heads/main` 都放行，兩者都是真的推 `main`。比對只看整條
  指令字串裡有沒有 ` <branch> `／`:<branch> `／` <branch>:` 這三種形狀。
- **`sudo` 以外的包裝一律看不到。** 實測 `env git push origin main` 與
  `sh -c "git push origin main"` 都放行。`GIT_AT_CMD` 的錨點只容許選配的 `sudo`，
  遇到 `env`、`command`、`nice`、`xargs`、`sh -c` 就整個失效——**guard 1 與 guard 2
  會同時關掉**。
- **`-n` 不在比對範圍。** 它是 `git commit --no-verify` 的短旗標，實測
  `git commit -n -m fix` 放行。`SKIP_FLAG` 只比對長格式字面。
- 引號內看起來像 git 指令的字串。要根治需要真正的 shell parser，不值得那個複雜度。
- 非 Bash 途徑的 push——MCP 工具、GUI、IDE 整合都看不到。
- remote 不存在，或 `refs/remotes/<remote>/HEAD` 查不到時，直接 `exit 0` 放行。
  這是刻意的：查不到預設分支就無從判斷，硬擋會讓不相干的 repo 全部卡住。
- `jq` 不存在或解析失敗時取到空字串，比對不中，放行。這是 fail-open——`jq` 是這支
  守衛的隱性依賴，它不在的環境等於沒有這層強制。
- 多 remote 時取 `git remote | head -1`，也就是列表第一個。同時掛著 `origin` 與 fork
  時可能解析到不是你要推的那個 remote 的預設分支。
- 路徑解析失敗時**不會**放行，會退回 session cwd 再判一次。這一條是刻意與上面幾條
  相反的：解析不出來是保守處理，查不到預設分支才是放行。

**對應規則** — 全域 `CLAUDE.md` 安全禁令的兩條：「絕不直接 push 到預設分支」、
「絕不用跳過 hook 的旗標」。hook 是強制層，那兩行文字仍留在 `CLAUDE.md`。

**踩坑記錄** — 兩次誤擋，兩次都改了匹配形狀：

1. 裸子字串比對旗標 → `echo "... <旗標> ..."` 被擋，連這支 hook 自己都無法透過 Bash
   編輯。改為錨定真實指令位置。腳本裡的旗標字串是組出來的（`'--no-'"verify"`），就是
   為了讓這個檔案本身能被編輯。
2. 只比對 `git[[:space:]]+push`，漏掉 `git -C <path> push`；改成開放式
   `git[^;&|]*push` 又誤中 `git log --grep push`。最後改為列舉 global option。
   同一輪還修掉更根本的一個錯：早期版本問的是「session repo 在不在預設分支」，
   於是在 repo B 推 feature 分支會被 repo A 的 checkout 狀態擋下。
3. **guard 2 已完整診斷，擁有者於 2026-08-23 決定暫不修。** 缺陷仍在，會反覆撞到。
   根因是它不解析 push 的 refspec，改問兩個代理問題——「指令字串裡有沒有出現分支名」
   與「當前 HEAD 是不是預設分支」。兩個方向都錯：

   - **誤擋**：`git commit -m "fix main nav" && git push origin feature` 被 deny，
     `main` 只是出現在 commit message 裡。在恆為預設分支的主目錄裡發的**任何** push
     也全擋，包含推 feature 分支、`--delete <feature>`、`--tags`。
   - **漏放**：見上面「不攔什麼」的前三條。

   這與本 plugin 匹配紀律第 1 條（錨定真實位置，不比對裸字串）直接牴觸，是這支腳本
   目前最明顯的自我違反。**因應方式是換一條不觸發的合法路徑**——push 一律在 feature
   worktree 內執行，不在主目錄發。誤擋時不得用編碼或改寫指令偽裝繞過，那正是這支
   hook 自己的訊息明文反對的行為。

   guard 1（跳過 hook 的旗標）除了 `-n` 漏網外行為正確，不要順手一起改。

## destructive-guard.sh

**事件與 matcher** — `PreToolUse`，matcher `Bash`，不加條件（所有 Bash 指令都過一遍），
timeout 10 秒。比對前先把指令轉小寫。

**攔什麼** — 三類：

1. 遞迴強制刪除：`rm -rf`、`rm -fr`、`rm -r -f`
2. 破壞性 DDL：`drop table`、`drop database`、`drop schema`、`truncate table`
3. schema 重置：`migrate reset`、`migration reset`、`db push --force`、
   `db push --accept-data-loss`

**決定** — 全部是 `ask`，不是 `deny`。這三類動作本身合法，對不對取決於目標路徑或
目標資料庫是不是真的那一個——只有呼叫者知道。`ask` 讓那個判斷回到人身上，而不是
讓 hook 猜。

**不攔什麼**

- **`-rf`／`-fr`／`-r -f` 以外的旗標順序與寫法。** 實測 `rm -f -r <path>` 與
  `rm --recursive --force <path>` 都會放行，兩者都是完整的遞迴強制刪除。清單列的是
  三種字面形狀，不是「遞迴且強制」這個語意。
- **多一個空白就漏。** 實測 `rm  -rf <path>`（`rm` 後兩個空格）放行。比對的是帶單一
  空格的字面子字串，沒有先正規化空白。同樣的弱點適用於 DDL 那組（`drop  table`、
  以 tab 分隔、或跨行的 heredoc 形式）。這一條容易「不小心」撞到，不必刻意繞。
- 變數展開後才成形的指令。hook 看到的是字面，`rm -rf "$DIR"` 攔得到，
  `$CMD` 展開成 `rm -rf ...` 攔不到。
- 非 Bash 途徑的刪除——MCP 工具、`Edit`／`Write` 覆寫檔案都不經過這裡。
- `jq` 不存在或解析失敗時取到空字串，比對不中，放行。與 `git-guard.sh` 同一個
  fail-open。
- `rm -r` 不帶 `-f`、`DELETE FROM`、`ALTER TABLE DROP COLUMN` 等其他破壞性 SQL。
  清單是列舉式的，不是語意分析。

**對應規則** — 全域 `CLAUDE.md` 的「破壞性或不可逆的操作動手前先問」與
「Schema 只往前走：開新的 migration，不改已套用的」。

**踩坑記錄** — 目前無誤擋記錄，但上面的旗標順序漏網是實測出來的，不是推論。列舉式
清單的代價就是這個：好處是不會誤擋，代價是同義寫法一律漏。在 `ask` 這個強度下這個
取捨划算；若某天改成 `deny`，要連同漏網一起重新評估。

## worktree-hookspath-fix.sh

**事件與 matcher** — 兩處：`SessionStart`（matcher `*`）與 `PostToolUse`
（matcher `EnterWorktree`）。

**攔什麼** — 不攔任何東西。這是修復型 hook，不是守衛型。它掃描本 repo 的每一個
worktree（含主目錄），處理兩個層級：

1. worktree 層級（`config.worktree`）：值是絕對路徑且指向該 worktree 之外時，
   `--unset` 掉，讓 shared config 的相對值接手。
2. shared 層級（`.git/config`）：同樣條件下改寫為相對路徑，讓每個 worktree 解析到
   自己的頂層。

病灶：harness 建立 worktree 時，會把從主 repo 推導的絕對路徑寫進該 worktree 的
`config.worktree`，而 `extensions.worktreeConfig = true` 讓 worktree 層級的值蓋過
shared config。結果該 worktree 執行的是主目錄當前 checkout 的那份 hook 檔。
對應 `anthropics/claude-code#60620`。

**決定** — 不適用，它不回 `permissionDecision`。修好之後透過 `additionalContext`
回報修了什麼；沒事發生時注入空字串。輸出的 `hookEventName` 寫死是 `SessionStart`，
掛在 `PostToolUse` 那條路徑上時也一樣——目前沒有觀察到副作用，但它是寫死的，不是
依事件動態決定。

**不攔什麼**

- 相對路徑的 `core.hooksPath` 不動——git 對相對值會解析到當前 worktree 頂層，本來就對。
- 絕對但指向該 worktree 內部的值不動，視為可接受。
- 非 git 目錄、`git` 不存在、或設了 `CLAUDE_HOOKSPATH_FIX_DISABLE=1` 時直接跳過。
- **它分辨不出「harness 下的毒」與「刻意設定的外部共用 hooks 目錄」。** 判準純粹是
  形狀——絕對路徑且指向該 worktree 之外。組織共用一份 `core.hooksPath` 正是同一個
  形狀，會被當成毒處理。
- **shared 層級的改寫是有條件的重新指向，不只是「不猜」。** 條件是同名目錄存在於
  worktree 頂層，而它**不檢查那個目錄裡有什麼**。若 shared config 指向
  `/opt/company-hooks`，而當前 checkout 的分支裡剛好有一個 `company-hooks/` 目錄，
  這支 hook 會把 `core.hooksPath` 改指到那個分支內的目錄——之後每一次 commit／push
  都會執行分支裡的腳本。審查他人分支時這條路徑值得留意。目前是程式碼推導出的結論，
  尚未實測。

**對應規則** — 沒有對應的 `CLAUDE.md` 條目，它修的是工具鏈缺陷不是人的行為。
與「擋單次 `-c core.hooksPath=` 繞過」的守衛分工明確：那個擋單次指令，這個修被寫進
config 的持久漂移，兩者不重疊。

**踩坑記錄** — 這支的存在本身就是踩坑結論：壞掉時完全無聲，git 找不到 `hooksPath`
指向的目錄就直接不跑 hook，不報錯也不警告。2026-07-14 實證前，受影響 worktree 的
pre-commit／commit-msg／pre-push gate 可能已經靜默失效一段時間而無人察覺。
