import { fileURLToPath } from "node:url";

import { checkPullRequestTitle } from "./validate-pr-title.mjs";

const REPOSITORY = "jurislm/jurislm-tools";
const REQUEST_TIMEOUT_MS = 10_000;

function failure(message) {
  return { exitCode: 1, message: `Woodpecker PR title validation failed: ${message}` };
}

/**
 * Validates the existing PR-title policy with metadata available to a
 * Woodpecker pull-request workflow, without introducing a credential.
 */
export async function validateWoodpeckerPullRequestTitle({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (env.CI_PIPELINE_EVENT !== "pull_request") {
    return {
      exitCode: 0,
      message: "Not a Woodpecker pull-request build; skipping PR title lookup.",
    };
  }

  if (env.CI_REPO !== REPOSITORY) {
    return failure(`unexpected CI_REPO ${JSON.stringify(env.CI_REPO ?? "")}`);
  }

  const pullRequest = env.CI_COMMIT_PULL_REQUEST ?? "";
  if (!/^[1-9]\d*$/.test(pullRequest)) {
    return failure("CI_COMMIT_PULL_REQUEST must be a positive pull-request number");
  }

  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${REPOSITORY}/pulls/${pullRequest}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) return failure(`public PR metadata request returned HTTP ${response.status}`);

    const metadata = await response.json();
    if (typeof metadata?.title !== "string") {
      return failure("public PR metadata response did not contain a title");
    }

    return checkPullRequestTitle({
      DRONE_PULL_REQUEST: pullRequest,
      DRONE_PULL_REQUEST_TITLE: metadata.title,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown request error";
    return failure(`public PR metadata request failed: ${detail}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await validateWoodpeckerPullRequestTitle();
  console.log(result.message);
  process.exitCode = result.exitCode;
}
