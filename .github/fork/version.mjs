// ---
// relationships:
//   used_by:
//     - .github/fork/pack-server.mjs
//     - .github/fork/set-package-version.mjs
//     - .github/fork/release-version.mjs
// ---

export const FORK_VERSION_PATTERN = /^\d+\.\d+\.\d+-wyrd\.\d+$/;

export function isForkVersion(version) {
  return FORK_VERSION_PATTERN.test(version);
}

export function parseServerTag(tag) {
  const prefix = "server/";
  if (!tag.startsWith(prefix)) return null;

  const version = tag.slice(prefix.length);
  return isForkVersion(version) ? version : null;
}
