import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";
import { AgentBrowserProfileGrantScope } from "./browserProfile.ts";

/** Approving saves a grant at `scope`, so later tabs there need no card. */
export const BrowserProfileRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("approve"), scope: AgentBrowserProfileGrantScope }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type BrowserProfileRequestAnswerInput = typeof BrowserProfileRequestAnswerInput.Type;

/** What the agent reads when its card ends without approval. */
export const BROWSER_PROFILE_REQUEST_UNAPPROVED_NOTE = {
  declined:
    'The user declined this profile for this run. For Incognito, call preview_open with profileId "incognito" and reuseExistingTab=false, or go on without it.',
  cancelled:
    "The card closed with the run. Ask again in a later run only if the profile is needed.",
  timed_out:
    'No answer in time. For Incognito, call preview_open with profileId "incognito" and reuseExistingTab=false, or say what is blocked.',
} as const;

const BROWSER_PROFILE_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the browser profile request.",
  not_found: "This browser profile request no longer exists.",
  already_answered: "This browser profile request was already answered.",
  agent_stopped: "The agent that asked has stopped.",
  save_failed: "Could not save the approval. Try again.",
  record_failed: "Could not record your answer.",
} as const;

export class BrowserProfileRequestError extends Schema.TaggedError<BrowserProfileRequestError>()(
  "BrowserProfileRequestError",
  {
    reason: Schema.Literals(
      Object.keys(BROWSER_PROFILE_REQUEST_FAILURE_MESSAGES) as Array<
        keyof typeof BROWSER_PROFILE_REQUEST_FAILURE_MESSAGES
      >,
    ),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return BROWSER_PROFILE_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
