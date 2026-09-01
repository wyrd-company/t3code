#!/usr/bin/env node
// ---
// relationships:
//   packages: apps/server
//   reuses:
//     - scripts/lib/resolve-catalog.ts
//     - scripts/lib/brand-assets.ts
//   used_by: .github/fork/build-release.sh
// ---
import { spawnSync } from "node:child_process";
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

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const serverDirectory = path.join(repoRoot, "apps/server");
const requireFromScripts = createRequire(path.join(repoRoot, "scripts/package.json"));
const { parse: parseYaml } = requireFromScripts("yaml");
const [version, outputDirectoryArgument] = process.argv.slice(2);

if (!version || !outputDirectoryArgument) {
  console.error("Usage: pack-server.mjs <fork-version> <output-directory>");
  process.exit(2);
}

if (!/^\d+\.\d+\.\d+-wyrd\.\d+$/.test(version)) {
  console.error(`Fork version must match <semver>-wyrd.<number>: ${version}`);
  process.exit(1);
}

const outputDirectory = path.resolve(outputDirectoryArgument);
const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "t3-fork-package-"));

try {
  const serverPackage = JSON.parse(
    await fs.readFile(path.join(serverDirectory, "package.json"), "utf8"),
  );
  const workspace = parseYaml(await fs.readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"));
  const requiredBuildAssets = ["dist/bin.mjs", "dist/service-launcher.mjs", "dist/client/index.html"];

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

  const brand = resolveWebAssetBrandForPackageVersion(version);
  for (const override of resolveWebIconOverrides(brand, "dist/client")) {
    await fs.copyFile(
      path.join(repoRoot, override.sourceRelativePath),
      path.join(stagingDirectory, override.targetRelativePath),
    );
  }

  await fs.mkdir(outputDirectory, { recursive: true });
  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--pack-destination", outputDirectory],
    { cwd: stagingDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );

  if (packed.status !== 0) {
    process.exit(packed.status ?? 1);
  }

  const packResult = JSON.parse(packed.stdout);
  if (!Array.isArray(packResult) || packResult.length !== 1 || !packResult[0]?.filename) {
    throw new Error(`Unexpected npm pack result: ${packed.stdout}`);
  }

  const expectedFilename = `t3-${version}.tgz`;
  if (packResult[0].filename !== expectedFilename) {
    throw new Error(
      `Packed filename '${packResult[0].filename}' does not match '${expectedFilename}'.`,
    );
  }

  console.log(path.join(outputDirectory, expectedFilename));
} finally {
  await fs.rm(stagingDirectory, { recursive: true, force: true });
}
