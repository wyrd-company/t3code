#!/usr/bin/env node
// ---
// relationships:
//   packages: apps/server
//   reuses:
//     - scripts/lib/resolve-catalog.ts
//     - scripts/lib/brand-assets.ts
//   used_by: .github/fork/build-release.sh
// ---
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../scripts/lib/resolve-catalog.ts";
import { bundleNodePty } from "./bundle-node-pty.mjs";
import { stageRuntimeExternals } from "./stage-runtime-externals.mjs";
import { packDirectory } from "./pack-directory.mjs";
import { isForkVersion } from "./version.mjs";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(scriptDirectory, "../..");
const serverDirectory = NodePath.join(repoRoot, "apps/server");
const requireFromServer = NodeModule.createRequire(NodePath.join(serverDirectory, "package.json"));
const { parse: parseYaml } = requireFromServer("yaml");
const [version, outputDirectoryArgument, nodePtyPrebuildArgument] = process.argv.slice(2);

if (!version || !outputDirectoryArgument || !nodePtyPrebuildArgument) {
  console.error("Usage: pack-server.mjs <fork-version> <output-directory> <node-pty-prebuild>");
  process.exit(2);
}

if (!isForkVersion(version)) {
  console.error(`Fork version must match <semver>-wyrd.<number>: ${version}`);
  process.exit(1);
}

const outputDirectory = NodePath.resolve(outputDirectoryArgument);
const nodePtyPrebuild = NodePath.resolve(nodePtyPrebuildArgument);
const stagingDirectory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-package-"));

try {
  const serverPackage = JSON.parse(
    await NodeFSP.readFile(NodePath.join(serverDirectory, "package.json"), "utf8"),
  );
  const workspace = parseYaml(
    await NodeFSP.readFile(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  const requiredBuildAssets = [
    "dist/bin.mjs",
    "dist/claude-history-worker.mjs",
    "dist/client/index.html",
  ];

  for (const relativePath of requiredBuildAssets) {
    await NodeFSP.access(NodePath.join(serverDirectory, relativePath));
  }

  const serverDependencies = resolveCatalogDependencies(
    serverPackage.dependencies,
    workspace.catalog ?? {},
    "apps/server",
  );
  const overrides = resolveCatalogDependencies(
    workspace.overrides ?? {},
    workspace.catalog ?? {},
    "apps/server",
  );
  const runtimeExternals = await stageRuntimeExternals({
    repoRoot,
    stageDirectory: NodePath.join(stagingDirectory, "runtime-externals"),
    serverDependencies,
    patchedDependencies: workspace.patchedDependencies ?? {},
    overrides,
  });

  // Bundled packages must also be declared, at the version that was staged.
  const packageJson = {
    name: serverPackage.name,
    version,
    license: serverPackage.license,
    repository: serverPackage.repository,
    bin: serverPackage.bin,
    type: serverPackage.type,
    engines: serverPackage.engines,
    files: ["dist", "LICENSE"],
    bundledDependencies: ["node-pty", ...Object.keys(runtimeExternals)],
    dependencies: { ...serverDependencies, ...runtimeExternals },
    overrides,
  };

  await NodeFSP.cp(
    NodePath.join(serverDirectory, "dist"),
    NodePath.join(stagingDirectory, "dist"),
    {
      recursive: true,
    },
  );
  await NodeFSP.copyFile(
    NodePath.join(repoRoot, "LICENSE"),
    NodePath.join(stagingDirectory, "LICENSE"),
  );
  await NodeFSP.writeFile(
    NodePath.join(stagingDirectory, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await bundleNodePty({
    sourceDirectory: await NodeFSP.realpath(
      NodePath.join(serverDirectory, "node_modules/node-pty"),
    ),
    packageDirectory: stagingDirectory,
    prebuildPath: nodePtyPrebuild,
  });
  for (const name of Object.keys(runtimeExternals)) {
    await NodeFSP.cp(
      NodePath.join(stagingDirectory, "runtime-externals", "node_modules", name),
      NodePath.join(stagingDirectory, "node_modules", name),
      { recursive: true },
    );
  }
  await NodeFSP.rm(NodePath.join(stagingDirectory, "runtime-externals"), {
    recursive: true,
    force: true,
  });

  const brand = resolveWebAssetBrandForPackageVersion(version);
  for (const override of resolveWebIconOverrides(brand, "dist/client")) {
    await NodeFSP.copyFile(
      NodePath.join(repoRoot, override.sourceRelativePath),
      NodePath.join(stagingDirectory, override.targetRelativePath),
    );
  }

  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  const packedPath = packDirectory(stagingDirectory, outputDirectory);

  const expectedFilename = `t3-${version}.tgz`;
  if (NodePath.basename(packedPath) !== expectedFilename) {
    throw new Error(
      `Packed filename '${NodePath.basename(packedPath)}' does not match '${expectedFilename}'.`,
    );
  }

  console.log(packedPath);
} finally {
  await NodeFSP.rm(stagingDirectory, { recursive: true, force: true });
}
