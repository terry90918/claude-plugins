import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// fileURLToPath()，不用 URL.pathname——後者對路徑中的空白等字元保留
// percent-encoding（如 %20），會讓 spawnSync 的 cwd 指向一個不存在的路徑。
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

// shellcheck 是否真的裝在這個環境，測試本身要能明確回報，不能靜默通過——
// 這正是 jq／git 先前踩過的坑：工具缺席時檢查安靜地什麼都沒做。
const shellcheckAvailable = spawnSync("shellcheck", ["--version"]).status === 0;

// 掃描範圍與 package.json 的 lint:shell 一致：整個 repo，只排除 .git、
// node_modules 與未版控的 worktree 暫存目錄——不限定 plugins／scripts，
// 否則 .github/ 或 repo 根目錄新增的 .sh 會被文件承諾涵蓋卻實際漏檢。
function findShellScripts() {
  const result = spawnSync(
    "bash",
    [
      "-c",
      "find . \\( -path ./.git -o -path ./node_modules -o -path './.claude/worktrees' \\) -prune -o -name '*.sh' -print",
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  assert.equal(result.status, 0, "find 不得以非零退出碼結束");
  return result.stdout.trim().split("\n").filter(Boolean);
}

test("shellcheck 必須存在於這個環境", () => {
  assert.ok(
    shellcheckAvailable,
    "shellcheck 未安裝——CI 映像的 apt-get 步驟或本機開發環境需要補裝，" +
      "不能靜默跳過這條檢查",
  );
});

test("repo 內現有的每一支 .sh 都通過 shellcheck", { skip: !shellcheckAvailable }, () => {
  const scripts = findShellScripts();
  assert.ok(scripts.length > 0, "repo 內必須至少有一支 .sh 腳本可供檢查");

  const result = spawnSync("shellcheck", scripts, { cwd: REPO_ROOT, encoding: "utf8" });

  assert.equal(
    result.status,
    0,
    `shellcheck 對現有腳本回報問題，須修正或加上有理由的 disable 註解：\n${result.stdout}`,
  );
});

test(
  "shellcheck 真的會抓到問題——不是接了一個永遠通過的空檢查",
  { skip: !shellcheckAvailable },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shellcheck-fixture-"));
    try {
      // SC2086：未加引號的變數展開，shellcheck 的招牌檢查之一。
      const fixture = path.join(dir, "broken.sh");
      writeFileSync(fixture, "#!/usr/bin/env bash\nrm -rf $1\n");

      const result = spawnSync("shellcheck", [fixture], { encoding: "utf8" });

      assert.notEqual(
        result.status,
        0,
        "fixture 故意寫了會觸發 SC2086 的程式碼，shellcheck 必須回報非零退出碼",
      );
      assert.match(result.stdout, /SC2086/, "必須明確指出 SC2086 這條規則");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
