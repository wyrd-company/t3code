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
  "package/dist/service-launcher.mjs",
  "package/node_modules/node-pty/prebuilds/linux-x64/pty.node",
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
NodeAssert.deepEqual(manifest.bundledDependencies, ["node-pty"]);
for (const [name, spec] of Object.entries(manifest.dependencies)) {
  NodeAssert.equal(
    typeof spec === "string" && spec.startsWith("catalog:"),
    false,
    `Dependency ${name} retains a workspace catalog spec.`,
  );
}

console.log("PASS release-package-has-required-metadata-and-linux-assets");
