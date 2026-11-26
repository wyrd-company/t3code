import { pipe } from "effect/Function";
import {
  BROWSER_PROFILE_GRANT_SCOPES,
  browserProfileAllowLabel,
  browserProfileRequestDisplay,
  browserProfileRequestFailureMessage,
  type BrowserProfileRequestItem,
} from "@t3tools/client-runtime/browser-profile-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AgentBrowserProfileGrantScope,
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useMessages, Var } from "gt-react";
import { CheckIcon, LockIcon, MinusIcon, UserLockIcon } from "lucide-react";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

export function BrowserProfileRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: BrowserProfileRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const m = useMessages();
  const { item } = props;
  // Held here: a save can fail after the card already reads Allowed, replacing the pending view.
  const [error, setError] = useState<string | null>(null);
  const display = browserProfileRequestDisplay(item, props.visibility, m);
  if (display.kind !== "pending") {
    const Icon =
      display.kind === "pending-elsewhere" ? LockIcon : display.approved ? CheckIcon : MinusIcon;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <WorkLogRow
          data-v2-item-type={item.type}
          icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
          label={
            <>
              <T>
                <Var>{item.profileName}</Var> browser profile
              </T>{" "}
              · {display.label}
            </>
          }
        />
        {error !== null ? (
          <p role="alert" className="pl-5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <PendingBrowserProfileRequest
      environmentId={props.environmentId}
      item={item}
      error={error}
      onError={setError}
    />
  );
}

function PendingBrowserProfileRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly item: BrowserProfileRequestItem;
  readonly error: string | null;
  readonly onError: (error: string | null) => void;
}) {
  const m = useMessages();
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerBrowserProfileRequest, {
    label: "answer browser profile request",
    reportFailure: false,
  });
  const request = { threadId: item.threadId, turnItemId: item.id };
  const canAnswer = useAtomValue(
    serverEnvironment.answerBrowserProfileRequest.permissionAtom(props.environmentId),
  );
  // Wider grants change later threads too, so they need settings access.
  const canAllowWidely = useAtomValue(
    serverEnvironment.answerBrowserProfileRequest.permissionAtom(props.environmentId, {
      ...request,
      answer: { type: "approve", scope: "project" },
    }),
  );
  const { error, onError: setError } = props;
  const [submitting, setSubmitting] = useState(false);
  // Two clicks can land before a render.
  const inFlight = useRef(false);

  const reply = async (scope: AgentBrowserProfileGrantScope | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: {
        ...request,
        answer: scope === null ? { type: "decline" } : { type: "approve", scope },
      },
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    pipe(
      squashAtomCommandFailure(result),
      (failure) => browserProfileRequestFailureMessage(failure, m),
      setError,
    );
  };
  const disabled = submitting || !canAnswer;

  return (
    <section
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <UserLockIcon className="size-3.5 shrink-0 text-icon-muted" aria-hidden />
          <T>
            Let the agent use your <Var>{item.profileName}</Var> browser profile?
          </T>
        </h3>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {item.url === undefined ? (
            <T>
              It wants to open a tab signed in as you. It can then act on every site this profile is
              signed in to.
            </T>
          ) : (
            <T>
              It wants to open <Var>{item.url}</Var> signed in as you. It can then act on every site
              this profile is signed in to.
            </T>
          )}
        </p>
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : !canAnswer ? (
        <p className="text-xs text-muted-foreground">
          <T>Only someone who can run agents on this machine can answer it.</T>
        </p>
      ) : !canAllowWidely ? (
        <p className="text-xs text-muted-foreground">
          <T>Allowing it beyond this thread needs permission to change settings.</T>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() => void reply(null)}
        >
          <T>Don't allow</T>
        </Button>
        {BROWSER_PROFILE_GRANT_SCOPES.toReversed().map((scope) => (
          <Button
            key={scope}
            type="button"
            size="sm"
            variant={scope === "thread" ? "default" : "outline"}
            disabled={disabled || (scope !== "thread" && !canAllowWidely)}
            onClick={() => void reply(scope)}
          >
            {browserProfileAllowLabel(scope, m)}
          </Button>
        ))}
      </div>
    </section>
  );
}
