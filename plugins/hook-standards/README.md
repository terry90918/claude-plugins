# hook-standards

Claude Code hook 規格與現行守衛 — 什麼該用 hook 強制、什麼留在 CLAUDE.md 判斷層、deny 與 ask 怎麼選、匹配與失敗紀律、輸出格式

## 安裝

```bash
claude plugin install hook-standards@jurislm-tools
```

## 內容

- skill
- 三支現行守衛腳本（`skills/hook-standards/scripts/`）
- 逐支規格與已知盲點（`skills/hook-standards/references/hook-catalog.md`）

## 使用

依意圖觸發：新增或修改 Claude Code hook、編輯 `settings.json` 的 `hooks` 區塊、審查一支 hook 是否合格，或想知道目前環境有哪些守衛、它們會擋下什麼。

本 plugin **不提供** `hooks/hooks.json`，安裝後不會自動註冊任何 hook。腳本要自行複製到 `~/.claude/hooks/` 並註冊，步驟見 Skill 的「安裝與更新」一節。

## 來源

此 plugin 屬於 [jurislm-tools](https://github.com/jurislm/jurislm-tools) marketplace。版本由 Release Please 管理。
