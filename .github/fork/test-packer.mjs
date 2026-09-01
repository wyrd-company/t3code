#!/usr/bin/env node
// ---
// relationships:
//   verifies: .github/fork/pack-directory.mjs
// ---

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { bundleNodePty } from "./bundle-node-pty.mjs";
import { packDirectory } from "./pack-directory.mjs";

const fixtureRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-packer-test-"));

try {
  const packageDirectory = NodePath.join(fixtureRoot, "package");
  const outputDirectory = NodePath.join(fixtureRoot, "output");
  const nodePtySource = NodePath.join(fixtureRoot, "node-pty-source");
  const nodePtyPrebuild = NodePath.join(fixtureRoot, "pty.node");
  await NodeFSP.mkdir(packageDirectory);
  await NodeFSP.mkdir(outputDirectory);
  await NodeFSP.mkdir(NodePath.join(nodePtySource, "build", "Release"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(nodePtySource, "lib"));
  await NodeFSP.writeFile(
    NodePath.join(nodePtySource, "package.json"),
    `${JSON.stringify({ name: "node-pty", version: "1.2.3" })}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(nodePtySource, "build", "Release", "pty.node"), "host\n");
  await NodeFSP.writeFile(NodePath.join(nodePtySource, "lib", "index.js"), "module.exports = {}\n");
  await NodeFSP.writeFile(nodePtyPrebuild, "debian\n");
  await bundleNodePty({
    sourceDirectory: nodePtySource,
    packageDirectory,
    prebuildPath: nodePtyPrebuild,
  });
  await NodeFSP.writeFile(
    NodePath.join(packageDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "generic-package",
        version: "1.2.3",
        files: ["payload.txt"],
        dependencies: { "node-pty": "1.2.3" },
        bundledDependencies: ["node-pty"],
        overrides: { "parent-package>child-package": "-" },
      },
      null,
      2,
    )}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(packageDirectory, "payload.txt"), "payload\n");

  const packedPath = packDirectory(packageDirectory, outputDirectory);
  NodeAssert.equal(NodePath.basename(packedPath), "generic-package-1.2.3.tgz");

  const manifest = NodeChildProcess.spawnSync("tar", ["-xOf", packedPath, "package/package.json"], {
    encoding: "utf8",
  });
  NodeAssert.equal(manifest.status, 0, manifest.stderr);
  NodeAssert.equal(JSON.parse(manifest.stdout).overrides["parent-package>child-package"], "-");
  const bundledPrebuild = NodeChildProcess.spawnSync(
    "tar",
    ["-xOf", packedPath, "package/node_modules/node-pty/prebuilds/linux-x64/pty.node"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(bundledPrebuild.status, 0, bundledPrebuild.stderr);
  NodeAssert.equal(bundledPrebuild.stdout, "debian\n");
  const bundledHostBuild = NodeChildProcess.spawnSync(
    "tar",
    ["-tzf", packedPath, "package/node_modules/node-pty/build/Release/pty.node"],
    { encoding: "utf8" },
  );
  NodeAssert.notEqual(bundledHostBuild.status, 0);

  console.log("PASS packer-bundles-only-the-debian-node-pty-prebuild");
} finally {
  await NodeFSP.rm(fixtureRoot, { recursive: true, force: true });
}
