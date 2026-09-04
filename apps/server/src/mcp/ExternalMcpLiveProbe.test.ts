// ---
// relationships:
//   validates: external-mcp-registration
// ---
// @effect-diagnostics nodeBuiltinImport:off -- this live test invokes the reviewed exact-process worker boundary.
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  defaultInstanceIdForDriver,
  EnvironmentId,
  GrokSettings,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
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
import { makeGrokAcpRuntime } from "../provider/acp/GrokAcpSupport.ts";
import { makeClaudeAdapter } from "../provider/Layers/ClaudeAdapter.ts";
import { makeCodexAdapter } from "../provider/Layers/CodexAdapter.ts";
import { makeCodexSessionRuntime } from "../provider/Layers/CodexSessionRuntime.ts";
import { makeCursorAdapter } from "../provider/Layers/CursorAdapter.ts";
import { makeGrokAdapter } from "../provider/Layers/GrokAdapter.ts";
import { makeOpenCodeAdapter } from "../provider/Layers/OpenCodeAdapter.ts";
import * as ProviderEventLoggers from "../provider/Layers/ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "../provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../provider/Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { makeAdapterRegistryMock } from "../provider/testUtils/providerAdapterRegistryMock.ts";
import { OpenCodeRuntime, OpenCodeRuntimeLive } from "../provider/opencodeRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  EXTERNAL_MCP_LIVE_TOOL_NAME,
  startExternalMcpLiveFixture,
} from "./ExternalMcpLiveFixture.ts";
import {
  EXTERNAL_MCP_LIVE_PROBE_ENV,
  publishExternalMcpLiveWorkerResult,
  readExternalMcpLiveWorkerContext,
  runExternalMcpLiveWorker,
  type ExternalMcpLiveHarness,
  type ExternalMcpLiveWorkerProcessHandle,
} from "./ExternalMcpLiveWorker.ts";
import {
  EXTERNAL_MCP_LIVE_WORKER_PROTOCOL_ENV,
  type ExternalMcpLiveWorkerStage,
} from "./ExternalMcpLiveWorkerProtocol.ts";
import * as CursorMcpGateway from "./CursorMcpGateway.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const externalName = "external";
const operatorAuthorization = "Bearer generic-operator-credential";
const cursorDriver = ProviderDriverKind.make("cursor");
const cursorInstanceId = ProviderInstanceId.make("cursor");
const cursorSettings = Schema.decodeSync(CursorSettings)({});
const claudeSettings = Schema.decodeSync(ClaudeSettings)({});
const codexSettings = Schema.decodeSync(CodexSettings)({});
const grokSettings = Schema.decodeSync(GrokSettings)({});
const openCodeSettings = Schema.decodeSync(OpenCodeSettings)({});
const BEST_EFFORT_WORKER_TEST_NAME = "runs one best-effort external MCP live worker";

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

const makeProviderLayer = (adapter: ProviderAdapterShape<ProviderAdapterError>) => {
  const adapterRegistryLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    makeAdapterRegistryMock({ [adapter.provider]: adapter }),
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  return makeProviderServiceLive().pipe(
    Layer.provide(adapterRegistryLayer),
    Layer.provide(directoryLayer),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        enableAgentBrowserAccess: true,
      }),
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

const listGatewayToolNames = (config: CursorMcpGateway.CursorMcpGatewayConfig) =>
  Effect.tryPromise(async () => {
    const client = new Client({ name: "generic-live-probe", version: "1.0.0" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
        requestInit: {
          headers: { Authorization: config.authorizationHeader },
        },
      });
      await client.connect(transport as Parameters<Client["connect"]>[0]);
      return (await client.listTools()).tools.map(({ name }) => name).sort();
    } finally {
      await client.close();
    }
  });

const mcpNamesFromCodexArgs = (args: ReadonlyArray<string> | undefined) =>
  (args ?? []).flatMap((argument) => {
    const match = /^mcp_servers\.([^.]+)\.url=/u.exec(argument);
    return match?.[1] ? [match[1]] : [];
  });

const makeBestEffortAdapter = (
  harness: ExternalMcpLiveHarness,
  nativeMcpNames: Array<ReadonlyArray<string>>,
) =>
  Effect.gen(function* () {
    const cryptoService = yield* Crypto.Crypto;
    switch (harness) {
      case "claudeAgent":
        return yield* makeClaudeAdapter(claudeSettings, {
          createQuery: (input) => {
            nativeMcpNames.push(Object.keys(input.options.mcpServers ?? {}).sort());
            return claudeQuery(input) as never;
          },
        });
      case "codex":
        return yield* makeCodexAdapter(codexSettings, {
          makeRuntime: (input) => {
            nativeMcpNames.push(mcpNamesFromCodexArgs(input.appServerArgs).sort());
            return makeCodexSessionRuntime(input).pipe(
              Effect.provideService(Crypto.Crypto, cryptoService),
            );
          },
        });
      case "grok":
        return yield* makeGrokAdapter(grokSettings, {
          makeRuntime: (input) => {
            nativeMcpNames.push((input.mcpServers ?? []).map(({ name }) => name).sort());
            return makeGrokAcpRuntime(input);
          },
        });
      case "opencode":
        return yield* Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const capturingRuntime = {
            ...runtime,
            createOpenCodeSdkClient: (
              input: Parameters<typeof runtime.createOpenCodeSdkClient>[0],
            ) => {
              const client = runtime.createOpenCodeSdkClient(input);
              const names: Array<string> = [];
              nativeMcpNames.push(names);
              const mcp = client.mcp;
              return new Proxy(client, {
                get: (target, property, receiver) => {
                  if (property !== "mcp") return Reflect.get(target, property, receiver);
                  return {
                    ...mcp,
                    add: async (...args: Parameters<typeof mcp.add>) => {
                      const name = args[0]?.name;
                      if (name !== undefined) names.push(name);
                      names.sort();
                      return mcp.add(...args);
                    },
                  };
                },
              });
            },
          } satisfies OpenCodeRuntime["Service"];
          return yield* makeOpenCodeAdapter(openCodeSettings).pipe(
            Effect.provideService(OpenCodeRuntime, capturingRuntime),
          );
        }).pipe(Effect.provide(OpenCodeRuntimeLive));
    }
  }).pipe(Effect.provide(serverConfigLayer));

const failureTag = <E>(exit: Exit.Exit<unknown, E>): string => {
  if (Exit.isSuccess(exit)) return "none";
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (failure?._tag !== "Fail") return "defect-or-interruption";
  const error = failure.error;
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : "unclassified-failure";
};

const isBestEffortWorker = process.env[EXTERNAL_MCP_LIVE_WORKER_PROTOCOL_ENV] !== undefined;

const processGroupIsAlive = (handle: ExternalMcpLiveWorkerProcessHandle): boolean => {
  try {
    process.kill(-handle.processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

describe.runIf(process.env[EXTERNAL_MCP_LIVE_PROBE_ENV] === "1" && !isBestEffortWorker)(
  "external MCP live probe",
  () => {
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
      ).pipe(
        Effect.provide(Layer.mergeAll(authLayer, NodeHttpServer.layerTest, NodeServices.layer)),
      ),
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
            const capturedNativeMcp: Array<CursorAcpRuntimeInput["mcpServers"]> = [];
            const capturedGateways: Array<CursorMcpGateway.CursorMcpGatewayConfig> = [];
            const adapter = yield* makeCursorAdapter(cursorSettings, {
              makeRuntime: (input: CursorAcpRuntimeInput) => {
                capturedMcpNames.push((input.mcpServers ?? []).map(({ name }) => name).sort());
                capturedNativeMcp.push(input.mcpServers);
                return makeCursorAcpRuntime(input);
              },
              makeMcpGateway: (input) =>
                CursorMcpGateway.startCursorMcpGateway(input).pipe(
                  Effect.tap((gateway) =>
                    Effect.sync(() => {
                      capturedGateways.push(gateway);
                    }),
                  ),
                ),
            }).pipe(Effect.provide(serverConfigLayer));
            const providerServices = yield* makeProviderLayer(adapter).pipe(Layer.build);
            const provider = Context.get(providerServices, ProviderService.ProviderService);

            const waitForTurn = (threadId: ThreadId, prompt: string) =>
              Effect.gen(function* () {
                const terminal = yield* Deferred.make<void>();
                const eventFiber = yield* Stream.runForEach(provider.streamEvents, (event) =>
                  event.threadId === threadId && event.type === "turn.completed"
                    ? Deferred.succeed(terminal, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ).pipe(Effect.forkChild);
                yield* provider.sendTurn({
                  threadId,
                  input: prompt,
                  attachments: [],
                });
                yield* Deferred.await(terminal).pipe(Effect.timeout("90 seconds"));
                yield* Fiber.interrupt(eventFiber);
              });

            const cryptoService = yield* Crypto.Crypto;

            const threadId = ThreadId.make("generic-cursor-live-probe-external-first");
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
            expect(capturedMcpNames.at(-1)).toEqual(["t3-code"]);
            expect(readNames(threadId)).toEqual([externalName, "t3-code"]);

            const gateway = capturedGateways.at(-1);
            const nativeGateway = capturedNativeMcp.at(-1)?.[0];
            expect(gateway).toBeDefined();
            expect(capturedNativeMcp.at(-1)?.length).toBe(1);
            expect(nativeGateway?.name).toBe("t3-code");
            const nativeGatewayIsHttp = nativeGateway !== undefined && "url" in nativeGateway;
            expect(nativeGatewayIsHttp).toBe(true);
            expect(nativeGatewayIsHttp && nativeGateway.url === gateway?.endpoint).toBe(true);
            expect(
              nativeGatewayIsHttp &&
                nativeGateway.headers?.some(
                  ({ name, value }) =>
                    name === "Authorization" && value === gateway?.authorizationHeader,
                ),
            ).toBe(true);

            const toolNames = yield* listGatewayToolNames(gateway!).pipe(Effect.orDie);
            expect(toolNames).toContain(EXTERNAL_MCP_LIVE_TOOL_NAME);
            expect(toolNames).toContain("preview_status");
            yield* Effect.logInfo("Cursor gateway live probe surface", { toolNames });

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
          }),
        ).pipe(
          Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
          Effect.provide(Layer.mergeAll(authLayer, NodeHttpServer.layerTest, NodeServices.layer)),
        ),
      12 * 60_000,
    );

    it.effect(
      "records bounded additive live results for every other supported harness",
      () =>
        Effect.gen(function* () {
          const harnesses = [
            "codex",
            "grok",
            "claudeAgent",
            "opencode",
          ] satisfies Array<ExternalMcpLiveHarness>;

          for (const harness of harnesses) {
            let handle: ExternalMcpLiveWorkerProcessHandle | undefined;
            let discardedOutput:
              | { readonly stdoutBytes: number; readonly stderrBytes: number }
              | undefined;
            const result = yield* Effect.promise(() =>
              runExternalMcpLiveWorker({
                harness,
                command: {
                  executable: NodePath.resolve(process.cwd(), "node_modules/.bin/vp"),
                  args: [
                    "test",
                    "run",
                    "apps/server/src/mcp/ExternalMcpLiveProbe.test.ts",
                    "-t",
                    BEST_EFFORT_WORKER_TEST_NAME,
                  ],
                  cwd: process.cwd(),
                  environment: {
                    [EXTERNAL_MCP_LIVE_PROBE_ENV]: "1",
                  },
                },
                deadlineMs: 120_000,
                gracefulTerminationMs: 10_000,
                forcedTerminationMs: 10_000,
                onSpawn: (spawned) => {
                  handle = spawned;
                },
                onDiscardedOutput: (summary) => {
                  discardedOutput = summary;
                },
              }),
            );

            expect(handle).toBeDefined();
            if (handle === undefined)
              throw new Error("Live worker did not expose its owned handle.");
            expect(processGroupIsAlive(handle)).toBe(false);
            expect(discardedOutput).toBeDefined();
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- the reviewed protocol contains enums only.
            const encoded = JSON.stringify(result);
            yield* Effect.sync(() => {
              process.stderr.write(`external MCP live probe result: ${encoded}\n`);
            });
          }
        }),
      12 * 60_000,
    );
  },
);

describe.runIf(process.env[EXTERNAL_MCP_LIVE_PROBE_ENV] === "1" && isBestEffortWorker)(
  "external MCP live probe worker",
  () => {
    it.effect(
      BEST_EFFORT_WORKER_TEST_NAME,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { harness } = readExternalMcpLiveWorkerContext();
            let stage: ExternalMcpLiveWorkerStage = "setup";
            const serverServices = yield* Layer.merge(serve, registryLayer).pipe(Layer.build);
            Context.get(serverServices, McpSessionRegistry.McpSessionRegistry);
            const client = yield* HttpClient.HttpClient;
            const cryptoService = yield* Crypto.Crypto;

            const exit = yield* Effect.exit(
              Effect.gen(function* () {
                McpProviderSession.clearAllMcpProviderSessions();
                const threadId = ThreadId.make(`generic-${harness}-live-probe`);
                const nonce = yield* cryptoService.randomUUIDv4;
                const fixtureAuthorization = `Bearer ${yield* cryptoService.randomUUIDv4}`;

                stage = "adapter";
                const nativeMcpNames: Array<ReadonlyArray<string>> = [];
                const adapter = yield* makeBestEffortAdapter(harness, nativeMcpNames);
                const providerServices = yield* makeProviderLayer(adapter).pipe(Layer.build);
                const provider = Context.get(providerServices, ProviderService.ProviderService);
                const providerInstanceId = defaultInstanceIdForDriver(adapter.provider);

                const fixture = yield* Effect.acquireRelease(
                  Effect.promise(() =>
                    startExternalMcpLiveFixture({
                      authorizationHeader: fixtureAuthorization,
                      nonce,
                    }),
                  ),
                  (running) => Effect.promise(() => running.stop()).pipe(Effect.ignore),
                );

                stage = "registration";
                const registered = yield* registerExternal(client, {
                  threadId,
                  endpoint: fixture.endpoint,
                  authorizationHeader: fixtureAuthorization,
                });
                expect(registered.status).toBe(204);

                stage = "session-start";
                yield* provider
                  .startSession(threadId, {
                    threadId,
                    provider: adapter.provider,
                    providerInstanceId,
                    cwd: process.cwd(),
                    runtimeMode: "full-access",
                  })
                  .pipe(Effect.timeout("1 minute"));
                expect(readNames(threadId)).toEqual([externalName, "t3-code"]);
                expect(nativeMcpNames.at(-1)).toEqual([externalName, "t3-code"]);

                stage = "internal-mcp";
                const internal = McpProviderSession.readMcpProviderSession(threadId);
                expect(internal).toBeDefined();
                yield* assertInternalEndpointAcceptsCredential(client, internal!);

                stage = "turn";
                const terminal = yield* Deferred.make<void>();
                const eventFiber = yield* Stream.runForEach(provider.streamEvents, (event) =>
                  event.threadId === threadId && event.type === "turn.completed"
                    ? Deferred.succeed(terminal, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ).pipe(Effect.forkChild);
                yield* Effect.gen(function* () {
                  yield* provider.sendTurn({
                    threadId,
                    input: `Call ${EXTERNAL_MCP_LIVE_TOOL_NAME} exactly once with the nonce ${nonce}. After the tool returns, reply with only done.`,
                    attachments: [],
                  });
                  yield* Deferred.await(terminal);
                }).pipe(Effect.timeout("90 seconds"));
                yield* Fiber.interrupt(eventFiber);

                stage = "fixture-call";
                expect(fixture.calls).toEqual([{ nonce }]);

                stage = "cleanup";
                const cleared = yield* clearExternal(client, threadId);
                expect(cleared.status).toBe(204);
                yield* provider.stopSession({ threadId }).pipe(Effect.timeout("20 seconds"));
                stage = "complete";
              }),
            );

            yield* Effect.sync(() =>
              publishExternalMcpLiveWorkerResult(
                Exit.isSuccess(exit)
                  ? {
                      status: "passed",
                      reachedStage: "complete",
                      reason: "all-assertions-passed",
                    }
                  : {
                      status: "failed",
                      reachedStage: stage,
                      reason:
                        failureTag(exit) === "TimeoutException"
                          ? "stage-timed-out"
                          : "stage-failed",
                    },
              ),
            );
          }),
        ).pipe(
          Effect.ensuring(Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions())),
          Effect.provide(Layer.mergeAll(authLayer, NodeHttpServer.layerTest, NodeServices.layer)),
        ),
      4 * 60_000,
    );
  },
);
