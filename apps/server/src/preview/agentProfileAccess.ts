import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  isAgentBrowserProfileGranted,
  type PreviewSessionSnapshot,
  type ServerSettings,
} from "@t3tools/contracts";

/**
 * Which profiles an agent may read and drive: undefined while approval is off, else a check
 * that takes the profile whose storage a tab uses (null when no grant can cover it). Unreadable
 * settings or an unknown thread allow nothing but Incognito.
 */
export function agentProfilePolicy(
  settings: Pick<
    ServerSettings,
    "requireAgentBrowserProfileApproval" | "agentBrowserProfileGrants"
  > | null,
  thread: { readonly projectId: string; readonly providerInstanceId: string } | null,
  caller: { readonly threadId: string; readonly providerInstanceId?: string | undefined },
): ((profileId: string | null) => boolean) | undefined {
  if (settings?.requireAgentBrowserProfileApproval === false) return undefined;
  return (profileId) =>
    profileId === INCOGNITO_BROWSER_PROFILE_ID ||
    (profileId !== null &&
      settings !== null &&
      thread !== null &&
      isAgentBrowserProfileGranted(settings.agentBrowserProfileGrants, {
        profileId,
        threadId: caller.threadId,
        projectId: thread.projectId,
        // The caller's own provider: the thread may have switched since its call was admitted.
        providerInstanceId: caller.providerInstanceId ?? thread.providerInstanceId,
      }));
}

/**
 * The profile whose storage a tab uses, from its snapshot, or null when no grant can cover it.
 * The server's own Chromium gives an agent tab naming no profile, and every Incognito tab, a
 * context of its own. A desktop draws a tab naming no profile in its own default, which the
 * server cannot name, and keeps one Incognito session that the user's own tabs share.
 */
export function snapshotStorageProfileId(snapshot: PreviewSessionSnapshot): string | null {
  if (snapshot.runtime === "server" && snapshot.headless === true) {
    if (snapshot.profileId === undefined)
      return snapshot.automationOwner === undefined
        ? DEFAULT_BROWSER_PROFILE_ID
        : INCOGNITO_BROWSER_PROFILE_ID;
    return snapshot.profileId;
  }
  return snapshot.profileId === undefined || snapshot.profileId === INCOGNITO_BROWSER_PROFILE_ID
    ? null
    : snapshot.profileId;
}
