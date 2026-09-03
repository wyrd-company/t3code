import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CursorSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import type { CursorAcpRuntimeInput } from "../provider/acp/CursorAcpSupport.ts";
import { makeCursorAdapter } from "../provider/Layers/CursorAdapter.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

const cursorSettings = Schema.decodeSync(CursorSettings)({});
const dependencies = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

function makeRuntime(start: AcpSessionRuntime.AcpSessionRuntime["Service"]["start"]) {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "start") return start;
        if (property === "getEvents") return () => Stream.empty;
        if (property === "getConfigOptions") return Effect.succeed([]);
        if (property === "getModeState") return Effect.succeed(undefined);
        return () => Effect.void;
      },
    },
  ) as AcpSessionRuntime.AcpSessionRuntime["Service"];
}

function missingSessionError(sessionId: string) {
  return {
    code: -32602,
    message: "Invalid params",
    data: { message: `Session "${sessionId}" not found` },
  };
}

it.effect("starts a fresh Cursor session when its saved session no longer exists", () =>
  Effect.gen(function* () {
    McpProviderSession.clearAllMcpProviderSessions();
    const threadId = ThreadId.make("cursor-resume-fallback-thread");
    const savedSessionId = "saved-cursor-session";
    McpProviderSession.setMcpProviderSession({
      source: "internal",
      environmentId: EnvironmentId.make("cursor-resume-fallback-environment"),
      threadId,
      providerSessionId: "cursor-resume-fallback-provider-session",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1/internal",
      authorizationHeader: "Bearer test-token",
      browserToolsAvailable: true,
    });
    McpProviderSession.setExternalMcpProviderSession({
      threadId,
      endpoint: "https://service.example.test/mcp",
      authorizationHeader: "Bearer external-test-token",
    });

    const inputs: Array<CursorAcpRuntimeInput> = [];
    let closedRuntimeCount = 0;
    const adapter = yield* makeCursorAdapter(cursorSettings, {
      makeMcpGateway: () =>
        Effect.succeed({
          name: McpProviderSession.INTERNAL_MCP_SERVER_NAME,
          endpoint: "http://127.0.0.1/gateway",
          authorizationHeader: "Bearer gateway-token",
        }),
      makeRuntime: (input) =>
        Effect.gen(function* () {
          inputs.push(input);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closedRuntimeCount += 1;
            }),
          );
          return makeRuntime(
            inputs.length === 1
              ? () => Effect.die(missingSessionError(savedSessionId))
              : () =>
                  Effect.succeed({
                    sessionId: "fresh-cursor-session",
                    initializeResult: {} as never,
                    sessionSetupResult: {} as never,
                    modelConfigId: undefined,
                  }),
          );
        }),
    });

    const session = yield* adapter.startSession({
      provider: ProviderDriverKind.make("cursor"),
      threadId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      resumeCursor: { schemaVersion: 1, sessionId: savedSessionId },
    });

    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.resumeSessionId).toBe(savedSessionId);
    expect(inputs[1]?.resumeSessionId).toBeUndefined();
    const expectedMcpServers = [
      {
        type: "http",
        name: "t3-code",
        url: "http://127.0.0.1/gateway",
        headers: [{ name: "Authorization", value: "Bearer gateway-token" }],
      },
    ];
    expect(inputs[0]?.mcpServers).toEqual(expectedMcpServers);
    expect(inputs[1]?.mcpServers).toEqual(expectedMcpServers);
    expect(session.resumeCursor).toEqual({
      schemaVersion: 1,
      sessionId: "fresh-cursor-session",
    });
    expect(closedRuntimeCount).toBe(1);
    yield* adapter.stopSession(threadId);
    expect(closedRuntimeCount).toBe(2);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("does not discard a saved Cursor session for another Invalid params error", () =>
  Effect.gen(function* () {
    McpProviderSession.clearAllMcpProviderSessions();
    const savedSessionId = "saved-cursor-session";
    let attemptCount = 0;
    const adapter = yield* makeCursorAdapter(cursorSettings, {
      makeRuntime: () => {
        attemptCount += 1;
        return Effect.succeed(
          makeRuntime(() =>
            Effect.die({
              ...missingSessionError(savedSessionId),
              data: { message: "A different parameter is invalid" },
            }),
          ),
        );
      },
    });

    const exit = yield* adapter
      .startSession({
        provider: ProviderDriverKind.make("cursor"),
        threadId: ThreadId.make("cursor-resume-negative-control"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: savedSessionId },
      })
      .pipe(Effect.exit);

    expect(attemptCount).toBe(1);
    expect(exit._tag).toBe("Failure");
  }).pipe(Effect.provide(dependencies)),
);
