import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const validator = resolve("scripts/validate-woodpecker-config.mjs");

function validate(configDirectory = ".woodpecker") {
  return spawnSync(process.execPath, [validator, configDirectory], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function withWorkflowFixture(callback) {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "woodpecker-ci-policy-"));
  const configDirectory = join(fixtureDirectory, ".woodpecker");
  cpSync(".woodpecker", configDirectory, { recursive: true });

  try {
    return callback(configDirectory);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

test("the repository Woodpecker workflows satisfy the source-parity contract", () => {
  const result = validate();

  assert.equal(result.status, 0, result.stderr);
});

test("the repository exposes a direct Woodpecker structural validation command", () => {
  const result = spawnSync("npm", ["run", "validate:woodpecker"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("the validate workflow bridges only documented Woodpecker metadata", () => {
  const workflow = readFileSync(".woodpecker/validate.yml", "utf8");

  assert.match(workflow, /export DRONE_PULL_REQUEST="\$CI_COMMIT_PULL_REQUEST"/);
  assert.match(workflow, /export DRONE_COMMIT_MESSAGE="\$CI_COMMIT_MESSAGE"/);
  assert.match(workflow, /node scripts\/validate-woodpecker-pr-title\.mjs/);
  assert.doesNotMatch(workflow, /DRONE_PULL_REQUEST_TITLE/);
});

test("the validator rejects an auto-merge workflow with an extra command", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release-pr-auto-merge.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "        node scripts/release-pr-auto-merge.mjs\n",
      "        node scripts/release-pr-auto-merge.mjs\n      - echo unexpected\n",
    );
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /execute only the source-controlled validator/i);
  });
});

test("the validator rejects a named token in the PR-capable validate workflow scope", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "validate.yml");
    const workflow = `${readFileSync(workflowPath, "utf8")}\nenvironment:\n  GITHUB_API_TOKEN:\n    from_secret: GITHUB_API_TOKEN\n`;
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /validate workflow must not receive the named GitHub API token secret/i);
  });
});

test("the validator rejects an aliased secret reference in the validate workflow scope", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "validate.yml");
    const workflow = `${readFileSync(workflowPath, "utf8")}\nenvironment:\n  UNTRUSTED_ALIAS:\n    from_secret: GITHUB_API_TOKEN\n`;
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /validate must not reference a secret/i);
  });
});

test("the validator rejects an aliased secret reference in the validate step scope", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "validate.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "    commands:\n",
      "    environment:\n      UNTRUSTED_ALIAS:\n        from_secret: GITHUB_API_TOKEN\n    commands:\n",
    );
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /validate must not reference a secret/i);
  });
});

test("the validator requires the canonical filename-derived workflow mapping", () => {
  withWorkflowFixture((configDirectory) => {
    renameSync(join(configDirectory, "release.yml"), join(configDirectory, "release.yaml"));

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /Woodpecker workflow files must be exactly validate\.yml, release\.yml, and release-pr-auto-merge\.yml/i,
    );
  });
});

test("the validator rejects a cross-workflow dependency that uses a filename extension", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release-pr-auto-merge.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace("- validate\n", "- validate.yml\n");
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /must depend on validate and release workflow filenames/i);
  });
});

test("the validator rejects cross-workflow workspace sharing", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release-pr-auto-merge.yml");
    const workflow = `${readFileSync(workflowPath, "utf8")}\nworkspace: shared-state\n`;
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /must not declare cross-workflow workspace/i);
  });
});

test("the validator rejects cross-workflow artifact sharing", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release-pr-auto-merge.yml");
    const workflow = `${readFileSync(workflowPath, "utf8")}\nartifacts: shared-state\n`;
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /must not declare cross-workflow artifacts/i);
  });
});

test("the validator rejects an additional credential reference in a trusted workflow", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "    environment:\n      GITHUB_API_TOKEN:\n",
      "    environment:\n      ADDITIONAL_CREDENTIAL:\n        from_secret: ADDITIONAL_CREDENTIAL\n      GITHUB_API_TOKEN:\n",
    );
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /must expose only the named GitHub API token secret/i);
  });
});

test("the validator rejects a workflow-level secret reference in the release workflow", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release.yml");
    const workflow = `${readFileSync(workflowPath, "utf8")}\nenvironment:\n  ADDITIONAL_CREDENTIAL:\n    from_secret: ADDITIONAL_CREDENTIAL\n`;
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /release must not reference a secret/i);
  });
});

test("the validator rejects a workflow-level secret reference in the auto-merge workflow", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release-pr-auto-merge.yml");
    const workflow = `${readFileSync(workflowPath, "utf8")}\nenvironment:\n  ADDITIONAL_CREDENTIAL:\n    from_secret: ADDITIONAL_CREDENTIAL\n`;
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /release-pr-auto-merge must not reference a secret/i);
  });
});

test("the validator rejects a secret reference in release step settings", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "    commands:\n",
      "    settings:\n      ADDITIONAL_CREDENTIAL:\n        from_secret: ADDITIONAL_CREDENTIAL\n    commands:\n",
    );
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /github-release must not reference a secret/i);
  });
});

test("the validator rejects a secret reference in auto-merge step settings", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release-pr-auto-merge.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "    commands:\n",
      "    settings:\n      ADDITIONAL_CREDENTIAL:\n        from_secret: ADDITIONAL_CREDENTIAL\n    commands:\n",
    );
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /release-pr-auto-merge must not reference a secret/i);
  });
});

test("the validator rejects an injected command in the release eligibility block", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "        esac\n",
      "        esac\n        echo unexpected\n",
    );
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /release-pr must execute only the source-controlled parity command/i);
  });
});

test("the validator rejects an extra github-release command", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "  - name: release-pr\n",
      "      - echo unexpected\n  - name: release-pr\n",
    );
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /github-release must execute only the source-controlled parity command/i);
  });
});

for (const { workflowFilename, stepName } of [
  { workflowFilename: "validate.yml", stepName: "validate" },
  { workflowFilename: "release.yml", stepName: "github-release" },
  { workflowFilename: "release.yml", stepName: "release-pr" },
  { workflowFilename: "release-pr-auto-merge.yml", stepName: "merge-release-pr" },
]) {
  test(`the validator rejects a step-level when condition on ${stepName}`, () => {
    withWorkflowFixture((configDirectory) => {
      const workflowPath = join(configDirectory, workflowFilename);
      const workflow = readFileSync(workflowPath, "utf8").replace(
        `  - name: ${stepName}\n`,
        `  - name: ${stepName}\n    when:\n      branch: disabled\n`,
      );
      writeFileSync(workflowPath, workflow);

      const result = validate(configDirectory);

      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, new RegExp(`${stepName} must not declare a step-level when condition`, "i"));
    });
  });
}

for (const workflowFilename of ["validate.yml", "release.yml", "release-pr-auto-merge.yml"]) {
  test(`the validator rejects an extra global when predicate in ${workflowFilename}`, () => {
    withWorkflowFixture((configDirectory) => {
      const workflowPath = join(configDirectory, workflowFilename);
      const workflow = readFileSync(workflowPath, "utf8").replace(
        "    branch: main\n",
        "    branch: main\n    path: docs/**\n",
      );
      writeFileSync(workflowPath, workflow);

      const result = validate(configDirectory);

      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /global when condition must declare only event and branch/i);
    });
  });
}

test("the validator rejects a comma-serialized validate event", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "validate.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "  - event: [push, pull_request]\n",
      "  - event: pull_request,push\n",
    );
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /validate must run only for push and pull_request/i);
  });
});

test("the validator rejects a comma-serialized auto-merge dependency", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "release-pr-auto-merge.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "depends_on:\n  - validate\n  - release\n",
      "depends_on:\n  - release,validate\n",
    );
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /must depend on validate and release workflow filenames/i);
  });
});

test("the validator rejects a step-level failure override", () => {
  withWorkflowFixture((configDirectory) => {
    const workflowPath = join(configDirectory, "validate.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "    commands:\n",
      "    failure: ignore\n    commands:\n",
    );
    writeFileSync(workflowPath, workflow);

    const result = validate(configDirectory);

    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /must not override default step failure handling/i);
  });
});
