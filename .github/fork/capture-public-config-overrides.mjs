#!/usr/bin/env node
// ---
// relationships:
//   uses: .github/fork/public-config.mjs
//   used_by: .github/fork/build-release.sh
// ---

import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

import { PUBLIC_CONFIG_NAMES } from "./public-config.mjs";

const [outputPath] = NodeProcess.argv.slice(2);
if (!outputPath) throw new Error("Usage: capture-public-config-overrides.mjs <output-path>");

const overrides = Object.fromEntries(
  PUBLIC_CONFIG_NAMES.filter((name) => NodeProcess.env[name]).map((name) => [
    name,
    NodeProcess.env[name],
  ]),
);
NodeFS.writeFileSync(outputPath, `${JSON.stringify(overrides, null, 2)}\n`);
