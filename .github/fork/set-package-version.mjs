#!/usr/bin/env node
// ---
// relationships:
//   modifies_temporarily: apps/server/package.json
//   used_by: .github/fork/build-release.sh
// ---
import fs from "node:fs/promises";

import { isForkVersion } from "./version.mjs";

const [packagePath, version] = process.argv.slice(2);

if (!packagePath || !version) {
  console.error("Usage: set-package-version.mjs <package.json> <version>");
  process.exit(2);
}

if (!isForkVersion(version)) {
  console.error(`Fork version must match <semver>-wyrd.<number>: ${version}`);
  process.exit(1);
}

const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
packageJson.version = version;
await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
