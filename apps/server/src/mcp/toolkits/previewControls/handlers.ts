import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  agentProfilePolicy,
  snapshotStorageProfileId,
} from "../../../preview/agentProfileAccess.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Preview from "../../../preview/Manager.ts";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { PreviewControlsToolkit } from "./tools.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const agentProfileAccess = Effect.fn("PreviewControls.agentProfileAccess")(function* (thread: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: string;
}) {
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.orElseSucceed(() => null),
  );
  if (settings?.requireAgentBrowserProfileApproval === false) return undefined;
  const shell = yield* (yield* ThreadManagementService.ThreadManagementService)
    .getThreadShell(thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  return agentProfilePolicy(settings, shell, thread);
});

const access = Effect.gen(function* () {
  const scope = yield* requireThreadMcpCapability("preview");
  return { scope, manager: yield* Preview.PreviewManager };
});
export const layer = McpToolAccess.toLayer(PreviewControlsToolkit, {
  t3_preview_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const result = yield* manager.list({ threadId: scope.thread.threadId });
      const start = input.cursor ?? 0;
      const end = start + (input.limit ?? 20);
      const mayUse = yield* agentProfileAccess(scope.thread);
      return {
        ...result,
        // As preview_status does: a tab in a profile the caller may not use keeps no page details.
        sessions: result.sessions.slice(start, end).map((session) =>
          mayUse === undefined || mayUse(snapshotStorageProfileId(session))
            ? session
            : {
                ...session,
                navStatus: { _tag: "Idle" as const },
                canGoBack: false,
                canGoForward: false,
              },
        ),
        nextCursor: end < result.sessions.length ? end : null,
      };
    }),
  ),
  t3_preview_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      if (
        sessions.some((session) => session.tabId === input.tabId && session.runtime === "server")
      ) {
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        yield* broker.invoke({ scope, operation: "close", input: {}, tabId: input.tabId });
        return {};
      }
      yield* manager
        .close({ threadId: scope.thread.threadId, tabId: input.tabId })
        .pipe(Effect.mapError(unavailable));
      return {};
    }),
  ),
});
