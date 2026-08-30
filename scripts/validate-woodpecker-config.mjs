import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const configDirectory = process.argv[2] ?? ".woodpecker";
const expectedWorkflows = new Map([
  ["validate.yml", "validate"],
  ["release.yml", "release"],
  ["release-pr-auto-merge.yml", "release-pr-auto-merge"],
]);
const releasePleaseArguments = [
  "--token=$GITHUB_API_TOKEN",
  "--repo-url=https://github.com/jurislm/jurislm-tools",
  "--target-branch=main",
  "--config-file=release-please-config.json",
  "--manifest-file=.release-please-manifest.json",
].join(" ");
const expectedGithubReleaseCommand =
  `npx --yes release-please@17.10.4 github-release ${releasePleaseArguments}`;
const expectedReleasePrCommand = [
  'export DRONE_REPO="$CI_REPO"',
  'export DRONE_BRANCH="$CI_COMMIT_BRANCH"',
  'export DRONE_COMMIT="$CI_COMMIT_SHA"',
  "set +e",
  "node scripts/release-eligibility.mjs",
  "eligibility_status=$?",
  "set -e",
  'case "$eligibility_status" in',
  "  0)",
  `    npx --yes release-please@17.10.4 release-pr ${releasePleaseArguments}`,
  "    ;;",
  "  10)",
  '    echo "release-pr skipped: no feat/fix commit in the unreleased range"',
  "    ;;",
  "  *)",
  '    exit "$eligibility_status"',
  "    ;;",
  "esac",
].join("\n");
const errors = [];

function requireValue(condition, message) {
  if (!condition) errors.push(message);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function eventList(value) {
  if (typeof value === "string") return [value];
  return list(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function sameStrings(actual, expected) {
  return [...actual].sort().join(",") === [...expected].sort().join(",");
}

function readWorkflow(filename) {
  const path = join(configDirectory, filename);
  if (!existsSync(path)) {
    errors.push(`${filename}: missing expected Woodpecker workflow file`);
    return {};
  }
  const documents = parseAllDocuments(readFileSync(path, "utf8"));

  for (const document of documents) {
    if (document.errors.length > 0) {
      errors.push(...document.errors.map((error) => `${filename}: invalid YAML: ${error.message}`));
    }
  }

  requireValue(documents.length === 1, `${filename} must contain exactly one workflow document`);
  const workflow = documents.length === 1 ? documents[0].toJSON() : undefined;
  requireValue(
    workflow !== null && typeof workflow === "object" && !Array.isArray(workflow),
    `${filename} must define a workflow object`,
  );
  return workflow ?? {};
}

function requireMainEvents(workflow, name, events) {
  const conditions = list(workflow.when);
  requireValue(conditions.length === 1, `${name} must contain exactly one global when condition`);
  const condition = conditions[0] ?? {};
  requireValue(
    sameStrings(eventList(condition.event), events),
    `${name} must run only for ${events.join(" and ")}`,
  );
  requireValue(condition.branch === "main", `${name} must target main`);
}

function requireNoCrossWorkflowState(workflow, name) {
  for (const key of ["workspace", "artifacts"]) {
    requireValue(!hasOwn(workflow, key), `${name} must not declare cross-workflow ${key}`);
  }

  for (const step of list(workflow.steps)) {
    for (const key of ["workspace", "artifacts"]) {
      requireValue(!hasOwn(step, key), `${name} must not declare cross-workflow ${key}`);
    }
  }
}

function requireDefaultStepFailureHandling(workflow, name) {
  for (const step of list(workflow.steps)) {
    requireValue(
      !hasOwn(step, "failure"),
      `${name} must not override default step failure handling`,
    );
  }
}

function hasSecretReference(value) {
  if (Array.isArray(value)) return value.some(hasSecretReference);
  if (value === null || typeof value !== "object") return false;

  return Object.entries(value).some(
    ([key, nestedValue]) => key === "from_secret" || hasSecretReference(nestedValue),
  );
}

function requireNoSecretReferences(workflow, name) {
  requireValue(!hasSecretReference(workflow), `${name} must not reference a secret`);
}

function requireNoWorkflowSecretReferences(workflow, name) {
  requireNoSecretReferences({ ...workflow, steps: [] }, name);
}

function requireNamedSecret(step, stepName) {
  const environment = step?.environment ?? {};
  requireValue(
    sameStrings(Object.keys(environment), ["GITHUB_API_TOKEN"]) &&
      environment.GITHUB_API_TOKEN?.from_secret === "GITHUB_API_TOKEN",
    `${stepName} must expose only the named GitHub API token secret`,
  );
}

function requireOnlyNamedSecret(step, stepName) {
  requireNamedSecret(step, stepName);
  const stepWithoutNamedSecret = { ...step, environment: { ...(step?.environment ?? {}) } };
  delete stepWithoutNamedSecret.environment.GITHUB_API_TOKEN;
  requireNoSecretReferences(stepWithoutNamedSecret, stepName);
}

if (!existsSync(configDirectory)) {
  errors.push(`missing Woodpecker workflow directory: ${configDirectory}`);
} else {
  const workflowFiles = readdirSync(configDirectory)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .sort();
  requireValue(
    sameStrings(workflowFiles, [...expectedWorkflows.keys()]),
    "Woodpecker workflow files must be exactly validate.yml, release.yml, and release-pr-auto-merge.yml",
  );

  const workflows = new Map(
    [...expectedWorkflows.entries()].map(([filename, name]) => [name, readWorkflow(filename)]),
  );
  const validate = workflows.get("validate");
  const release = workflows.get("release");
  const autoMerge = workflows.get("release-pr-auto-merge");

  for (const [name, workflow] of workflows) {
    requireValue(!hasOwn(workflow, "name"), `${name} must derive its workflow name from its filename`);
    requireNoCrossWorkflowState(workflow, name);
    requireDefaultStepFailureHandling(workflow, name);
  }

  requireMainEvents(validate, "validate", ["push", "pull_request"]);
  requireNoSecretReferences(validate, "validate");
  requireValue(
    !hasOwn(validate?.environment, "GITHUB_API_TOKEN"),
    "validate workflow must not receive the named GitHub API token secret",
  );
  requireValue(
    list(validate?.depends_on).length === 0,
    "validate must not depend on another workflow",
  );
  const validateSteps = list(validate?.steps);
  const validateStep = validateSteps[0];
  requireValue(validateSteps.length === 1, "validate must contain exactly one validate step");
  requireValue(validateStep?.name === "validate", "validate must name its only step validate");
  requireValue(
    validateStep?.image === "node:22.22.2-bookworm-slim",
    "validate must use the exact supported Node image",
  );
  requireValue(
    !hasOwn(validateStep?.environment, "GITHUB_API_TOKEN"),
    "validate must not receive the named GitHub API token secret",
  );
  const validateCommands = list(validateStep?.commands).map((command) =>
    typeof command === "string" ? command.trim() : command,
  );
  const expectedValidateMetadataBridge = [
    'export DRONE_PULL_REQUEST="$CI_COMMIT_PULL_REQUEST"',
    'export DRONE_COMMIT_MESSAGE="$CI_COMMIT_MESSAGE"',
    "node scripts/validate-woodpecker-pr-title.mjs",
    "node scripts/validate-squash-subject.mjs",
  ].join("\n");
  const expectedValidateCommands = [
    expectedValidateMetadataBridge,
    "apt-get update -qq && apt-get install -y --no-install-recommends git jq shellcheck python3 -qq",
    "npm ci",
    "npm run validate",
  ];
  requireValue(
    sameStrings(validateCommands, expectedValidateCommands),
    "validate must retain the complete source validation command set",
  );
  requireValue(
    validateCommands.indexOf(expectedValidateMetadataBridge) === 0 &&
      validateCommands.indexOf("apt-get update -qq && apt-get install -y --no-install-recommends git jq shellcheck python3 -qq") <
        validateCommands.indexOf("npm ci") &&
      validateCommands.indexOf("npm ci") < validateCommands.indexOf("npm run validate"),
    "validate must bridge Woodpecker metadata before npm ci and npm run validate",
  );

  requireMainEvents(release, "release", ["push"]);
  requireNoWorkflowSecretReferences(release, "release");
  requireValue(list(release?.depends_on).length === 0, "release must not depend on another workflow");
  const releaseSteps = list(release?.steps);
  const githubRelease = releaseSteps[0];
  const releasePr = releaseSteps[1];
  requireValue(releaseSteps.length === 2, "release must contain github-release and release-pr steps");
  requireValue(githubRelease?.name === "github-release", "release must start with github-release");
  requireValue(releasePr?.name === "release-pr", "release must run release-pr second");
  requireValue(
    sameStrings(list(releasePr?.depends_on), ["github-release"]),
    "release-pr must depend on github-release",
  );
  for (const step of [githubRelease, releasePr]) {
    requireValue(
      step?.image === "node:22.22.2-bookworm-slim",
      `${step?.name ?? "release step"} must use the exact supported Node image`,
    );
    requireOnlyNamedSecret(step, step?.name ?? "release step");
  }
  const githubReleaseCommands = list(githubRelease?.commands);
  const githubReleaseCommand = githubReleaseCommands[0] ?? "";
  requireValue(
    githubReleaseCommands.length === 1 && githubReleaseCommand.trim() === expectedGithubReleaseCommand,
    "github-release must execute only the source-controlled parity command",
  );
  const releasePrCommands = list(releasePr?.commands);
  const releasePrCommand = releasePrCommands[0] ?? "";
  requireValue(
    releasePrCommands.length === 1 && releasePrCommand.trim() === expectedReleasePrCommand,
    "release-pr must execute only the source-controlled parity command",
  );

  requireMainEvents(autoMerge, "release-pr-auto-merge", ["push"]);
  requireNoWorkflowSecretReferences(autoMerge, "release-pr-auto-merge");
  requireValue(
    sameStrings(list(autoMerge?.depends_on), ["validate", "release"]),
    "release-pr-auto-merge must depend on validate and release workflow filenames",
  );
  requireValue(autoMerge?.concurrency?.limit === 1, "release-pr-auto-merge must serialize deliveries");
  const autoMergeSteps = list(autoMerge?.steps);
  const autoMergeStep = autoMergeSteps[0];
  requireValue(autoMergeSteps.length === 1, "release-pr-auto-merge must contain one merge step");
  requireValue(
    autoMergeStep?.name === "merge-release-pr",
    "release-pr-auto-merge must name its only step merge-release-pr",
  );
  requireValue(
    autoMergeStep?.image === "node:22.22.2-bookworm-slim",
    "release-pr-auto-merge must use the exact supported Node image",
  );
  requireOnlyNamedSecret(autoMergeStep, "release-pr-auto-merge");
  const autoMergeCommands = list(autoMergeStep?.commands);
  const autoMergeCommand = autoMergeCommands[0] ?? "";
  const expectedAutoMergeCommand = [
    'export DRONE_COMMIT="$CI_COMMIT_SHA"',
    "node scripts/release-pr-auto-merge.mjs",
  ].join("\n");
  requireValue(
    autoMergeCommands.length === 1 && autoMergeCommand.trim() === expectedAutoMergeCommand,
    "release-pr-auto-merge must execute only the source-controlled validator",
  );
}

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`validated ${configDirectory}: validate + release + release-pr-auto-merge`);
