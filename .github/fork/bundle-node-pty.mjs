// ---
// relationships:
//   used_by:
//     - .github/fork/pack-server.mjs
//     - .github/fork/test-packer.mjs
// ---

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export async function bundleNodePty({ sourceDirectory, packageDirectory, prebuildPath }) {
  const targetDirectory = NodePath.join(packageDirectory, "node_modules", "node-pty");
  const targetPrebuild = NodePath.join(targetDirectory, "prebuilds", "linux-x64", "pty.node");

  await NodeFSP.cp(sourceDirectory, targetDirectory, { recursive: true, dereference: true });
  await NodeFSP.rm(NodePath.join(targetDirectory, "build"), { recursive: true, force: true });
  await NodeFSP.rm(NodePath.dirname(targetPrebuild), { recursive: true, force: true });
  await NodeFSP.mkdir(NodePath.dirname(targetPrebuild), { recursive: true });
  await NodeFSP.copyFile(prebuildPath, targetPrebuild);
  await NodeFSP.chmod(targetPrebuild, 0o755);
}
