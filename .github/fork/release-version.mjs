#!/usr/bin/env node
// ---
// relationships:
//   uses: .github/fork/version.mjs
//   used_by: .github/workflows/fork-release.yml
// ---

import { parseServerTag } from "./version.mjs";

const [tag] = process.argv.slice(2);
const version = tag && parseServerTag(tag);

if (!version) {
  console.error(`Server release tag must match server/<semver>-wyrd.<number>: ${tag ?? ""}`);
  process.exit(1);
}

console.log(version);
