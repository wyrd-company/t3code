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
import { packDirectory } from "./pack-directory.mjs";
import { isForkVersion } from "./version.mjs";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(scriptDirectory, "../..");
const serverDirectory = NodePath.join(repoRoot, "apps/server");
const requireFromScripts = NodeModule.createRequire(
  NodePath.join(repoRoot, "scripts/package.json"),
);
const { parse: parseYaml } = requireFromScripts("yaml");
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
    "dist/service-launcher.mjs",
    "dist/client/index.html",
  ];

  for (const relativePath of requiredBuildAssets) {
    await NodeFSP.access(NodePath.join(serverDirectory, relativePath));
  }

  const packageJson = {
    name: serverPackage.name,
    version,
    license: serverPackage.license,
    repository: serverPackage.repository,
    bin: serverPackage.bin,
    type: serverPackage.type,
    engines: serverPackage.engines,
    files: ["dist", "LICENSE"],
    bundledDependencies: ["node-pty"],
    dependencies: resolveCatalogDependencies(
      serverPackage.dependencies,
      workspace.catalog ?? {},
      "apps/server",
    ),
    overrides: resolveCatalogDependencies(
      workspace.overrides ?? {},
      workspace.catalog ?? {},
      "apps/server",
    ),
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
