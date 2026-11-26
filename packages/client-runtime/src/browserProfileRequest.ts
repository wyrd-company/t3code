import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { AgentBrowserProfileGrantScope, OrchestrationV2TurnItem } from "@t3tools/contracts";

export type BrowserProfileRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "browser_profile_request" }
>;

export type BrowserProfileRequestDisplay =
  | { readonly kind: "pending" }
  /** Inherited by a fork: only the thread that asked can answer it. */
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | { readonly kind: "answered"; readonly approved: boolean; readonly label: string };

const ALLOW_LABELS: Record<AgentBrowserProfileGrantScope, string> = {
  thread: msg("Allow for this thread"),
  project: msg("Allow for this project"),
  providerInstance: msg("Allow for this provider"),
};

const ALLOWED_LABELS: Record<AgentBrowserProfileGrantScope, string> = {
  thread: msg("Allowed for this thread"),
  project: msg("Allowed for this project"),
  providerInstance: msg("Allowed for this provider"),
};

/** Narrowest first; the card offers them in this order. */
export const BROWSER_PROFILE_GRANT_SCOPES: ReadonlyArray<AgentBrowserProfileGrantScope> = [
  "thread",
  "project",
  "providerInstance",
];

/** The card's button that approves at `scope`. */
export const browserProfileAllowLabel = (
  scope: AgentBrowserProfileGrantScope,
  resolve: MFunctionType = mFallback,
): string => resolve(ALLOW_LABELS[scope]);

export function browserProfileRequestDisplay(
  item: Pick<BrowserProfileRequestItem, "accessStatus" | "grantScope">,
  visibility: "local" | "inherited" | "synthetic",
  resolve: MFunctionType = mFallback,
): BrowserProfileRequestDisplay {
  switch (item.accessStatus) {
    case "pending":
      return visibility === "local"
        ? { kind: "pending" }
        : { kind: "pending-elsewhere", label: resolve(msg("Waiting in the original thread")) };
    case "approved":
      return {
        kind: "answered",
        approved: true,
        label: resolve(
          item.grantScope === undefined
            ? msg("Allowed", { $context: "permission state" })
            : ALLOWED_LABELS[item.grantScope],
        ),
      };
    case "declined":
      return { kind: "answered", approved: false, label: resolve(msg("Declined")) };
    case "cancelled":
      return { kind: "answered", approved: false, label: resolve(msg("Closed without an answer")) };
  }
}

export function browserProfileRequestFailureMessage(
  failure: unknown,
  resolve: MFunctionType = mFallback,
): string {
  return typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "BrowserProfileRequestError" &&
    "message" in failure &&
    typeof failure.message === "string"
    ? failure.message
    : resolve(msg("Could not send your answer. Try again."));
}
