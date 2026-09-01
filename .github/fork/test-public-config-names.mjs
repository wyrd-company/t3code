#!/usr/bin/env node
// ---
// relationships:
//   verifies:
//     - .github/fork/public-config.mjs
//     - apps/server/vite.config.ts
// ---

import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { PUBLIC_CONFIG_NAMES } from "./public-config.mjs";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const viteConfig = NodeFS.readFileSync(
  NodePath.resolve(scriptDirectory, "../../apps/server/vite.config.ts"),
  "utf8",
);
const consumedNames = [...viteConfig.matchAll(/repoEnv\.(T3CODE_[A-Z0-9_]+)/g)].map(
  (match) => match[1],
);
NodeAssert.deepEqual([...PUBLIC_CONFIG_NAMES].sort(), [...new Set(consumedNames)].sort());
console.log("PASS public-config-producer-names-match-vite-consumers");
