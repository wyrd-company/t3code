import { T, useMessages, useGT, Var } from "gt-react-native";
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
import { useRef, useState } from "react";
import { View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };

export function BrowserProfileRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const m = useMessages();
  const { item, visibility } = props.projectedItem;
  // Held here: a save can fail after the card already reads Allowed, replacing the pending view.
  const [error, setError] = useState<string | null>(null);
  if (item.type !== "browser_profile_request") return null;
  const display = browserProfileRequestDisplay(item, visibility, m);
  if (display.kind === "pending") {
    return (
      <PendingBrowserProfileRequest
        environmentId={props.environmentId}
        item={item}
        error={error}
        onError={setError}
      />
    );
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere" ? LOCK_SYMBOL : display.approved ? "checkmark" : "minus";
  return (
    <View className="mb-3 gap-1 px-1">
      <View className="min-h-9 flex-row items-center gap-2">
        <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
        <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
          <T>
            <Var>{item.profileName}</Var> browser profile
          </T>{" "}
          · {display.label}
        </Text>
      </View>
      {error !== null ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function PendingBrowserProfileRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly item: BrowserProfileRequestItem;
  readonly error: string | null;
  readonly onError: (error: string | null) => void;
}) {
  const m = useMessages();
  const gt = useGT();
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
  // Two taps can land before a re-render; this guard is synchronous.
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
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">
          <T>
            Let the agent use your <Var>{item.profileName}</Var> browser profile?
          </T>
        </Text>
        <Text className="font-sans text-xs text-foreground-muted">
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
        </Text>
      </View>
      {error !== null ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      ) : !canAnswer ? (
        <Text className="font-sans text-xs text-foreground-muted">
          <T>Only someone who can run agents on this machine can answer it.</T>
        </Text>
      ) : !canAllowWidely ? (
        <Text className="font-sans text-xs text-foreground-muted">
          <T>Allowing it beyond this thread needs permission to change settings.</T>
        </Text>
      ) : null}
      {BROWSER_PROFILE_GRANT_SCOPES.map((scope) => (
        <Button
          key={scope}
          label={browserProfileAllowLabel(scope, m)}
          tone={scope === "thread" ? "primary" : "secondary"}
          fullWidth
          disabled={disabled || (scope !== "thread" && !canAllowWidely)}
          onPress={() => void reply(scope)}
        />
      ))}
      <Button
        label={gt("Don't allow")}
        tone="text"
        disabled={disabled}
        onPress={() => void reply(null)}
      />
    </View>
  );
}
