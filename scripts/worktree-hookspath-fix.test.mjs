import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = new URL("../", import.meta.url);
const HOOK = fileURLToPath(
  new URL(
    "plugins/hook-standards/skills/hook-standards/scripts/worktree-hookspath-fix.sh",
    repositoryRoot,
  ),
);

// 這支 hook 只透過 git 觀察與改寫狀態，所以它的行為只能用真的 repo 驗證。
// CI 的 node:*-bookworm-slim 沒有 git（實測確認），那裡改為驗證 hook 的失敗紀律：
// git 不在時安靜退出，不阻斷 session。
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

function runHook(cwd) {
  const result = spawnSync("bash", [HOOK], {
    cwd,
    input: "{}",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "hook 不得以非零退出碼結束");
  return result;
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

function makeRepo({ worktreeConfig, hooksPath, scope, topLevelDir }) {
  const dir = mkdtempSync(path.join(tmpdir(), "hookspath-"));
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");

  if (worktreeConfig) {
    git(repo, "config", "extensions.worktreeConfig", "true");
  }
  if (hooksPath) {
    git(repo, "config", `--${scope}`, "core.hooksPath", hooksPath);
  }
  if (topLevelDir) {
    mkdirSync(path.join(repo, topLevelDir));
  }
  return { dir, repo };
}

function withRepo(options, assertions) {
  const { dir, repo } = makeRepo(options);
  try {
    assertions(repo);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("git 不可用時安靜退出，不阻斷 session", { skip: gitAvailable }, () => {
  // 這裡不偽造環境。會跑到這條的環境就是真的沒有 git（CI 的 node:*-slim），
  // 用真實環境驗證才有意義——把 PATH 換掉只會連 bash 都找不到，那測的是別的東西。
  // 斷言解析後的結構，不比對序列化字串。腳本有兩條輸出路徑（python3 與 printf
  // fallback），兩者的空白排版不同——比對字串等於順便斷言了 python3 在不在，
  // 那是與本測試無關的事實。
  const { hookSpecificOutput } = JSON.parse(runHook(tmpdir()).stdout);
  assert.equal(hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(
    hookSpecificOutput.additionalContext,
    "",
    "git 不在時必須注入空 context，不得輸出雜訊",
  );
});

test(
  "extensions.worktreeConfig 未啟用時，不得移除 --local 的 core.hooksPath",
  { skip: !gitAvailable },
  () => {
    // git-config 定義：extensions.worktreeConfig 未啟用時，--worktree 等同 --local。
    // 此時對 --worktree 下 --unset 動到的是 repo 的共用設定，不是什麼 per-worktree
    // override——合法設定的 hooks 目錄會被無聲移除，commit／push gate 隨之消失。
    withRepo(
      { worktreeConfig: false, hooksPath: "/opt/company-hooks", scope: "local" },
      (repo) => {
        runHook(repo);
        assert.equal(
          git(repo, "config", "--local", "--get", "core.hooksPath"),
          "/opt/company-hooks",
          "未啟用 worktreeConfig 的 repo，其 --local core.hooksPath 必須原封不動",
        );
      },
    );
  },
);

test(
  "shared 層級的絕對路徑不得因為同名目錄存在就被改寫",
  { skip: !gitAvailable },
  () => {
    // 改寫只檢查同名目錄「存在」，不檢查裡面有什麼。checkout 出來的分支若帶一個
    // 同名目錄，core.hooksPath 會被改指到分支內容，之後每次 commit／push 都執行它。
    withRepo(
      {
        worktreeConfig: true,
        hooksPath: "/opt/company-hooks",
        scope: "local",
        topLevelDir: "company-hooks",
      },
      (repo) => {
        runHook(repo);
        assert.equal(
          git(repo, "config", "--local", "--get", "core.hooksPath"),
          "/opt/company-hooks",
          "不得把 core.hooksPath 改指到工作樹內的同名目錄",
        );
      },
    );
  },
);

test(
  "相對路徑的 core.hooksPath 不動",
  { skip: !gitAvailable },
  () => {
    withRepo(
      { worktreeConfig: true, hooksPath: ".husky", scope: "local", topLevelDir: ".husky" },
      (repo) => {
        runHook(repo);
        assert.equal(git(repo, "config", "--local", "--get", "core.hooksPath"), ".husky");
      },
    );
  },
);

test(
  "指向工作樹內部的絕對路徑不動",
  { skip: !gitAvailable },
  () => {
    const { dir, repo } = makeRepo({ worktreeConfig: true, topLevelDir: ".husky" });
    try {
      // 用 git 自己回報的頂層路徑組出「內部」的絕對路徑。腳本比對的是
      // `git worktree list` 的輸出，而 macOS 的 /var 是 /private/var 的 symlink——
      // 直接用 mkdtemp 給的路徑會讓「指向內部」被誤判成「指向外部」。
      const inside = path.join(git(repo, "rev-parse", "--show-toplevel"), ".husky");
      git(repo, "config", "--local", "core.hooksPath", inside);
      runHook(repo);
      assert.equal(git(repo, "config", "--local", "--get", "core.hooksPath"), inside);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "extensions.worktreeConfig 只設在 global 時，不得移除 --local 的值",
  { skip: !gitAvailable },
  () => {
    // git 只認 repo 層級的這個 extension。設在 global 不會讓 worktree config 生效，
    // 但「讀得到」——閘門若不限定 scope 就會被騙過，破壞性 unset 原封不動回來。
    const { dir, repo } = makeRepo({ hooksPath: "/opt/company-hooks", scope: "local" });
    try {
      const globalConfig = path.join(dir, "gitconfig");
      writeFileSync(globalConfig, "[extensions]\n\tworktreeConfig = true\n");
      const result = spawnSync("bash", [HOOK], {
        cwd: repo,
        input: "{}",
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
      });
      assert.equal(result.status, 0);
      assert.equal(
        spawnSync("git", ["-C", repo, "config", "--local", "--get", "core.hooksPath"], {
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
        }).stdout.trim(),
        "/opt/company-hooks",
        "global 層級的 extension 不得讓閘門放行",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "shared 層級的外部路徑只回報一次，不論有幾個 worktree",
  { skip: !gitAvailable },
  () => {
    const { dir, repo } = makeRepo({
      worktreeConfig: true,
      hooksPath: "/opt/company-hooks",
      scope: "local",
    });
    try {
      git(repo, "worktree", "add", "-q", "--detach", path.join(dir, "wt1"));
      const context = JSON.parse(runHook(repo).stdout).hookSpecificOutput.additionalContext;
      assert.match(context, /僅回報/, "必須把未改動的觀察講出來");
      assert.equal(
        context.split("/opt/company-hooks").length - 1,
        1,
        "同一份 shared config 不得因為有多個 worktree 而重複回報",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "worktreeConfig 啟用時，config.worktree 裡的外部絕對路徑仍會被移除",
  { skip: !gitAvailable },
  () => {
    // 這是 hook 存在的理由（anthropics/claude-code#60620），收斂判準時不得失去它。
    withRepo(
      { worktreeConfig: true, hooksPath: "/some/other/repo/.husky", scope: "worktree" },
      (repo) => {
        runHook(repo);
        // 用退出碼判斷「這個值不存在」，不用空字串——git 讀不到設定時回非零，
        // 而空字串也可能來自打錯的子指令，那會讓這條斷言變成空轉。
        assert.equal(
          spawnSync("git", ["-C", repo, "config", "--worktree", "--get", "core.hooksPath"])
            .status,
          1,
          "worktree 層級的外部絕對路徑必須被移除",
        );
      },
    );
  },
);
