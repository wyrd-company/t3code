#!/usr/bin/env node
// ---
// relationships:
//   extracts_from: apps/server/dist/bin.mjs
//   used_by:
//     - .github/fork/build-release.sh
//     - .github/fork/assert-build-config.sh
//     - .github/fork/test.sh
// ---

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

export const PUBLIC_CONFIG_NAMES = [
  "T3CODE_RELAY_URL",
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
];

function exactlyOneMatch(source, name, pattern) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) throw new Error(`Missing public configuration anchor: ${name}`);
  if (matches.length > 1) throw new Error(`Duplicate public configuration anchor: ${name}`);
  return matches[0][1];
}

function exactlyOne(source, name, pattern) {
  return JSON.parse(exactlyOneMatch(source, name, pattern));
}

export function extractPublicConfig(source) {
  const tracing = exactlyOneMatch(
    source,
    "buildTimeRelayClientTracing",
    /const buildTimeRelayClientTracing\s*=\s*\{([\s\S]*?)\n\};/g,
  );
  return {
    T3CODE_RELAY_URL: exactlyOne(
      source,
      "buildTimeRelayUrl",
      /const buildTimeRelayUrl\s*=\s*normalizeSecureRelayUrl\(("(?:[^"\\]|\\.)*")\)\s*\?\?\s*"";/g,
    ),
    T3CODE_CLERK_PUBLISHABLE_KEY: exactlyOne(
      source,
      "buildTimeClerkPublishableKey",
      /const buildTimeClerkPublishableKey\s*=\s*readBuildTimeValue\(("(?:[^"\\]|\\.)*")\);/g,
    ),
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: exactlyOne(
      source,
      "buildTimeClerkCliOAuthClientId",
      /const buildTimeClerkCliOAuthClientId\s*=\s*readBuildTimeValue\(("(?:[^"\\]|\\.)*")\);/g,
    ),
    T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: exactlyOne(
      tracing,
      "buildTimeRelayClientTracing.tracesUrl",
      /\btracesUrl:\s*readBuildTimeValue\(("(?:[^"\\]|\\.)*")\)/g,
    ),
    T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: exactlyOne(
      tracing,
      "buildTimeRelayClientTracing.tracesDataset",
      /\btracesDataset:\s*readBuildTimeValue\(("(?:[^"\\]|\\.)*")\)/g,
    ),
    T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: exactlyOne(
      tracing,
      "buildTimeRelayClientTracing.tracesToken",
      /\btracesToken:\s*readBuildTimeValue\(("(?:[^"\\]|\\.)*")\)/g,
    ),
  };
}

function extractPackage(version, bundleOutput) {
  const temporaryDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-public-config-"),
  );
  try {
    const result = NodeChildProcess.spawnSync(
      "npm",
      ["pack", `t3@${version}`, "--pack-destination", temporaryDirectory, "--silent"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`Failed to fetch t3@${version}: ${result.stderr.trim()}`);
    }
    const tarball = NodePath.join(temporaryDirectory, result.stdout.trim().split(/\r?\n/).at(-1));
    const unpack = NodeChildProcess.spawnSync("tar", ["-xzf", tarball, "-C", temporaryDirectory], {
      encoding: "utf8",
    });
    if (unpack.status !== 0)
      throw new Error(`Failed to unpack t3@${version}: ${unpack.stderr.trim()}`);
    const bundlePath = NodePath.join(temporaryDirectory, "package/dist/bin.mjs");
    const source = NodeFS.readFileSync(bundlePath, "utf8");
    if (bundleOutput) NodeFS.copyFileSync(bundlePath, bundleOutput);
    return extractPublicConfig(source);
  } finally {
    NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function emit(config, format) {
  if (format === "json") {
    NodeProcess.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }
  if (format === "env0") {
    for (const name of PUBLIC_CONFIG_NAMES) NodeProcess.stdout.write(`${name}\0${config[name]}\0`);
    return;
  }
  throw new Error(`Unknown output format: ${format}`);
}

function main() {
  const [sourceKind, sourceValue, ...options] = NodeProcess.argv.slice(2);
  const formatIndex = options.indexOf("--format");
  const bundleOutputIndex = options.indexOf("--bundle-output");
  const useOverrides = options.includes("--overrides");
  const format = formatIndex === -1 ? "json" : options[formatIndex + 1];
  const bundleOutput = bundleOutputIndex === -1 ? undefined : options[bundleOutputIndex + 1];
  if (!sourceValue || !["bundle", "package"].includes(sourceKind)) {
    throw new Error(
      "Usage: public-config.mjs <bundle path|package version> [--format json|env0] [--bundle-output path]",
    );
  }
  const derivedConfig =
    sourceKind === "bundle"
      ? extractPublicConfig(NodeFS.readFileSync(sourceValue, "utf8"))
      : extractPackage(sourceValue, bundleOutput);
  const config = useOverrides
    ? Object.fromEntries(
        PUBLIC_CONFIG_NAMES.map((name) => [
          name,
          NodeProcess.env[name] ? NodeProcess.env[name] : derivedConfig[name],
        ]),
      )
    : derivedConfig;
  emit(config, format);
}

if (NodeProcess.argv[1] === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) main();
