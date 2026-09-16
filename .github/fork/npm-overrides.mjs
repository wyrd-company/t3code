// ---
// relationships:
//   used_by:
//     - .github/fork/pack-server.mjs
//     - .github/fork/test-packer.mjs
// ---

/**
 * The workspace's pnpm overrides in npm's overrides format.
 *
 * pnpm selects a transitive edge as `parent>child`; npm nests the child under
 * the parent. pnpm removes an edge with `-`; npm has no removal, and an npm
 * client refuses to install a package whose manifest carries either form, so
 * removals are dropped rather than carried as a spec npm cannot read.
 */
export function toNpmOverrides(overrides) {
  const result = {};
  for (const [selector, spec] of Object.entries(overrides)) {
    if (spec === "-") continue;
    const path = selector.split(">");
    let cursor = result;
    for (const name of path.slice(0, -1)) {
      const existing = cursor[name];
      cursor[name] = typeof existing === "object" ? existing : existing ? { ".": existing } : {};
      cursor = cursor[name];
    }
    const leaf = path.at(-1);
    cursor[leaf] = typeof cursor[leaf] === "object" ? { ...cursor[leaf], ".": spec } : spec;
  }
  return result;
}
