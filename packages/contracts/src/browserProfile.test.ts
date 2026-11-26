import { describe, expect, it } from "@effect/vitest";

import {
  type AgentBrowserProfileGrant,
  agentBrowserProfileGrantKey,
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  isAgentBrowserProfileGranted,
  resolveBrowserProfiles,
  type BrowserProfile,
} from "./browserProfile.ts";

const work: BrowserProfile = { id: "profile-work", name: "Work", kind: "persistent" };

describe("resolveBrowserProfiles", () => {
  it("drops stored entries that collide with a built-in id", () => {
    const resolved = resolveBrowserProfiles([
      { id: DEFAULT_BROWSER_PROFILE_ID, name: "Hijacked", kind: "persistent" },
      { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Not incognito", kind: "persistent" },
      work,
    ]);

    expect(resolved).toEqual([...BUILT_IN_BROWSER_PROFILES, work]);
  });
});

describe("resolveBrowserProfiles normalization", () => {
  it("reports a custom incognito profile as persistent", () => {
    const resolved = resolveBrowserProfiles([
      { id: "throwaway", name: "Throwaway", kind: "incognito" },
    ]);

    expect(resolved.find((profile) => profile.id === "throwaway")).toEqual({
      id: "throwaway",
      name: "Throwaway",
      kind: "persistent",
    });
  });
});

describe("isAgentBrowserProfileGranted", () => {
  const caller = {
    profileId: "profile-work",
    threadId: "thread-1",
    projectId: "project-1",
    providerInstanceId: "claude",
  };
  const grants = (grant: AgentBrowserProfileGrant) => ({
    [agentBrowserProfileGrantKey(grant)]: grant,
  });

  it.each([
    ["thread", "thread-1", true],
    ["thread", "thread-2", false],
    ["project", "project-1", true],
    ["project", "thread-1", false],
    ["providerInstance", "claude", true],
    ["providerInstance", "codex", false],
  ] as const)("a %s grant for %s covers the caller: %s", (scope, scopeId, granted) => {
    const grant = { profileId: "profile-work", scope, scopeId };
    expect(isAgentBrowserProfileGranted(grants(grant), caller)).toBe(granted);
    // A grant names one profile; the caller's other profiles stay closed.
    expect(
      isAgentBrowserProfileGranted(grants(grant), { ...caller, profileId: "profile-client" }),
    ).toBe(false);
  });
});
