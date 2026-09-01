#!/usr/bin/env node
// ---
// relationships:
//   verifies: .github/fork/verify-release-package.mjs
// ---

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const verifier = NodePath.join(scriptDirectory, "verify-release-package.mjs");
const fixtureRoot = await NodeFSP.mkdtemp(
  NodePath.join(NodeOS.tmpdir(), "t3-fork-release-verifier-test-"),
);
const packageRoot = NodePath.join(fixtureRoot, "package");

try {
  const requiredFiles = [
    "LICENSE",
    "dist/bin.mjs",
    "dist/client/index.html",
    "dist/resource-monitor/linux-x64/t3-resource-monitor",
    "dist/service-launcher.mjs",
    "node_modules/node-pty/prebuilds/linux-x64/pty.node",
  ];
  for (const relativePath of requiredFiles) {
    const target = NodePath.join(packageRoot, relativePath);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, "fixture\n");
  }
  await NodeFSP.writeFile(
    NodePath.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "t3",
      version: "0.0.37-wyrd.1",
      dependencies: { "generic-dependency": "1.2.3" },
      bundledDependencies: ["node-pty"],
    })}\n`,
  );

  const validTarball = NodePath.join(fixtureRoot, "valid.tgz");
  const validPack = NodeChildProcess.spawnSync(
    "tar",
    ["-czf", validTarball, "-C", fixtureRoot, "package"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(validPack.status, 0, validPack.stderr);
  const validResult = NodeChildProcess.spawnSync(
    process.execPath,
    [verifier, validTarball, "0.0.37-wyrd.1"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(validResult.status, 0, validResult.stderr);

  await NodeFSP.rm(
    NodePath.join(packageRoot, "dist/resource-monitor/linux-x64/t3-resource-monitor"),
  );
  const invalidTarball = NodePath.join(fixtureRoot, "missing-monitor.tgz");
  const invalidPack = NodeChildProcess.spawnSync(
    "tar",
    ["-czf", invalidTarball, "-C", fixtureRoot, "package"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(invalidPack.status, 0, invalidPack.stderr);
  const invalidResult = NodeChildProcess.spawnSync(
    process.execPath,
    [verifier, invalidTarball, "0.0.37-wyrd.1"],
    { encoding: "utf8" },
  );
  NodeAssert.notEqual(invalidResult.status, 0);

  console.log("PASS release-package-verifier-rejects-missing-linux-resource-monitor");
} finally {
  await NodeFSP.rm(fixtureRoot, { recursive: true, force: true });
}
