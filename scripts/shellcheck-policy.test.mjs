import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// 掃描範圍與 package.json 的 lint:shell 逐字一致（維持同步，不要各自維護一份）：
// 整個 repo，只排除 .git、任何深度的 node_modules（用 -name 而非 -path，否則
// 巢狀在 plugins/*/node_modules 底下的第三方腳本不會被排除）、未版控的 worktree
// 暫存目錄，以及 .gitignore 列出的兩個執行期產物目錄 .spectra／.superpowers——
// 不限定 plugins／scripts，否則 .github/ 或 repo 根目錄新增的 .sh 會被文件承諾
// 涵蓋卻實際漏檢。
const FIND_SHELL_SCRIPTS_COMMAND =
  "find . \\( -path ./.git -o -name node_modules -o -path './.claude/worktrees' -o -path './.spectra' -o -path './.superpowers' \\) -prune -o -name '*.sh' -print";

function findShellScripts(cwd = REPO_ROOT) {
  const result = spawnSync("bash", ["-c", FIND_SHELL_SCRIPTS_COMMAND], {
    encoding: "utf8",
    cwd,
  });
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

test(
  "掃描範圍排除巢狀 node_modules 與 .gitignore 的執行期產物目錄",
  { skip: !shellcheckAvailable },
  () => {
    // Codex 審查揪出的缺陷：-path ./node_modules 只精確比對根目錄那一層，
    // plugins/*/node_modules 底下的第三方腳本會漏網；.spectra／.superpowers
    // 是 .gitignore 列出的執行期產物目錄，同樣沒被排除。用一個獨立的假 repo
    // 結構重現這四種情境，證明修正後全部被正確排除。
    const dir = mkdtempSync(path.join(tmpdir(), "shellcheck-scope-fixture-"));
    try {
      const nestedNodeModules = path.join(dir, "plugins", "foo", "node_modules", "bar");
      const rootNodeModules = path.join(dir, "node_modules", "baz");
      const spectraDir = path.join(dir, ".spectra");
      const superpowersDir = path.join(dir, ".superpowers");
      const realScriptDir = path.join(dir, "scripts");

      for (const d of [nestedNodeModules, rootNodeModules, spectraDir, superpowersDir, realScriptDir]) {
        mkdirSync(d, { recursive: true });
      }
      writeFileSync(path.join(nestedNodeModules, "evil.sh"), "#!/usr/bin/env bash\necho nested\n");
      writeFileSync(path.join(rootNodeModules, "also-evil.sh"), "#!/usr/bin/env bash\necho root\n");
      writeFileSync(path.join(spectraDir, "runtime.sh"), "#!/usr/bin/env bash\necho spectra\n");
      writeFileSync(path.join(superpowersDir, "runtime.sh"), "#!/usr/bin/env bash\necho superpowers\n");
      writeFileSync(path.join(realScriptDir, "real.sh"), "#!/usr/bin/env bash\necho real\n");

      const found = findShellScripts(dir);

      assert.deepEqual(
        found,
        ["./scripts/real.sh"],
        "只有真正的 repo 腳本該被找到，node_modules（任何深度）與 " +
          ".spectra／.superpowers 底下的內容都不該出現",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
