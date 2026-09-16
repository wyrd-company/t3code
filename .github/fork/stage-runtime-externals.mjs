// ---
// relationships:
//   mirrors: scripts/build-cli-archive.ts
//   used_by:
//     - .github/fork/pack-server.mjs
//     - .github/fork/test-packer.mjs
// ---
//
// Runtime dependencies the bundle loads by name and upstream patches through
// pnpm. A consumer's npm installs the registry copy, without the patch, and
// npm installs nothing below a bundled package, so the package ships the
// whole closure the way upstream's CLI archive does: a hoisted, symlink-free
// pnpm install of exactly these packages, then every top-level result is
// bundled.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const PATCHED_RUNTIME_EXTERNALS = ["@ff-labs/fff-node"];

const packageNameOfPatchKey = (patchKey) => {
  const separator = patchKey.lastIndexOf("@");
  return separator > 0 ? patchKey.slice(0, separator) : patchKey;
};

/** The stage manifest and workspace config for Linux x64, derived from the server's own. */
export function planRuntimeExternals({ serverDependencies, patchedDependencies, overrides }) {
  const dependencies = {};
  for (const name of PATCHED_RUNTIME_EXTERNALS) {
    const version = serverDependencies[name];
    if (version === undefined) {
      throw new Error(`apps/server does not depend on ${name}; nothing to stage.`);
    }
    dependencies[name] = version;
  }
  // fff resolves its platform binary from an optional dependency of its own;
  // both Linux x64 libcs ship, as in upstream's archive.
  const fffVersion = dependencies["@ff-labs/fff-node"];
  dependencies["@ff-labs/fff-bin-linux-x64-gnu"] = fffVersion;
  dependencies["@ff-labs/fff-bin-linux-x64-musl"] = fffVersion;
  const stagePatches = Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, packageNameOfPatchKey(patchKey)),
    ),
  );
  return {
    manifest: { name: "t3-runtime-externals", version: "0.0.0", private: true, dependencies },
    workspace: {
      nodeLinker: "hoisted",
      supportedArchitectures: { os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
      patchedDependencies: stagePatches,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    },
  };
}

/** Every top-level package under a node_modules directory, scoped ones included, with its version. */
export async function collectStagedPackages(nodeModulesDirectory) {
  const packages = {};
  for (const entry of await NodeFSP.readdir(nodeModulesDirectory)) {
    if (entry.startsWith(".")) continue;
    const names = entry.startsWith("@")
      ? (await NodeFSP.readdir(NodePath.join(nodeModulesDirectory, entry))).map(
          (scoped) => `${entry}/${scoped}`,
        )
      : [entry];
    for (const name of names) {
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(nodeModulesDirectory, name, "package.json"), "utf8"),
      );
      packages[name] = manifest.version;
    }
  }
  return packages;
}

const removeNestedBinDirectories = async (root) => {
  for (const entry of await NodeFSP.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = NodePath.join(root, entry.name);
    if (entry.name === ".bin") await NodeFSP.rm(child, { recursive: true, force: true });
    else await removeNestedBinDirectories(child);
  }
};

const toYaml = (value, indent = "") =>
  Object.entries(value)
    .map(([key, entry]) =>
      Array.isArray(entry)
        ? `${indent}${key}:\n${entry.map((item) => `${indent}  - ${JSON.stringify(item)}`).join("\n")}`
        : typeof entry === "object"
          ? `${indent}${JSON.stringify(key)}:\n${toYaml(entry, `${indent}  `)}`
          : `${indent}${JSON.stringify(key)}: ${JSON.stringify(entry)}`,
    )
    .join("\n");

/**
 * Installs the runtime externals into `stageDirectory/node_modules` and
 * returns the packages to bundle. `install` runs the package manager; the
 * default is pnpm, whose patch support is the reason this exists.
 */
export async function stageRuntimeExternals({
  repoRoot,
  stageDirectory,
  serverDependencies,
  patchedDependencies,
  overrides,
  // Quiet on success: the packer's stdout is the packed path and nothing else.
  install = (cwd) => {
    const result = NodeChildProcess.spawnSync("pnpm", ["install", "--prod"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(
        `pnpm install --prod (runtime externals) failed:\n${result.stdout}${result.stderr}`,
      );
    }
  },
}) {
  const plan = planRuntimeExternals({ serverDependencies, patchedDependencies, overrides });
  await NodeFSP.mkdir(stageDirectory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(stageDirectory, "package.json"),
    `${JSON.stringify(plan.manifest, null, 2)}\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(stageDirectory, "pnpm-workspace.yaml"),
    `${toYaml(plan.workspace)}\n`,
  );
  for (const patchPath of Object.values(plan.workspace.patchedDependencies)) {
    const target = NodePath.join(stageDirectory, patchPath);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.copyFile(NodePath.join(repoRoot, patchPath), target);
  }
  await install(stageDirectory);
  const nodeModulesDirectory = NodePath.join(stageDirectory, "node_modules");
  for (const entry of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "patches",
    "node_modules/.pnpm",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm-workspace-state-v1.json",
  ]) {
    await NodeFSP.rm(NodePath.join(stageDirectory, entry), { recursive: true, force: true });
  }
  if (NodeFS.existsSync(nodeModulesDirectory))
    await removeNestedBinDirectories(nodeModulesDirectory);
  return collectStagedPackages(nodeModulesDirectory);
}
