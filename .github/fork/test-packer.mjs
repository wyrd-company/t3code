#!/usr/bin/env node
// ---
// relationships:
//   verifies: .github/fork/pack-directory.mjs
// ---

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { bundleNodePty } from "./bundle-node-pty.mjs";
import { packDirectory } from "./pack-directory.mjs";

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "t3-fork-packer-test-"));

try {
  const packageDirectory = path.join(fixtureRoot, "package");
  const outputDirectory = path.join(fixtureRoot, "output");
  const nodePtySource = path.join(fixtureRoot, "node-pty-source");
  const nodePtyPrebuild = path.join(fixtureRoot, "pty.node");
  await fs.mkdir(packageDirectory);
  await fs.mkdir(outputDirectory);
  await fs.mkdir(path.join(nodePtySource, "build", "Release"), { recursive: true });
  await fs.mkdir(path.join(nodePtySource, "lib"));
  await fs.writeFile(
    path.join(nodePtySource, "package.json"),
    `${JSON.stringify({ name: "node-pty", version: "1.2.3" })}\n`,
  );
  await fs.writeFile(path.join(nodePtySource, "build", "Release", "pty.node"), "host\n");
  await fs.writeFile(path.join(nodePtySource, "lib", "index.js"), "module.exports = {}\n");
  await fs.writeFile(nodePtyPrebuild, "debian\n");
  await bundleNodePty({
    sourceDirectory: nodePtySource,
    packageDirectory,
    prebuildPath: nodePtyPrebuild,
  });
  await fs.writeFile(
    path.join(packageDirectory, "package.json"),
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
  await fs.writeFile(path.join(packageDirectory, "payload.txt"), "payload\n");

  const packedPath = packDirectory(packageDirectory, outputDirectory);
  assert.equal(path.basename(packedPath), "generic-package-1.2.3.tgz");

  const manifest = spawnSync("tar", ["-xOf", packedPath, "package/package.json"], {
    encoding: "utf8",
  });
  assert.equal(manifest.status, 0, manifest.stderr);
  assert.equal(JSON.parse(manifest.stdout).overrides["parent-package>child-package"], "-");
  const bundledPrebuild = spawnSync(
    "tar",
    ["-xOf", packedPath, "package/node_modules/node-pty/prebuilds/linux-x64/pty.node"],
    { encoding: "utf8" },
  );
  assert.equal(bundledPrebuild.status, 0, bundledPrebuild.stderr);
  assert.equal(bundledPrebuild.stdout, "debian\n");
  const bundledHostBuild = spawnSync(
    "tar",
    ["-tzf", packedPath, "package/node_modules/node-pty/build/Release/pty.node"],
    { encoding: "utf8" },
  );
  assert.notEqual(bundledHostBuild.status, 0);

  console.log("PASS packer-bundles-only-the-debian-node-pty-prebuild");
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
