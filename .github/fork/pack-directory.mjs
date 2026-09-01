// ---
// relationships:
//   used_by:
//     - .github/fork/pack-server.mjs
//     - .github/fork/test-packer.mjs
// ---

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

export function packDirectory(packageDirectory, outputDirectory) {
  const packed = NodeChildProcess.spawnSync(
    "pnpm",
    ["pack", "--config.node-linker=hoisted", "--json", "--pack-destination", outputDirectory],
    {
      cwd: packageDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  if (packed.error) throw packed.error;
  if (packed.status !== 0) {
    throw new Error(
      `pnpm pack failed with exit code ${packed.status ?? "unknown"}: ${packed.stdout}`,
    );
  }

  const packResult = JSON.parse(packed.stdout);
  if (
    !packResult ||
    Array.isArray(packResult) ||
    typeof packResult !== "object" ||
    typeof packResult.filename !== "string" ||
    packResult.filename.length === 0
  ) {
    throw new Error(`Unexpected pnpm pack result: ${packed.stdout}`);
  }

  return NodePath.resolve(packageDirectory, packResult.filename);
}
