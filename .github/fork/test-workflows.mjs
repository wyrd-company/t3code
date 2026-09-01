#!/usr/bin/env node
// ---
// relationships:
//   verifies:
//     - .github/workflows/fork-ci.yml
//     - .github/workflows/fork-release.yml
// ---

import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(scriptDirectory, "../..");
const requireFromScripts = NodeModule.createRequire(
  NodePath.join(repoRoot, "scripts/package.json"),
);
const { parse: parseYaml } = requireFromScripts("yaml");

function readWorkflow(filename) {
  return parseYaml(
    NodeFS.readFileSync(NodePath.join(repoRoot, ".github/workflows", filename), "utf8"),
  );
}

function stepsFor(workflow, jobName) {
  return workflow.jobs[jobName].steps;
}

function findStep(steps, name) {
  const step = steps.find((candidate) => candidate.name === name);
  NodeAssert.ok(step, `Missing workflow step: ${name}`);
  return step;
}

function assertUbuntuLatest(workflow) {
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    NodeAssert.equal(job["runs-on"], "ubuntu-latest", `${jobName} must use ubuntu-latest`);
  }
}

const ci = readWorkflow("fork-ci.yml");
NodeAssert.deepEqual(ci.on.push.branches, ["mcp-external-registration"]);
NodeAssert.deepEqual(ci.on.pull_request.branches, ["mcp-external-registration"]);
NodeAssert.equal(ci.permissions.contents, "read");
assertUbuntuLatest(ci);

const ciSteps = stepsFor(ci, "verify");
NodeAssert.equal(findStep(ciSteps, "Checkout").with["fetch-depth"], 0);
for (const [name, command] of [
  ["Check", "vp check"],
  ["Typecheck", "vpr typecheck"],
  ["Test server", "vp run --filter t3 test"],
  ["Build server", "vp run --filter t3 build"],
]) {
  NodeAssert.equal(findStep(ciSteps, name).run, command);
}
NodeAssert.equal(findStep(ciSteps, "Check fork boundary").run, ".github/fork/check-allowlist.sh");
NodeAssert.match(findStep(ciSteps, "Verify upstream base pin").run, /verify-upstream-base-pin\.sh/);
NodeAssert.equal(
  findStep(ciSteps, "Verify upstream base pin").env.GITHUB_TOKEN,
  "${{ github.token }}",
);
NodeAssert.equal(findStep(ciSteps, "Test fork tooling").run, ".github/fork/test.sh");

const release = readWorkflow("fork-release.yml");
NodeAssert.deepEqual(release.on.push.tags, ["server/*-wyrd.*"]);
NodeAssert.equal(release.permissions.contents, "write");
assertUbuntuLatest(release);

const releaseJob = release.jobs.release;
NodeAssert.equal(releaseJob.environment, undefined);
NodeAssert.equal(releaseJob.env.T3CODE_RELAY_URL, "${{ vars.T3CODE_RELAY_URL }}");
NodeAssert.equal(
  releaseJob.env.T3CODE_CLERK_PUBLISHABLE_KEY,
  "${{ vars.T3CODE_CLERK_PUBLISHABLE_KEY }}",
);
NodeAssert.equal(
  releaseJob.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
  "${{ vars.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID }}",
);
for (const name of [
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
]) {
  NodeAssert.equal(releaseJob.env[name], `\${{ vars.${name} }}`);
}
NodeAssert.equal(
  releaseJob.env.T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE,
  "${{ vars.T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE }}",
);

const releaseSteps = stepsFor(release, "release");
NodeAssert.equal(findStep(releaseSteps, "Checkout").with["fetch-depth"], 0);
NodeAssert.match(findStep(releaseSteps, "Resolve release version").run, /release-version\.mjs/);
NodeAssert.equal(
  findStep(releaseSteps, "Check fork boundary").run,
  ".github/fork/check-allowlist.sh",
);
NodeAssert.match(findStep(releaseSteps, "Build release tarball").run, /build-release\.sh/);
NodeAssert.equal(
  findStep(releaseSteps, "Build release tarball").env.GITHUB_TOKEN,
  "${{ github.token }}",
);
NodeAssert.match(
  findStep(releaseSteps, "Verify clean local install").run,
  /t3 v\$EXPECTED_VERSION/,
);
NodeAssert.match(findStep(releaseSteps, "Publish GitHub Release").run, /gh release create/);
NodeAssert.match(
  findStep(releaseSteps, "Verify anonymous release install").run,
  /node:24-bookworm-slim/,
);
NodeAssert.match(
  findStep(releaseSteps, "Verify anonymous release install").run,
  /t3 v\$EXPECTED_VERSION/,
);

console.log("PASS fork-workflows-match-trigger-build-and-release-contracts");
