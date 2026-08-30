import assert from "node:assert/strict";
import test from "node:test";

import { validateWoodpeckerPullRequestTitle } from "./validate-woodpecker-pr-title.mjs";

const pullRequestEnvironment = {
  CI_PIPELINE_EVENT: "pull_request",
  CI_REPO: "jurislm/jurislm-tools",
  CI_COMMIT_PULL_REQUEST: "268",
};

function response({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

test("validates a Woodpecker PR title from the public metadata endpoint", async () => {
  const requests = [];
  let requestOptions;
  const result = await validateWoodpeckerPullRequestTitle({
    env: pullRequestEnvironment,
    fetchImpl: async (url, options) => {
      requests.push(url);
      requestOptions = options;
      return response({ body: { title: "feat(ci): add Woodpecker source parity" } });
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(requests, ["https://api.github.com/repos/jurislm/jurislm-tools/pulls/268"]);
  assert.ok(requestOptions.signal);
  assert.equal(Object.hasOwn(requestOptions, "headers"), false);
});

test("skips the Woodpecker PR title lookup for a push", async () => {
  let fetched = false;
  const result = await validateWoodpeckerPullRequestTitle({
    env: { CI_PIPELINE_EVENT: "push" },
    fetchImpl: async () => {
      fetched = true;
      throw new Error("push must not fetch PR metadata");
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(fetched, false);
});

test("rejects a PR title that violates the existing title contract", async () => {
  const result = await validateWoodpeckerPullRequestTitle({
    env: pullRequestEnvironment,
    fetchImpl: async () => response({ body: { title: "style: repaint the button" } }),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /permitted/i);
});

test("fails closed when public PR metadata is unavailable", async () => {
  const result = await validateWoodpeckerPullRequestTitle({
    env: pullRequestEnvironment,
    fetchImpl: async () => response({ ok: false, status: 503 }),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /HTTP 503/i);
});

test("fails closed when public PR metadata omits the title", async () => {
  const result = await validateWoodpeckerPullRequestTitle({
    env: pullRequestEnvironment,
    fetchImpl: async () => response({ body: {} }),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /did not contain a title/i);
});

test("fails closed before fetching when Woodpecker metadata is incomplete", async () => {
  let fetched = false;
  const result = await validateWoodpeckerPullRequestTitle({
    env: { CI_PIPELINE_EVENT: "pull_request", CI_REPO: "jurislm/jurislm-tools" },
    fetchImpl: async () => {
      fetched = true;
      throw new Error("incomplete metadata must not fetch");
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(fetched, false);
  assert.match(result.message, /CI_COMMIT_PULL_REQUEST/i);
});

test("fails closed before fetching for an unexpected repository", async () => {
  let fetched = false;
  const result = await validateWoodpeckerPullRequestTitle({
    env: { ...pullRequestEnvironment, CI_REPO: "other/repository" },
    fetchImpl: async () => {
      fetched = true;
      throw new Error("unexpected repository must not fetch");
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(fetched, false);
  assert.match(result.message, /CI_REPO/i);
});
