// ---
// relationships:
//   used_by:
//     - .github/fork/pack-server.mjs
//     - .github/fork/test-packer.mjs
// ---

import fs from "node:fs/promises";
import path from "node:path";

export async function bundleNodePty({ sourceDirectory, packageDirectory, prebuildPath }) {
  const targetDirectory = path.join(packageDirectory, "node_modules", "node-pty");
  const targetPrebuild = path.join(targetDirectory, "prebuilds", "linux-x64", "pty.node");

  await fs.cp(sourceDirectory, targetDirectory, { recursive: true, dereference: true });
  await fs.rm(path.join(targetDirectory, "build"), { recursive: true, force: true });
  await fs.rm(path.dirname(targetPrebuild), { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetPrebuild), { recursive: true });
  await fs.copyFile(prebuildPath, targetPrebuild);
  await fs.chmod(targetPrebuild, 0o755);
}
