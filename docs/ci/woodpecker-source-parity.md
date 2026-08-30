# Woodpecker source parity（JUR-217）

## 範圍與目前 authority

本文件記錄 JUR-217 的 source-level parity。`.drone.yml` 保持現行有效
CI/release 路徑；`.woodpecker/` 僅提供可審查、可本地驗證的對等設定。此變更不啟用
Woodpecker、OAuth、webhook、repository secret、GitHub required check、Coolify、部署或
production mutation。

本 repository 沒有已證實的部署 pipeline；不得由 Woodpecker 設定創造 deploy 責任。

## Workflow 對應

Woodpecker 將 `.woodpecker/` 中每個 YAML 檔視為獨立 workflow。workflow 名稱由檔名
去除路徑、開頭句點與副檔名推導；cross-workflow `depends_on` 必須使用該推導後的
名稱。詳見 [Woodpecker workflow 文件](https://woodpecker-ci.org/docs/next/usage/workflows)。

| 既有 Drone 合約 | Woodpecker 檔案與推導名稱 | 事件與分支 | 相依關係 |
| --- | --- | --- | --- |
| `validate` | `validate.yml` → `validate` | `push`、`pull_request`；`main` | 無 |
| `release` | `release.yml` → `release` | `push`；`main` | 無 |
| `release-pr-auto-merge` | `release-pr-auto-merge.yml` → `release-pr-auto-merge` | `push`；`main` | `depends_on: [validate, release]` |

`release-pr-auto-merge` 只會在兩個相依 workflow 成功後執行。每個 workflow 仍在不同
agent 上執行，因此設定與腳本不得假設可跨 workflow 共用 workspace、artifacts 或檔案。
每個 workflow 都必須自行取得它需要的來源與依賴。

`release` 內的 `github-release` 與 `release-pr` 保留既有先後順序；後者只會在前者成功後
執行。需要 GitHub API 的 main-only steps 只引用既有命名 credential，PR-capable 的
`validate` workflow 沒有該 credential scope。runtime metadata 只在命令內轉接至既有
release eligibility 與 auto-merge script 所需的欄位，不讀取或記錄 credential 值。

## 本地驗證

```bash
npm run validate:woodpecker
node --test scripts/woodpecker-ci-policy.test.mjs
npm run validate
claude plugin validate .
```

`validate-woodpecker-config.mjs` 對檔名、trigger、dependency graph、credential scope、
Release Please pin、release eligibility、auto-merge 與跨 workflow state 禁令做結構驗證。
policy tests 以暫存 fixture 證明錯誤檔名 mapping、帶副檔名的 dependency、額外
auto-merge command、PR credential scope 及 workspace sharing 都會失敗。

## Rollback evidence 與受控窗口

source rollback 是回復 JUR-217 的 source-parity commit；`.drone.yml` 未被移除或改寫，
因此在 JUR-215 尚未授權 live integration 前，既有 Drone 路徑不受本變更影響。每次
rollback proof 至少應保留：revert commit、`git diff --check`、四項本地驗證結果，以及
`.drone.yml` 保持原狀的 diff readback。

下列事項不是 JUR-217 的完成宣稱，而是 JUR-215 受控窗口的前置條件：

1. 由授權 owner 完成平台 repository activation、OAuth/webhook 與命名 credential
   provision；不得在 source review 或 evidence 中揭露值、token、header 或 scope。
2. 在 exact PR head 取得 Woodpecker status readback，並記錄實際 check context。
3. 由 owner 取得 temporary required-check governance 的變更前後 readback；JUR-217
   不會修改這項設定。
4. 在 trusted `main` 取得 `validate`、`release` 與 `release-pr-auto-merge` 的實際
   終態與 release PR auto-merge evidence。
5. 若 status、release 或 auto-merge 終態不符，JUR-215 owner 依受控 rollback 程序維持
   或還原 Drone-only authority，再附上平台 readback；JUR-217 不執行此類 live mutation。

在上述證據存在前，不得宣稱 fleet cutover、required-check 遷移、release 成功或 deploy
acceptance 已完成。
