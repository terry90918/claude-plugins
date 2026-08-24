# 從 `entire` 提煉 Delivery Standard

`entire` 是 JurisLM 已驗證的 reference implementation，不是可直接複製的
`.drone.yml`。採用它時，先把實作轉成「事實 → 目的 → 可移植規則 → 驗收」，再設計目標
repo。pipeline 名稱、app 數量、UUID、環境變數與事故處理只在其風險存在時才採用。

## 取證順序

每次設定或改動 release／CI／CD，先 fetch `entire` 的 `origin/main`，讀取：

1. `package.json`、`turbo.json` 與 `release-please-config.json`：runtime、workspace
   task graph 與版本契約。
2. `.drone.yml`：觸發、pipeline 依賴、secret 邊界與執行順序。
3. `scripts/ci/run-gate.sh`、`is-release-commit.sh`：gate 路由與 release 判定。
4. `scripts/ci/coolify-deploy.ts`：deploy target、選擇性部署、health readback 與
   release commit 的處理。
5. `scripts/ci/release-pr-auto-merge.ts` 及其測試：候選 PR 的 allowlist、內容驗證與
   併發安全。

把目標 repo 的事實記成下列四欄；缺一欄不可直接套模板：

| 來源事實 | 它防的失效 | 目標 repo 的規則 | 可觀察驗收 |
|---|---|---|---|
| 例如：release PR 只改版本契約 | 自動合併非 release 內容 | 定義 closed artifact allowlist 與內容語意驗證 | 加入額外檔案或錯版號時拒絕合併 |

## Delivery graph

以每次 `main` push 的 commit `C` 為一個 delivery unit。`entire` 的關鍵不是固定
pipeline 數量，而是下列關係：

```text
必要 validation(C) ────────────────────────────────────┐
release(C) ─────────────────────────────────────────────┼─ auto-merge：只合併 base 為 C 的 release PR
deploy(C)（只有 deployment target，且已受 validation 保護）─┘
                                                        └─ 之後才跑不影響 delivery 的觀測／對帳
```

`release(C)` 先 cut 已合併 release PR 的 tag／GitHub Release，再建立或更新下一張
release PR。所有採用 Release Please 的 repo 都必須自動合併這張 candidate：無 deployment target
時，`release(C)` 與完整 validation 成功即有資格；有 deployment target 時，`deploy(C)` 與
`release(C)` 可並行，兩者成功前沒有任何 PR 有資格被自動合併。release PR 不走人工審核或點擊
合併；失敗 candidate 由後續 `main` delivery 修正／重試，不能手動繞過 validator。

## 可移植規則與條件邊界

這張表是推導理由，不是現行規則本身。與 `SKILL.md`（`Release 設定`、`部署（CD）`）出現的
具體規則若有分歧，以 `SKILL.md` 為準——這裡的作用是解釋那些規則從 `entire` 的哪個機制
提煉而來、邊界畫在哪，而不是另一份可獨立修改的規範。

| 設計面 | `entire` 的機制 | 必須提煉成的規則 | 何時是條件控制 |
|---|---|---|---|
| 版本契約 | 根目錄 manifest、`package.json`、`CHANGELOG.md` 構成單一版本；`release-type: node` | `release-type` 依版本 artifact 選擇，不依 runtime。每個 repo 必須明定可變更檔案集合與版本／changelog 的語意驗證。 | Plugin metadata 才用 `simple` 與 `extra-files`；allowlist 依目標 artifact 改寫。 |
| Release 順序 | `main` push 的 `github-release` 成功後才跑 `release-pr` | 先 cut 已合併且未發布的 release，再維護下一張 PR；第一步失敗必須阻擋第二步，兩步須冪等且明確指定 target branch、config 與 manifest。 | 只有選定 Release Please 的 repo 適用；npm publish 可在確定已 cut 後接續。 |
| 寫入權限 | Release token 只在 trusted `main` push 的 release／auto-merge 使用 | 任何可寫 GitHub 或部署的 token **不得進 PR build**——這是紅線，不是「讀取一律要另開 readonly token」。同一顆 write token 若只用於 trusted `main`-only pipeline（release、auto-merge、deploy 讀 live main），可以沿用；只有在 PR build 裡才必須換成獨立 readonly token 或完全不需要它。 | 沒有 release 或 auto-merge 時，不建立不需要的 write token。 |
| Runner control | `entire` 不把其 runner 未實際強制的 YAML resource limit 當作保護 | 這條規則管的是**宣稱**，不是模板要不要寫這些數字：`resources: { limits: ... } }` 這類欄位可以留在模板作資源配額建議，但只有經目前 runner 驗證真的會強制執行時，才能把它寫成「這是一種保護（例如防資源耗盡、公平排程）」；未驗證時只當配額建議，不宣稱它提供邊界保護。 | runner 實作、queue isolation 或 workload 需要時才加入邊界宣稱，並以實際執行結果驗證。 |
| CI gate | `run-gate.sh` 將 full／affected、docs-only、外部 scripts 與各測試環境集中路由 | Gate 依失效域與必要環境拆分，不依目錄名稱或固定 pipeline 數量。快速路徑沒有足夠 base／head 證據時必須回退 full gate；輸入域落在 docs 的守衛不能被 docs-only shortcut 略過。 | DB service、integration gate、workspace filter、build target 只在目標 repo 的依賴邊界需要時加入。 |
| Release 判定 | 一支 event-aware `is-release-commit.sh` 同時辨識 push merge／squash 與官方 release PR | release 判定必須是單一、可測試的 predicate；所有 gate 與 deploy 呼叫它決定要不要跳過。`github-release`／`release-pr` 這兩個 release cut 步驟本身不呼叫它——它們的職責就是每次觸發都跑，有沒有東西可 cut 交給 release 工具自己判斷。**release-only 的 side effect（例如 npm publish）例外**：它必須呼叫同一個 predicate，只在剛 cut 出新版時才發布，這仍是同一個「單一 predicate」的用法，不是另開一套判斷。 | 精確 branch、body marker 與提交格式依 provider／release tool 設定調整，但只比 branch 名稱不足。 |
| Production deploy | deploy 等待全部必要 gate；target registry 持有 workspace、UUID、health URL；依 dependency graph 選擇 target | `.drone.yml` 只負責觸發，deploy module 才是 target 的單一真實來源。無法判定是否受影響時 fail open 為部署，不可靜默漏部署；**有 commit-aware health endpoint 時**，每次部署必須等終態並讀回 commit。 | 沒有多 app、Coolify 或 commit-aware health endpoint 時（例如標準 fire-and-forget 模板，見 `ci-workflow-templates.md`），以「部署 API 呼叫成功」作為對應的可觀察驗收，不要求做模板沒有的終態確認。 |
| Release commit deploy | release commit 不重建 app；`--pin-only` 只推進目前 deployed commit 等於 release commit 父節點的 target，並 PATCH 後 GET 驗證 | 「跳過 full deploy」不等於「不更新部署狀態」，但也不能認領未部署變更。只可推進已 caught up 到父節點的 target；stale 或先前部署失敗的 target 保持原 base，避免下一次 affected diff 漏掉變更。 | 沒有以已部署 commit 做選擇性部署的系統，記錄為不適用，不虛構 pin-only。 |
| Release PR auto-merge | 串行化；驗證 repo、branch、author、官方 marker、closed file set、內容、base／head SHA、mergeability，並在 merge 前重新檢查 | 每個使用 Release Please 的 repo 都必須只合併與 `C` 對應的 candidate；`C` 必須先通過完整 validation、release，以及有 deployment target 時的 deploy。無候選是 no-op；被更新 build 取代的舊 build 可讓位 no-op；其他 mismatch 一律 fail closed。 | deployment 只改變 prerequisite：沒有 target 時以完整 validation 取代 deploy，不改變自動合併要求。candidate 不進人工審核或 merge；失敗後由後續 `main` delivery 重試。 |
| Webhook 與 migration 對帳 | push 漏發偵測排在 delivery 後；cron 補 quiet repo；shared migration 另以 readonly production audit 檢查 | 觀測／對帳不得搶在 deploy 或 auto-merge 前失敗。若「程式碼合併」與「外部狀態生效」沒有自動連結，建立獨立 readonly audit，而非把 production credential 放進 PR gate。 | 只在 webhook delivery 或 migration application 有這個斷點時導入；cron 名稱、repo 清單、DB 連線都是本地值。 |

## 必要驗收案例

每次採用此 standard，至少用目標 repo 的真實設定驗證：

1. 有 deployment target 的一般變更 `C`：所有必要 gate 完成。
   **預設（未採用選擇性部署）**：受影響的 app 各自的 deploy step 都會跑，不分是否真的
   受這次變更影響。**若額外採用選擇性部署**：只部署受影響 target。標準要求的是後者
   出現時必須驗證它確實只動受影響的部分，不是要求每個 adoption 都必須實作它。
   **Readback 同理分層**：若採用 commit-aware health endpoint，驗證其確實回報 `C`；
   標準預設模板（如 fire-and-forget 呼叫部署 API 後即結束）沒有這個能力時，以「部署
   API 呼叫成功」作為對應的可觀察驗收，不虛構模板未提供的 commit 級別確認。
2. 無 deployment target 的 npm／plugin candidate：同一 `C` 的完整 validation 與 `release(C)`
   成功後自動合併，不需人工審核或點擊 merge。
3. Release candidate：加入非版本檔、錯誤版本、錯誤 base SHA、假 branch／body 或不可 merge
   時均不會自動合併；candidate 保持開啟，不能改為人工合併。
4. Release commit：會跑 `github-release`，不做 full app rebuild；若系統使用選擇性部署，
   只將 deployed commit 等於 release 父節點的 target pin-only 並 readback，stale target
   維持原 base。
5. **僅適用已採用受影響 target 判定的 repo**：Git 資訊不足或判定失敗時，完整 gate 或
   deploy 仍會執行，不會以「未受影響」靜默成功。未採用該判定的 repo 不適用本案例——
   它的 deploy step 本來就對每次 push 都跑，沒有「判定失敗」這個狀態。
6. 目標 repo 使用 webhook 或人工 migration 時：對應 detector／audit 在 delivery 後或 cron
   執行，且不把 write credential 暴露給 PR。

## 常見錯誤翻譯

| 錯誤文字 | 正確規範 |
|---|---|
| 「`node` 代表 Node.js runtime」 | `node` 是 Release Please 的 artifact strategy；runtime 由 `packageManager`、`engines` 與部署平台另行決定。 |
| 「release commit 部署次數為零」 | release commit 不做 full deploy；若部署系統以 deployed commit 做 diff base，只對已 caught up 到 release 父節點的 target 做已驗證 pin-only state alignment。 |
| 「`entire` 用 target registry 是唯一正確做法，所有 monorepo 都該照抄」 | `entire` 自己在管理 6 個 prod app 時，把 app、workspace、deployment identity 與 health endpoint 收斂進 `coolify-deploy.ts` 的 target registry，pipeline 只呼叫該 module——這是它在那個規模下的條件控制。**本規範給一般 repo 的預設仍是 `SKILL.md` 明定的「每個部署的 app 各設一個 deploy step」**，更簡單、多數規模已足夠；只有 app 數量或部署邏輯複雜到單一 YAML 難以維護時，才考慮收斂成 target registry。 |
| 「`entire` 有幾條 pipeline，目標 repo 也必須有幾條」 | 先按 failure domain、service boundary、deployment topology 決定 gate；只保留滿足相同風險的控制。 |
| 「docs-only 可以跳過所有檢查」 | 先跑輸入域就是 docs 的 governance／integrity guard；只有其餘不受影響 gate 才可 shortcut。 |
| 「npm／純 plugin 沒有 deploy，所以 release PR 可人工審核或點擊合併」 | 所有 Release Please candidate 都由 trusted `main` delivery 的 validator 自動合併；無 deployment target 只把 prerequisite 改為完整 validation。 |
