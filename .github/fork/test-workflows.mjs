#!/usr/bin/env node
// ---
// relationships:
//   verifies:
//     - .github/workflows/fork-ci.yml
//     - .github/workflows/fork-release.yml
// ---

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const requireFromScripts = createRequire(path.join(repoRoot, "scripts/package.json"));
const { parse: parseYaml } = requireFromScripts("yaml");

function readWorkflow(filename) {
  return parseYaml(fs.readFileSync(path.join(repoRoot, ".github/workflows", filename), "utf8"));
}

function stepsFor(workflow, jobName) {
  return workflow.jobs[jobName].steps;
}

function findStep(steps, name) {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `Missing workflow step: ${name}`);
  return step;
}

function assertUbuntuLatest(workflow) {
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-latest", `${jobName} must use ubuntu-latest`);
  }
}

const ci = readWorkflow("fork-ci.yml");
assert.deepEqual(ci.on.push.branches, ["mcp-external-registration"]);
assert.deepEqual(ci.on.pull_request.branches, ["mcp-external-registration"]);
assert.equal(ci.permissions.contents, "read");
assertUbuntuLatest(ci);

const ciSteps = stepsFor(ci, "verify");
assert.equal(findStep(ciSteps, "Checkout").with["fetch-depth"], 0);
for (const [name, command] of [
  ["Check", "vp check"],
  ["Typecheck", "vpr typecheck"],
  ["Test server", "vp run --filter t3 test"],
  ["Build server", "vp run --filter t3 build"],
]) {
  assert.equal(findStep(ciSteps, name).run, command);
}
assert.equal(findStep(ciSteps, "Check fork boundary").run, ".github/fork/check-allowlist.sh");
assert.equal(findStep(ciSteps, "Test fork tooling").run, ".github/fork/test.sh");

const release = readWorkflow("fork-release.yml");
assert.deepEqual(release.on.push.tags, ["server/*-wyrd.*"]);
assert.equal(release.permissions.contents, "write");
assertUbuntuLatest(release);

const releaseJob = release.jobs.release;
assert.equal(releaseJob.environment, undefined);
assert.equal(releaseJob.env.T3CODE_RELAY_URL, "${{ vars.T3CODE_RELAY_URL }}");
assert.equal(
  releaseJob.env.T3CODE_CLERK_PUBLISHABLE_KEY,
  "${{ vars.T3CODE_CLERK_PUBLISHABLE_KEY }}",
);
assert.equal(
  releaseJob.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
  "${{ vars.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID }}",
);

const releaseSteps = stepsFor(release, "release");
assert.equal(findStep(releaseSteps, "Checkout").with["fetch-depth"], 0);
assert.match(findStep(releaseSteps, "Resolve release version").run, /release-version\.mjs/);
assert.equal(findStep(releaseSteps, "Check fork boundary").run, ".github/fork/check-allowlist.sh");
assert.match(findStep(releaseSteps, "Build release tarball").run, /build-release\.sh/);
assert.match(findStep(releaseSteps, "Verify clean local install").run, /t3 v\$EXPECTED_VERSION/);
assert.match(findStep(releaseSteps, "Publish GitHub Release").run, /gh release create/);
assert.match(
  findStep(releaseSteps, "Verify anonymous release install").run,
  /node:24-bookworm-slim/,
);
assert.match(
  findStep(releaseSteps, "Verify anonymous release install").run,
  /t3 v\$EXPECTED_VERSION/,
);

console.log("PASS fork-workflows-match-trigger-build-and-release-contracts");
