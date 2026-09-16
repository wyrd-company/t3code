#!/usr/bin/env node
// ---
// relationships:
//   extracts_from:
//     - apps/server/dist/bin.mjs
//     - "@t3code/t3-linux-x64"
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

// The public `t3` package is a launcher that spawns a platform executable from
// `@t3code/t3-<platform>-<arch>`. The server bundle, with its build-time
// configuration, is embedded in that executable as plain text. Linux x64 is
// read whatever the host is: every platform package carries the same values,
// and Linux x64 is what this fork ships.
const UPSTREAM_EXECUTABLE_PACKAGE = "@t3code/t3-linux-x64";

function extractPackage(version, bundleOutput) {
  const spec = `${UPSTREAM_EXECUTABLE_PACKAGE}@${version}`;
  const temporaryDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-public-config-"),
  );
  try {
    const result = NodeChildProcess.spawnSync(
      NodeProcess.env.NPM_COMMAND ?? "npm",
      ["pack", spec, "--pack-destination", temporaryDirectory, "--json"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`Failed to fetch ${spec}: ${result.stderr.trim()}`);
    }
    const packResult = JSON.parse(result.stdout);
    if (!Array.isArray(packResult) || packResult.length !== 1 || !packResult[0]?.filename) {
      throw new Error(`Unexpected npm pack response for ${spec}`);
    }
    const tarball = NodePath.join(temporaryDirectory, packResult[0].filename);
    const unpack = NodeChildProcess.spawnSync("tar", ["-xzf", tarball, "-C", temporaryDirectory], {
      encoding: "utf8",
    });
    if (unpack.status !== 0) throw new Error(`Failed to unpack ${spec}: ${unpack.stderr.trim()}`);
    const executablePath = NodePath.join(temporaryDirectory, "package/t3");
    // latin1: the anchors are ASCII and the file is mostly not text.
    const source = NodeFS.readFileSync(executablePath, "latin1");
    if (bundleOutput) NodeFS.copyFileSync(executablePath, bundleOutput);
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
  if (formatIndex !== -1 && !options[formatIndex + 1]) {
    throw new Error("Missing value for --format");
  }
  if (bundleOutputIndex !== -1 && !options[bundleOutputIndex + 1]) {
    throw new Error("Missing value for --bundle-output");
  }
  const format = formatIndex === -1 ? "json" : options[formatIndex + 1];
  const bundleOutput = bundleOutputIndex === -1 ? undefined : options[bundleOutputIndex + 1];
  if (!sourceValue || !["bundle", "package"].includes(sourceKind)) {
    throw new Error(
      "Usage: public-config.mjs <bundle path|package version> [--format json|env0] [--bundle-output path]",
    );
  }
  const config =
    sourceKind === "bundle"
      ? extractPublicConfig(NodeFS.readFileSync(sourceValue, "utf8"))
      : extractPackage(sourceValue, bundleOutput);
  emit(config, format);
}

if (NodeProcess.argv[1] === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) main();
