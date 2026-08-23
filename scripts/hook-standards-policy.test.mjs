import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const pluginRoot = new URL("plugins/hook-standards/", repositoryRoot);
const skillRoot = new URL("skills/hook-standards/", pluginRoot);
const scriptsRoot = new URL("scripts/", skillRoot);

// 規格與腳本分屬兩個檔案，一定會漂移。這支測試只守機械可驗的部分：
// 對應關係、檔案形狀、以及「不得自動註冊」這個決策本身。
function read(url) {
  return readFileSync(url, "utf8");
}

function listGuardScripts() {
  return readdirSync(scriptsRoot)
    .filter((name) => name.endsWith(".sh"))
    .sort();
}

test("每支腳本都同時出現在 SKILL.md 與 hook-catalog.md", () => {
  const scripts = listGuardScripts();
  assert.ok(scripts.length > 0, "scripts/ 必須至少有一支 hook 腳本");

  const skill = read(new URL("SKILL.md", skillRoot));
  const catalog = read(new URL("references/hook-catalog.md", skillRoot));

  for (const script of scripts) {
    assert.ok(skill.includes(script), `SKILL.md 必須提到 ${script}`);
    assert.match(
      catalog,
      new RegExp(`^## ${script.replace(/\./g, "\\.")}$`, "m"),
      `hook-catalog.md 必須有 ## ${script} 章節`,
    );
  }

  const catalogSections = catalog.match(/^## .+\.sh$/gm) ?? [];
  assert.equal(
    catalogSections.length,
    scripts.length,
    "hook-catalog.md 的腳本章節數必須等於 scripts/ 的腳本數，不得有孤兒章節",
  );
});

test("hook-catalog.md 每支腳本都填滿六個固定欄位", () => {
  const catalog = read(new URL("references/hook-catalog.md", skillRoot));
  const fields = [
    "事件與 matcher",
    "攔什麼",
    "決定",
    "不攔什麼",
    "對應規則",
    "踩坑記錄",
  ];

  const sections = catalog.split(/^## /m).slice(1);
  const scriptSections = sections.filter((section) => /^\S+\.sh$/m.test(section.split("\n")[0]));

  for (const section of scriptSections) {
    const name = section.split("\n")[0];
    for (const field of fields) {
      assert.ok(
        section.includes(field),
        `hook-catalog.md 的 ${name} 章節缺少「${field}」欄位`,
      );
    }
  }
});

test("每支腳本以 shebang 開頭，且檔頭說明了為什麼這是 hook", () => {
  for (const script of listGuardScripts()) {
    const source = read(new URL(script, scriptsRoot));
    assert.match(source, /^#!/, `${script} 必須以 shebang 開頭`);

    const header = source.split("\n").slice(0, 40).join("\n");
    assert.match(
      header,
      /^#.*(?:Why:|為什麼)/m,
      `${script} 的檔頭必須說明為什麼這件事是 hook 而不是規則文字`,
    );
  }
});

test("SKILL.md 八節齊備", () => {
  const skill = read(new URL("SKILL.md", skillRoot));
  const sections = [
    "分層原則",
    "入選判準",
    "deny 與 ask",
    "匹配紀律",
    "失敗紀律",
    "輸出格式",
    "註解義務",
    "安裝與更新",
  ];

  for (const section of sections) {
    assert.match(
      skill,
      new RegExp(`^## ${section}$`, "m"),
      `SKILL.md 必須有 ## ${section} 章節`,
    );
  }
});

test("plugin 不得提供 hooks.json，避免與個人層註冊雙重觸發", () => {
  assert.equal(
    existsSync(new URL("hooks/hooks.json", pluginRoot)),
    false,
    "hook-standards 刻意不自動註冊；加上 hooks/hooks.json 會讓同一個 Bash 指令跑兩次 guard",
  );
});

test("marketplace 收錄 hook-standards，且 coolify 仍在索引 0", () => {
  const marketplace = JSON.parse(
    read(new URL(".claude-plugin/marketplace.json", repositoryRoot)),
  );

  assert.equal(
    marketplace.plugins[0].name,
    "coolify",
    "Release Please 以索引 0 寫版號，coolify 必須留在第一個",
  );

  const entry = marketplace.plugins.find((plugin) => plugin.name === "hook-standards");
  assert.ok(entry, "marketplace.json 必須收錄 hook-standards");
  assert.equal(entry.source, "./plugins/hook-standards");
  assert.equal(
    Object.hasOwn(entry, "version"),
    false,
    "非索引 0 的 entry 不帶 version 欄位，對齊其餘 entry 的既有慣例",
  );
});

test("release-please 追蹤 hook-standards 的版號", () => {
  const config = JSON.parse(read(new URL("release-please-config.json", repositoryRoot)));
  const tracked = config.packages["."]["extra-files"].some(
    (entry) => entry.path === "plugins/hook-standards/.claude-plugin/plugin.json",
  );

  assert.ok(tracked, "release-please-config.json 必須追蹤 hook-standards 的 plugin.json");
});
