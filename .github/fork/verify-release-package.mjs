#!/usr/bin/env node
// ---
// relationships:
//   verifies: apps/server
//   used_by: .github/fork/build-release.sh
// ---

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { isForkVersion } from "./version.mjs";

const [tarballArgument, version] = process.argv.slice(2);

if (!tarballArgument || !version || !isForkVersion(version)) {
  console.error("Usage: verify-release-package.mjs <tarball> <fork-version>");
  process.exit(2);
}

const tarball = NodePath.resolve(tarballArgument);
const listing = NodeChildProcess.spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
NodeAssert.equal(listing.status, 0, listing.stderr);
const entries = new Set(listing.stdout.split("\n").filter(Boolean));

for (const requiredEntry of [
  "package/LICENSE",
  "package/dist/bin.mjs",
  "package/dist/client/index.html",
  "package/dist/resource-monitor/linux-x64/t3-resource-monitor",
  "package/dist/claude-history-worker.mjs",
  "package/node_modules/node-pty/prebuilds/linux-x64/pty.node",
  "package/node_modules/@ff-labs/fff-node/package.json",
  "package/package.json",
]) {
  NodeAssert.ok(entries.has(requiredEntry), `Release tarball is missing ${requiredEntry}.`);
}

const manifestResult = NodeChildProcess.spawnSync(
  "tar",
  ["-xOf", tarball, "package/package.json"],
  { encoding: "utf8" },
);
NodeAssert.equal(manifestResult.status, 0, manifestResult.stderr);
const manifest = JSON.parse(manifestResult.stdout);
NodeAssert.equal(manifest.name, "t3");
NodeAssert.equal(manifest.version, version);
// node-pty for its Debian prebuild; fff and its closure because upstream
// patches fff-node and npm installs nothing below a bundled package.
for (const name of [
  "node-pty",
  "@ff-labs/fff-node",
  "@ff-labs/fff-bin-linux-x64-gnu",
  "ffi-rs",
  "@yuuang/ffi-rs-linux-x64-gnu",
]) {
  NodeAssert.ok(
    manifest.bundledDependencies.includes(name),
    `Release manifest does not bundle ${name}.`,
  );
}
for (const name of manifest.bundledDependencies) {
  NodeAssert.ok(
    entries.has(`package/node_modules/${name}/package.json`),
    `Release tarball bundles ${name} in name only.`,
  );
  NodeAssert.equal(
    typeof manifest.dependencies[name],
    "string",
    `Bundled ${name} is not declared as a dependency.`,
  );
}

// The bundle requires this package through createRequire, which only the
// patched copy exports; the registry copy fails at startup.
const fffNodeResult = NodeChildProcess.spawnSync(
  "tar",
  ["-xOf", tarball, "package/node_modules/@ff-labs/fff-node/package.json"],
  { encoding: "utf8" },
);
NodeAssert.equal(fffNodeResult.status, 0, fffNodeResult.stderr);
NodeAssert.equal(
  typeof JSON.parse(fffNodeResult.stdout).exports?.["."]?.require,
  "string",
  "Bundled @ff-labs/fff-node does not export a require entry.",
);
// npm refuses a manifest whose overrides use pnpm's selector or removal forms.
const assertNpmOverrides = (overrides, path = []) => {
  for (const [key, value] of Object.entries(overrides)) {
    NodeAssert.ok(!key.includes(">"), `Override ${[...path, key].join("/")} uses a pnpm selector.`);
    if (typeof value === "object") assertNpmOverrides(value, [...path, key]);
    else NodeAssert.notEqual(value, "-", `Override ${[...path, key].join("/")} is a pnpm removal.`);
  }
};
assertNpmOverrides(manifest.overrides ?? {});

for (const [name, spec] of Object.entries(manifest.dependencies)) {
  NodeAssert.equal(
    typeof spec === "string" && spec.startsWith("catalog:"),
    false,
    `Dependency ${name} retains a workspace catalog spec.`,
  );
}

console.log("PASS release-package-has-required-metadata-and-linux-assets");
