#!/usr/bin/env node
// ---
// relationships:
//   packages: apps/server
//   reuses:
//     - scripts/lib/resolve-catalog.ts
//     - scripts/lib/brand-assets.ts
//   used_by: .github/fork/build-release.sh
// ---
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../scripts/lib/resolve-catalog.ts";
import { bundleNodePty } from "./bundle-node-pty.mjs";
import { packDirectory } from "./pack-directory.mjs";
import { isForkVersion } from "./version.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const serverDirectory = path.join(repoRoot, "apps/server");
const requireFromScripts = createRequire(path.join(repoRoot, "scripts/package.json"));
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

const outputDirectory = path.resolve(outputDirectoryArgument);
const nodePtyPrebuild = path.resolve(nodePtyPrebuildArgument);
const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "t3-fork-package-"));

try {
  const serverPackage = JSON.parse(
    await fs.readFile(path.join(serverDirectory, "package.json"), "utf8"),
  );
  const workspace = parseYaml(
    await fs.readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  const requiredBuildAssets = [
    "dist/bin.mjs",
    "dist/service-launcher.mjs",
    "dist/client/index.html",
  ];

  for (const relativePath of requiredBuildAssets) {
    await fs.access(path.join(serverDirectory, relativePath));
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

  await fs.cp(path.join(serverDirectory, "dist"), path.join(stagingDirectory, "dist"), {
    recursive: true,
  });
  await fs.copyFile(path.join(repoRoot, "LICENSE"), path.join(stagingDirectory, "LICENSE"));
  await fs.writeFile(
    path.join(stagingDirectory, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await bundleNodePty({
    sourceDirectory: await fs.realpath(path.join(serverDirectory, "node_modules/node-pty")),
    packageDirectory: stagingDirectory,
    prebuildPath: nodePtyPrebuild,
  });

  const brand = resolveWebAssetBrandForPackageVersion(version);
  for (const override of resolveWebIconOverrides(brand, "dist/client")) {
    await fs.copyFile(
      path.join(repoRoot, override.sourceRelativePath),
      path.join(stagingDirectory, override.targetRelativePath),
    );
  }

  await fs.mkdir(outputDirectory, { recursive: true });
  const packedPath = packDirectory(stagingDirectory, outputDirectory);

  const expectedFilename = `t3-${version}.tgz`;
  if (path.basename(packedPath) !== expectedFilename) {
    throw new Error(
      `Packed filename '${path.basename(packedPath)}' does not match '${expectedFilename}'.`,
    );
  }

  console.log(packedPath);
} finally {
  await fs.rm(stagingDirectory, { recursive: true, force: true });
}
