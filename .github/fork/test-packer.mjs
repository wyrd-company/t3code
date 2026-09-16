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
import {
  collectStagedPackages,
  planRuntimeExternals,
  stageRuntimeExternals,
} from "./stage-runtime-externals.mjs";
import { toNpmOverrides } from "./npm-overrides.mjs";
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

  const plan = planRuntimeExternals({
    serverDependencies: { "@ff-labs/fff-node": "0.9.4", effect: "1.0.0" },
    patchedDependencies: {
      "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
      "effect@1.0.0": "patches/effect@1.0.0.patch",
    },
    overrides: {},
  });
  NodeAssert.deepEqual(plan.manifest.dependencies, {
    "@ff-labs/fff-node": "0.9.4",
    "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
    "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
  });
  NodeAssert.deepEqual(Object.keys(plan.workspace.patchedDependencies), [
    "@ff-labs/fff-node@0.9.4",
  ]);
  NodeAssert.equal(plan.workspace.nodeLinker, "hoisted");
  NodeAssert.throws(
    () => planRuntimeExternals({ serverDependencies: {}, patchedDependencies: {}, overrides: {} }),
    /does not depend on @ff-labs\/fff-node/,
  );
  console.log("PASS runtime-externals-plan-stages-fff-with-its-patch-and-linux-binaries");

  const stageRoot = NodePath.join(fixtureRoot, "stage-root");
  const stageDirectory = NodePath.join(stageRoot, "stage");
  await NodeFSP.mkdir(NodePath.join(stageRoot, "patches"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(stageRoot, "patches", "@ff-labs__fff-node@0.9.4.patch"),
    "patch\n",
  );
  let patchSeenByInstall = false;
  const staged = await stageRuntimeExternals({
    repoRoot: stageRoot,
    stageDirectory,
    serverDependencies: { "@ff-labs/fff-node": "0.9.4" },
    patchedDependencies: { "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch" },
    overrides: {},
    install: async (cwd) => {
      await NodeFSP.access(NodePath.join(cwd, "patches", "@ff-labs__fff-node@0.9.4.patch"));
      patchSeenByInstall = true;
      const modules = NodePath.join(cwd, "node_modules");
      for (const [name, version] of [
        ["@ff-labs/fff-node", "0.9.4"],
        ["ffi-rs", "1.3.2"],
      ]) {
        await NodeFSP.mkdir(NodePath.join(modules, name), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(modules, name, "package.json"),
          `${JSON.stringify({ name, version })}\n`,
        );
      }
      await NodeFSP.mkdir(NodePath.join(modules, ".pnpm"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(modules, "ffi-rs", "node_modules", ".bin"), {
        recursive: true,
      });
      await NodeFSP.writeFile(NodePath.join(modules, ".modules.yaml"), "x\n");
    },
  });
  NodeAssert.ok(patchSeenByInstall);
  NodeAssert.deepEqual(staged, { "@ff-labs/fff-node": "0.9.4", "ffi-rs": "1.3.2" });
  NodeAssert.deepEqual(
    await collectStagedPackages(NodePath.join(stageDirectory, "node_modules")),
    staged,
  );
  for (const gone of [
    "package.json",
    "pnpm-workspace.yaml",
    "patches",
    "node_modules/.pnpm",
    "node_modules/.modules.yaml",
    "node_modules/ffi-rs/node_modules/.bin",
  ]) {
    await NodeAssert.rejects(
      NodeFSP.access(NodePath.join(stageDirectory, gone)),
      `${gone} survived`,
    );
  }
  console.log("PASS runtime-externals-stage-keeps-only-installed-packages");

  NodeAssert.deepEqual(
    toNpmOverrides({
      "generic-lib": "1.2.3",
      "generic-parent>generic-child": "-",
      "generic-parent>@scope/other": "^2.0.0",
      "@scope/tool>vitest": "-",
      "a>b>c": "3.0.0",
    }),
    {
      "generic-lib": "1.2.3",
      "generic-parent": { "@scope/other": "^2.0.0" },
      a: { b: { c: "3.0.0" } },
    },
  );
  console.log("PASS npm-overrides-nest-selectors-and-drop-removals");
} finally {
  await NodeFSP.rm(fixtureRoot, { recursive: true, force: true });
}
