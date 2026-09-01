#!/usr/bin/env node
// ---
// relationships:
//   uses: .github/fork/public-config.mjs
//   used_by:
//     - .github/fork/build-release.sh
//     - .github/fork/assert-build-config.sh
// ---

import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

import { extractPublicConfig, PUBLIC_CONFIG_NAMES } from "./public-config.mjs";

const [upstreamBundle, overridesPath, format = "json"] = NodeProcess.argv.slice(2);
if (!upstreamBundle || !overridesPath || !["json", "env0"].includes(format)) {
  throw new Error(
    "Usage: resolve-public-config.mjs <upstream-bundle> <overrides-json> [json|env0]",
  );
}

const upstream = extractPublicConfig(NodeFS.readFileSync(upstreamBundle, "utf8"));
const overrides = JSON.parse(NodeFS.readFileSync(overridesPath, "utf8"));
const divergences = [];
for (const [name, value] of Object.entries(upstream)) {
  if (value.trim() === "")
    throw new Error(`Upstream derived public configuration is empty: ${name}`);
}
for (const name of Object.keys(overrides)) {
  if (!PUBLIC_CONFIG_NAMES.includes(name))
    throw new Error(`Unknown public configuration override: ${name}`);
  if (typeof overrides[name] !== "string" || overrides[name].trim() === "") {
    throw new Error(`Public configuration override is empty: ${name}`);
  }
  if (overrides[name] !== upstream[name]) {
    divergences.push(name);
    NodeProcess.stderr.write(
      `WARNING: ${name} overrides upstream value ${JSON.stringify(upstream[name])} with ${JSON.stringify(overrides[name])}.\n`,
    );
  }
}
if (divergences.length > 0 && NodeProcess.env.T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE !== "1") {
  throw new Error(
    `Public configuration divergence requires T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE=1: ${divergences.join(", ")}`,
  );
}

const effective = Object.fromEntries(
  PUBLIC_CONFIG_NAMES.map((name) => [name, overrides[name] ?? upstream[name]]),
);
if (format === "json") {
  NodeProcess.stdout.write(`${JSON.stringify(effective, null, 2)}\n`);
} else {
  for (const name of PUBLIC_CONFIG_NAMES) NodeProcess.stdout.write(`${name}\0${effective[name]}\0`);
}
