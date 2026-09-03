// ---
// relationships:
//   validates: external-mcp-registration
// ---
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  CursorSettings,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import {
  makeCursorAcpRuntime,
  type CursorAcpRuntimeInput,
} from "../provider/acp/CursorAcpSupport.ts";
import { makeCursorAdapter } from "../provider/Layers/CursorAdapter.ts";
import * as ProviderEventLoggers from "../provider/Layers/ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "../provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../provider/Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { makeAdapterRegistryMock } from "../provider/testUtils/providerAdapterRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  EXTERNAL_MCP_LIVE_TOOL_NAME,
  startExternalMcpLiveFixture,
} from "./ExternalMcpLiveFixture.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const LIVE_PROBE_ENV = "T3_EXTERNAL_MCP_LIVE_PROBE";
const externalName = "external";
const operatorAuthorization = "Bearer generic-operator-credential";
const cursorDriver = ProviderDriverKind.make("cursor");
const cursorInstanceId = ProviderInstanceId.make("cursor");
const cursorSettings = Schema.decodeSync(CursorSettings)({});

const authLayer = Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
    request.headers.authorization === operatorAuthorization
      ? Effect.succeed({
          sessionId: AuthSessionId.make("generic-live-probe-session"),
          subject: "generic-live-probe-subject",
          method: "bearer-access-token" as const,
          scopes: [AuthOrchestrationOperateScope],
        })
      : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError()),
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);

const serverEnvironmentLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(EnvironmentId.make("generic-live-probe-environment")),
  getDescriptor: Effect.die("unused"),
});
const registryLayer = McpSessionRegistry.layer.pipe(Layer.provide(serverEnvironmentLayer));
const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-external-mcp-live-probe-",
});
const serve = HttpRouter.serve(
  McpHttpServer.layer.pipe(
    Layer.provide(registryLayer),
    Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
  ),
  { disableListenLog: true, disableLogger: true },
);

type ProbeOrder = "external-first" | "internal-first";

const readNames = (threadId: ThreadId): ReadonlyArray<string> => {
  return McpProviderSession.readMcpProviderSessions(threadId)
    .map(({ name }) => name)
    .sort();
};

const registerExternal = (
  client: HttpClient.HttpClient,
  input: {
    readonly threadId: ThreadId;
    readonly endpoint: string;
    readonly authorizationHeader: string;
  },
) =>
  client.put("/api/mcp/provider-session", {
    headers: { authorization: operatorAuthorization },
    body: HttpBody.jsonUnsafe({
      threadId: input.threadId,
      name: externalName,
      endpoint: input.endpoint,
      authorizationHeader: input.authorizationHeader,
    }),
  });

const issueInternal = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const issued = yield* McpSessionRegistry.issueActiveMcpCredential({
      threadId,
      providerInstanceId: ProviderInstanceId.make("cursor"),
    });
    expect(issued).toBeDefined();
    McpProviderSession.setMcpProviderSession(issued!.config);
  });

const clearExternal = (client: HttpClient.HttpClient, threadId: ThreadId) =>
  client.del("/api/mcp/provider-session", {
    headers: { authorization: operatorAuthorization },
    body: HttpBody.jsonUnsafe({ threadId, name: externalName }),
  });

const makeCursorProviderLayer = (adapter: ProviderAdapterShape<ProviderAdapterError>) => {
  const adapterRegistryLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    makeAdapterRegistryMock({ [cursorDriver]: adapter }),
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  return makeProviderServiceLive().pipe(
    Layer.provide(adapterRegistryLayer),
    Layer.provide(directoryLayer),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({ enableAgentBrowserAccess: true }),
    ),
    Layer.provide(serverConfigLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  );
};

const assertInternalEndpointAcceptsCredential = (
  client: HttpClient.HttpClient,
  config: McpProviderSession.InternalMcpProviderSessionConfig,
) =>
  Effect.gen(function* () {
    const response = yield* client.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: config.authorizationHeader,
      },
      body: HttpBody.text(
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- fixed protocol fixture payload.
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "generic-live-probe", version: "1.0.0" },
          },
        }),
        "application/json",
      ),
    });
    expect(response.status).toBe(200);
    const sessionId = response.headers["mcp-session-id"];
    if (sessionId) {
      const terminated = yield* client.del("/mcp", {
        headers: {
          authorization: config.authorizationHeader,
          "mcp-session-id": sessionId,
        },
      });
      expect(terminated.status).toBe(204);
    }
  });

describe.runIf(process.env[LIVE_PROBE_ENV] === "1")("external MCP live probe", () => {
  it.effect("preserves external and internal MCP entries in both registration orders", () =>
    Effect.scoped(
      Effect.gen(function* () {
        McpProviderSession.clearAllMcpProviderSessions();
        const services = yield* Layer.merge(serve, registryLayer).pipe(Layer.build);
        Context.get(services, McpSessionRegistry.McpSessionRegistry);
        const client = yield* HttpClient.HttpClient;

        for (const order of ["external-first", "internal-first"] satisfies Array<ProbeOrder>) {
          const threadId = ThreadId.make(`generic-live-probe-${order}`);
          if (order === "external-first") {
            const response = yield* registerExternal(client, {
              threadId,
              endpoint: "http://127.0.0.1:9/mcp",
              authorizationHeader: "Bearer generic-fixture-credential",
            });
            expect(response.status).toBe(204);
            yield* issueInternal(threadId);
          } else {
            yield* issueInternal(threadId);
            const response = yield* registerExternal(client, {
              threadId,
              endpoint: "http://127.0.0.1:9/mcp",
              authorizationHeader: "Bearer generic-fixture-credential",
            });
            expect(response.status).toBe(204);
          }

          expect(readNames(threadId), order).toEqual([externalName, "t3-code"]);
        }
      }),
    ).pipe(Effect.provide(Layer.mergeAll(authLayer, NodeHttpServer.layerTest, NodeServices.layer))),
  );

  it.effect(
    "calls the external tool while preserving T3 browser MCP through the real Cursor adapter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          McpProviderSession.clearAllMcpProviderSessions();
          const serverServices = yield* Layer.merge(serve, registryLayer).pipe(Layer.build);
          Context.get(serverServices, McpSessionRegistry.McpSessionRegistry);
          const client = yield* HttpClient.HttpClient;
          const capturedMcpNames: Array<ReadonlyArray<string>> = [];
          const adapter = yield* makeCursorAdapter(cursorSettings, {
            makeRuntime: (input: CursorAcpRuntimeInput) => {
              capturedMcpNames.push((input.mcpServers ?? []).map(({ name }) => name).sort());
              return makeCursorAcpRuntime(input);
            },
          }).pipe(Effect.provide(serverConfigLayer));
          const providerServices = yield* makeCursorProviderLayer(adapter).pipe(Layer.build);
          const provider = Context.get(providerServices, ProviderService.ProviderService);

          const waitForTurn = (threadId: ThreadId, prompt: string) =>
            Effect.gen(function* () {
              const terminal = yield* Deferred.make<void>();
              const eventFiber = yield* Stream.runForEach(provider.streamEvents, (event) =>
                event.threadId === threadId && event.type === "turn.completed"
                  ? Deferred.succeed(terminal, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ).pipe(Effect.forkChild);
              yield* provider.sendTurn({ threadId, input: prompt, attachments: [] });
              yield* Deferred.await(terminal).pipe(Effect.timeout("5 minutes"));
              yield* Fiber.interrupt(eventFiber);
            });

          const cryptoService = yield* Crypto.Crypto;

          for (const order of ["internal-first", "external-first"] satisfies Array<ProbeOrder>) {
            const threadId = ThreadId.make(`generic-cursor-live-probe-${order}`);
            const nonce = yield* cryptoService.randomUUIDv4;
            const fixtureAuthorization = `Bearer ${yield* cryptoService.randomUUIDv4}`;
            const fixture = yield* Effect.acquireRelease(
              Effect.promise(() =>
                startExternalMcpLiveFixture({
                  authorizationHeader: fixtureAuthorization,
                  nonce,
                }),
              ),
              (running) => Effect.promise(() => running.stop()).pipe(Effect.ignore),
            );

            if (order === "internal-first") {
              yield* provider.startSession(threadId, {
                threadId,
                provider: cursorDriver,
                providerInstanceId: cursorInstanceId,
                cwd: process.cwd(),
                runtimeMode: "full-access",
              });
              expect(capturedMcpNames.at(-1)).toEqual(["t3-code"]);
              yield* provider.stopSession({ threadId });
            }

            const registered = yield* registerExternal(client, {
              threadId,
              endpoint: fixture.endpoint,
              authorizationHeader: fixtureAuthorization,
            });
            expect(registered.status).toBe(204);

            yield* provider.startSession(threadId, {
              threadId,
              provider: cursorDriver,
              providerInstanceId: cursorInstanceId,
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });
            expect(capturedMcpNames.at(-1)).toEqual([externalName, "t3-code"]);
            expect(readNames(threadId)).toEqual([externalName, "t3-code"]);

            const internal = McpProviderSession.readMcpProviderSession(threadId);
            expect(internal).toBeDefined();
            yield* assertInternalEndpointAcceptsCredential(client, internal!);

            yield* waitForTurn(
              threadId,
              `Call ${EXTERNAL_MCP_LIVE_TOOL_NAME} exactly once with the nonce ${nonce}. After the tool returns, reply with only done.`,
            );
            expect(fixture.calls).toEqual([{ nonce }]);

            const cleared = yield* clearExternal(client, threadId);
            expect(cleared.status).toBe(204);
            yield* provider.stopSession({ threadId });
            yield* provider.startSession(threadId, {
              threadId,
              provider: cursorDriver,
              providerInstanceId: cursorInstanceId,
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });
            expect(capturedMcpNames.at(-1)).toEqual(["t3-code"]);
            expect(readNames(threadId)).toEqual(["t3-code"]);
            yield* provider.stopSession({ threadId });
          }
        }),
      ).pipe(
        Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
        Effect.provide(Layer.mergeAll(authLayer, NodeHttpServer.layerTest, NodeServices.layer)),
      ),
  );
});
