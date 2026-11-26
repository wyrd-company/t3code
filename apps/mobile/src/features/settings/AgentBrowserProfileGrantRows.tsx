import { useGT } from "gt-react-native";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AgentBrowserProfileGrant,
  type EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useProject, useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { SettingsRow } from "./components/SettingsRow";
import type { ScopedMobileSettingsTarget } from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };

/** Each environment keeps its own grants, so a row removes one from its own environment. */
export function AgentBrowserProfileGrantRows(props: {
  readonly targets: readonly ScopedMobileSettingsTarget[];
  readonly disabled: boolean;
  readonly canWrite: (environmentId: EnvironmentId) => boolean;
}) {
  const writeSettings = useSettingsWriter();
  return props.targets.flatMap((target) =>
    Object.entries(target.settings.agentBrowserProfileGrants).map(([key, grant]) => (
      <AgentBrowserProfileGrantRow
        key={`${target.environment.environmentId}:${key}`}
        environmentId={target.environment.environmentId}
        environmentLabel={props.targets.length > 1 ? target.environment.label : null}
        grant={grant}
        disabled={props.disabled || !props.canWrite(target.environment.environmentId)}
        onRemove={() =>
          void writeSettings(props.targets, [
            {
              environmentId: target.environment.environmentId,
              patch: { agentBrowserProfileGrants: { [key]: null } },
            },
          ])
        }
      />
    )),
  );
}

function AgentBrowserProfileGrantRow(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly grant: AgentBrowserProfileGrant;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  const { environmentId, grant } = props;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const providerName =
    grant.scope === "providerInstance"
      ? config?.providers.find((provider) => provider.instanceId === grant.scopeId)?.displayName
      : undefined;
  const thread = useThreadShell(
    grant.scope === "thread" ? scopeThreadRef(environmentId, ThreadId.make(grant.scopeId)) : null,
  );
  const project = useProject(
    grant.scope === "project"
      ? scopeProjectRef(environmentId, ProjectId.make(grant.scopeId))
      : null,
  );
  const name = grant.profileName ?? grant.profileId;
  const where =
    grant.scope === "thread"
      ? gt("Thread: {title}", { title: thread?.title ?? grant.scopeId })
      : grant.scope === "project"
        ? gt("Project: {name}", { name: project?.title ?? grant.scopeId })
        : gt("Provider: {name}", { name: providerName ?? grant.scopeId });
  return (
    <SettingsRow
      icon={LOCK_SYMBOL}
      label={name}
      value={props.environmentLabel === null ? where : `${where} · ${props.environmentLabel}`}
      valuePosition="below"
      disabled={props.disabled}
      onPress={() =>
        Dialog.confirm({
          title: gt("Stop allowing {name}?", { name }),
          message: gt(
            "Agents will ask again before they use this profile. Agent tabs already open in it stop working.",
          ),
          confirmText: gt("Remove"),
          destructive: true,
          onConfirm: props.onRemove,
        })
      }
    />
  );
}
