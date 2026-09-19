import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ClaudeSettings,
  CodexSettings,
  EnvironmentId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpRouter } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SYNTHETIC_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.testFixtures.ts";
import { makeClaudeAdapter } from "../provider/Layers/ClaudeAdapter.ts";
import { makeCodexAdapter } from "../provider/Layers/CodexAdapter.ts";
import type {
  CodexSessionRuntimeOptions,
  CodexSessionRuntimeShape,
} from "../provider/Layers/CodexSessionRuntime.ts";
import type { ClaudeAdapterShape } from "../provider/Services/ClaudeAdapter.ts";
import type { CodexAdapterShape } from "../provider/Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { EXTERNAL_MCP_REGISTRATION_PATH } from "./ExternalMcpRegistration.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as NativeSessionRegistry from "./NativeSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

// Test-local service tags so the adapters can be resolved by name below.
class ClaudeAdapterUnderTest extends Context.Service<ClaudeAdapterUnderTest, ClaudeAdapterShape>()(
  "t3/mcp/NativeSessionLookup.test/ClaudeAdapterUnderTest",
) {}
class CodexAdapterUnderTest extends Context.Service<CodexAdapterUnderTest, CodexAdapterShape>()(
  "t3/mcp/NativeSessionLookup.test/CodexAdapterUnderTest",
) {}

const threadId = ThreadId.make("thread-alpha");
const alternateThreadId = ThreadId.make("thread-beta");

// A harness identifier is opaque to T3. This one carries surrounding space and
// mixed case so a test fails if anything trims or normalizes the value.
const nativeSessionId = " Session-ID-With-Space ";

// ---------------------------------------------------------------------------
// Registry semantics
// ---------------------------------------------------------------------------

it("reports the harness identifier exactly as announced", () => {
  NativeSessionRegistry.clearAllNativeSessions();
  const occurrence = NativeSessionRegistry.beginNativeSession(threadId);
  NativeSessionRegistry.announceNativeSession(occurrence, nativeSessionId);

  expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe(nativeSessionId);
});

it("reports nothing for a started session that has announced nothing yet", () => {
  NativeSessionRegistry.clearAllNativeSessions();
  NativeSessionRegistry.beginNativeSession(threadId);

  expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBeUndefined();
});

it("keeps the identifier when the same session announces again", () => {
  NativeSessionRegistry.clearAllNativeSessions();
  const occurrence = NativeSessionRegistry.beginNativeSession(threadId);
  NativeSessionRegistry.announceNativeSession(occurrence, nativeSessionId);
  NativeSessionRegistry.announceNativeSession(occurrence, nativeSessionId);

  expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe(nativeSessionId);
});

it("clears the replaced session's identifier before the replacement announces", () => {
  NativeSessionRegistry.clearAllNativeSessions();
  const replaced = NativeSessionRegistry.beginNativeSession(threadId);
  NativeSessionRegistry.announceNativeSession(replaced, nativeSessionId);

  NativeSessionRegistry.beginNativeSession(threadId);

  expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBeUndefined();
});

it("refuses a delayed announcement from a replaced session", () => {
  NativeSessionRegistry.clearAllNativeSessions();
  const replaced = NativeSessionRegistry.beginNativeSession(threadId);
  const replacement = NativeSessionRegistry.beginNativeSession(threadId);
  NativeSessionRegistry.announceNativeSession(replacement, "replacement-session");

  NativeSessionRegistry.announceNativeSession(replaced, nativeSessionId);

  expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe("replacement-session");
});

it("refuses a delayed stop from a replaced session", () => {
  NativeSessionRegistry.clearAllNativeSessions();
  const replaced = NativeSessionRegistry.beginNativeSession(threadId);
  const replacement = NativeSessionRegistry.beginNativeSession(threadId);
  NativeSessionRegistry.announceNativeSession(replacement, "replacement-session");

  NativeSessionRegistry.endNativeSession(replaced);

  expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe("replacement-session");
});

it("cannot retarget another thread with an occurrence from this one", () => {
  NativeSessionRegistry.clearAllNativeSessions();
  const stale = NativeSessionRegistry.beginNativeSession(threadId);
  NativeSessionRegistry.endNativeSession(stale);
  const other = NativeSessionRegistry.beginNativeSession(alternateThreadId);
  NativeSessionRegistry.announceNativeSession(other, "beta-session");

  NativeSessionRegistry.announceNativeSession({ ...stale, threadId: alternateThreadId }, "spoofed");

  expect(NativeSessionRegistry.readNativeSessionId(alternateThreadId)).toBe("beta-session");
  expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBeUndefined();
});

it("reports nothing once the session ends", () => {
  NativeSessionRegistry.clearAllNativeSessions();
  const occurrence = NativeSessionRegistry.beginNativeSession(threadId);
  NativeSessionRegistry.announceNativeSession(occurrence, nativeSessionId);

  NativeSessionRegistry.endNativeSession(occurrence);

  expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBeUndefined();
});

it("keeps each thread's identifier to itself", () => {
  NativeSessionRegistry.clearAllNativeSessions();
  const alpha = NativeSessionRegistry.beginNativeSession(threadId);
  const beta = NativeSessionRegistry.beginNativeSession(alternateThreadId);
  NativeSessionRegistry.announceNativeSession(alpha, nativeSessionId);
  NativeSessionRegistry.announceNativeSession(beta, "beta-session");

  expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe(nativeSessionId);
  expect(NativeSessionRegistry.readNativeSessionId(alternateThreadId)).toBe("beta-session");
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

const authenticatedSession = (
  scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make("session-alpha"),
  subject: "subject-alpha",
  method: "bearer-access-token",
  scopes,
});

const authLayer = (access: "missing" | "read" | "operate") =>
  Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
    authenticateHttpRequest: () =>
      access !== "missing"
        ? Effect.succeed(
            authenticatedSession([
              access === "operate" ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
            ]),
          )
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError()),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);

const serverEnvironmentLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-server")),
  getDescriptor: Effect.die("unused"),
});

const serve = HttpRouter.serve(
  McpHttpServer.layer.pipe(
    Layer.provide(McpSessionRegistry.layer.pipe(Layer.provide(serverEnvironmentLayer))),
    Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-native-session-lookup-test-" }),
        Layer.mock(DeviceService.DeviceService)({}),
        Layer.mock(OrchestrationEngineService)({}),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeed(Option.none()),
        }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
  { disableListenLog: true, disableLogger: true },
);

const decodeLookupBody = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ nativeSessionId: Schema.String })),
);

const lookupPath = (query: string) => `${EXTERNAL_MCP_REGISTRATION_PATH}?${query}`;

const httpTest = <E>(
  name: string,
  access: "missing" | "read" | "operate",
  body: (client: HttpClient.HttpClient) => Effect.Effect<void, E, never>,
) =>
  it.effect(name, () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serve.pipe(Layer.build);
        yield* body(yield* HttpClient.HttpClient);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(authLayer(access), NodeHttpServer.layerTest, NodeServices.layer),
      ),
    ),
  );

httpTest("rejects an unauthenticated native session lookup", "missing", (client) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    const occurrence = NativeSessionRegistry.beginNativeSession(threadId);
    NativeSessionRegistry.announceNativeSession(occurrence, nativeSessionId);

    const response = yield* client.get(lookupPath(`threadId=${threadId}`));
    const text = yield* response.text;

    expect(response.status, text).toBe(401);
    expect(text).not.toContain(nativeSessionId.trim());
  }),
);

httpTest("rejects a native session lookup without orchestration operate scope", "read", (client) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    const occurrence = NativeSessionRegistry.beginNativeSession(threadId);
    NativeSessionRegistry.announceNativeSession(occurrence, nativeSessionId);

    const response = yield* client.get(lookupPath(`threadId=${threadId}`));
    const text = yield* response.text;

    expect(response.status, text).toBe(403);
    expect(text).not.toContain(nativeSessionId.trim());
  }),
);

httpTest("rejects a native session lookup with no thread id", "operate", (client) =>
  Effect.gen(function* () {
    const response = yield* client.get(EXTERNAL_MCP_REGISTRATION_PATH);

    expect(response.status, yield* response.text).toBe(400);
  }),
);

httpTest("rejects a native session lookup with a blank thread id", "operate", (client) =>
  Effect.gen(function* () {
    const response = yield* client.get(lookupPath("threadId=%20%20"));

    expect(response.status, yield* response.text).toBe(400);
  }),
);

httpTest("reports no native session for an unknown thread", "operate", (client) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();

    const response = yield* client.get(lookupPath(`threadId=${threadId}`));

    expect(response.status, yield* response.text).toBe(404);
  }),
);

httpTest("reports no native session before the harness announces one", "operate", (client) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    NativeSessionRegistry.beginNativeSession(threadId);

    const response = yield* client.get(lookupPath(`threadId=${threadId}`));

    expect(response.status, yield* response.text).toBe(404);
  }),
);

httpTest("returns the exact harness identifier for a live session", "operate", (client) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    const occurrence = NativeSessionRegistry.beginNativeSession(threadId);
    NativeSessionRegistry.announceNativeSession(occurrence, nativeSessionId);

    const response = yield* client.get(lookupPath(`threadId=${encodeURIComponent(threadId)}`));
    const text = yield* response.text;

    expect(response.status, text).toBe(200);
    expect(decodeLookupBody(text)).toStrictEqual({ nativeSessionId });
  }),
);

httpTest("never answers one thread with another thread's identifier", "operate", (client) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    const occurrence = NativeSessionRegistry.beginNativeSession(threadId);
    NativeSessionRegistry.announceNativeSession(occurrence, nativeSessionId);

    const response = yield* client.get(lookupPath(`threadId=${alternateThreadId}`));

    expect(response.status, yield* response.text).toBe(404);
  }),
);

// ---------------------------------------------------------------------------
// Claude Agent adapter
// ---------------------------------------------------------------------------

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<(value: IteratorResult<SDKMessage>) => void> = [];
  private done = false;

  emit(message: SDKMessage): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  readonly setModel = async (_model?: string): Promise<void> => {};
  readonly setPermissionMode = async (_mode: PermissionMode): Promise<void> => {};
  readonly setMaxThinkingTokens = async (_tokens: number | null): Promise<void> => {};
  readonly close = (): void => {
    this.done = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ done: true, value: undefined as unknown as SDKMessage });
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.done)
          return Promise.resolve({ done: true, value: undefined as unknown as SDKMessage });
        return new Promise<IteratorResult<SDKMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

const claudeInit = (sessionId: string, uuid: string): SDKMessage =>
  ({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "test",
    cwd: "/tmp/native-session-lookup",
    tools: [],
    mcp_servers: [],
    model: "claude-synthetic-standard",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    session_id: sessionId,
    uuid,
  }) as unknown as SDKMessage;

const makeClaudeHarness = () => {
  const queries: Array<FakeClaudeQuery> = [];
  const layer = Layer.effect(
    ClaudeAdapterUnderTest,
    Effect.gen(function* () {
      return yield* makeClaudeAdapter(decodeClaudeSettings({}), {
        modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
        createQuery: (_input: {
          readonly prompt: AsyncIterable<SDKUserMessage>;
          readonly options: ClaudeQueryOptions;
        }) => {
          const query = new FakeClaudeQuery();
          queries.push(query);
          return query;
        },
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest("/tmp/native-session-lookup", "/tmp")),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, queries };
};

/** A fixed sequence, so identifiers the adapter mints do not vary per run. */
const makeDeterministicRandomService = (): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} => {
  let state = 0x1234_5678;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };
  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
};

/** Lets the adapter's message pump drain what the fake query emitted. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 40; index += 1) {
    yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }
});

const claudeTest = <E>(
  name: string,
  body: (
    harness: ReturnType<typeof makeClaudeHarness>,
  ) => Effect.Effect<void, E, ClaudeAdapterUnderTest>,
) =>
  it.effect(name, () => {
    const harness = makeClaudeHarness();
    return Effect.scoped(body(harness)).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

claudeTest("announces the Claude session id the harness gives its hooks", (harness) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    const adapter = yield* ClaudeAdapterUnderTest;
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBeUndefined();

    harness.queries[0]?.emit(claudeInit(nativeSessionId, "init-1"));
    yield* settle;

    expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe(nativeSessionId);
  }),
);

claudeTest("keeps the Claude session id across later turns in the same session", (harness) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    const adapter = yield* ClaudeAdapterUnderTest;
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    harness.queries[0]?.emit(claudeInit(nativeSessionId, "init-1"));
    yield* settle;

    harness.queries[0]?.emit(claudeInit(nativeSessionId, "init-2"));
    yield* settle;

    expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe(nativeSessionId);
  }),
);

claudeTest("clears the Claude session id when a replacement session starts", (harness) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    const adapter = yield* ClaudeAdapterUnderTest;
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    harness.queries[0]?.emit(claudeInit(nativeSessionId, "init-1"));
    yield* settle;

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    yield* settle;

    expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBeUndefined();

    harness.queries[1]?.emit(claudeInit("replacement-session", "init-2"));
    yield* settle;

    expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe("replacement-session");
  }),
);

claudeTest("clears the Claude session id when the session stops", (harness) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    const adapter = yield* ClaudeAdapterUnderTest;
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    harness.queries[0]?.emit(claudeInit(nativeSessionId, "init-1"));
    yield* settle;

    yield* adapter.stopSession(threadId);
    yield* settle;

    expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBeUndefined();
  }),
);

claudeTest("learns the Claude session id again when a thread resumes", (harness) =>
  Effect.gen(function* () {
    // A restart loses the in-memory record; the next session start restores it,
    // which is the earliest moment a Stop hook can fire again.
    NativeSessionRegistry.clearAllNativeSessions();
    const adapter = yield* ClaudeAdapterUnderTest;
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      resumeCursor: {
        threadId,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        turnCount: 1,
      },
      runtimeMode: "full-access",
    });
    harness.queries[0]?.emit(claudeInit(nativeSessionId, "resume-init"));
    yield* settle;

    expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe(nativeSessionId);
  }),
);

claudeTest("keeps one Claude thread's session id out of another thread", (harness) =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    const adapter = yield* ClaudeAdapterUnderTest;
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    yield* adapter.startSession({
      threadId: alternateThreadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    harness.queries[0]?.emit(claudeInit(nativeSessionId, "init-alpha"));
    yield* settle;

    expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe(nativeSessionId);
    expect(NativeSessionRegistry.readNativeSessionId(alternateThreadId)).toBeUndefined();
  }),
);

// ---------------------------------------------------------------------------
// Codex adapter
// ---------------------------------------------------------------------------

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly now = "2026-01-01T00:00:00.000Z";

  readonly options: CodexSessionRuntimeOptions;
  private readonly providerThreadId: string;

  constructor(options: CodexSessionRuntimeOptions, providerThreadId: string) {
    this.options = options;
    this.providerThreadId = providerThreadId;
  }

  start() {
    return Effect.succeed({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      createdAt: this.now,
      updatedAt: this.now,
      resumeCursor: { threadId: this.providerThreadId },
    });
  }

  get getSession() {
    return this.start();
  }

  sendTurn = vi.fn(() => Effect.die("unused")) as unknown as CodexSessionRuntimeShape["sendTurn"];
  interruptTurn = vi.fn(() => Effect.void) as unknown as CodexSessionRuntimeShape["interruptTurn"];
  readonly compactThread = Effect.void;
  readonly readThread = Effect.die("unused") as never;
  rollbackThread = vi.fn(() =>
    Effect.die("unused"),
  ) as unknown as CodexSessionRuntimeShape["rollbackThread"];
  uploadFeedback = vi.fn(() =>
    Effect.die("unused"),
  ) as unknown as CodexSessionRuntimeShape["uploadFeedback"];
  respondToRequest = vi.fn(
    () => Effect.void,
  ) as unknown as CodexSessionRuntimeShape["respondToRequest"];
  respondToUserInput = vi.fn(
    () => Effect.void,
  ) as unknown as CodexSessionRuntimeShape["respondToUserInput"];
  readonly close = Effect.void;

  get events() {
    return Stream.never;
  }
}

const makeCodexHarness = (providerThreadIds: ReadonlyArray<string>) => {
  let started = 0;
  const runtimes: Array<FakeCodexRuntime> = [];
  const layer = Layer.effect(
    CodexAdapterUnderTest,
    makeCodexAdapter(decodeCodexSettings({}), {
      makeRuntime: (runtimeOptions: CodexSessionRuntimeOptions) =>
        Effect.gen(function* () {
          yield* Scope.Scope;
          const providerThreadId = providerThreadIds[started] ?? "unused";
          started += 1;
          const runtime = new FakeCodexRuntime(runtimeOptions, providerThreadId);
          runtimes.push(runtime);
          return runtime;
        }) as never,
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      Layer.succeed(ProviderSessionDirectory, {
        upsert: () => Effect.void,
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        getBinding: () => Effect.succeed(Option.none()),
        listThreadIds: () => Effect.succeed([]),
        listBindings: () => Effect.succeed([]),
      } as unknown as ProviderSessionDirectory["Service"]),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, runtimes };
};

const codexTest = <E>(
  name: string,
  providerThreadIds: ReadonlyArray<string>,
  body: (harness: {
    readonly runtimes: Array<FakeCodexRuntime>;
  }) => Effect.Effect<void, E, CodexAdapterUnderTest>,
) =>
  it.effect(name, () => {
    const harness = makeCodexHarness(providerThreadIds);
    return Effect.scoped(body(harness)).pipe(Effect.provide(harness.layer));
  });

codexTest(
  "announces the native Codex thread id the start response carries",
  [nativeSessionId],
  () =>
    Effect.gen(function* () {
      NativeSessionRegistry.clearAllNativeSessions();
      const adapter = yield* CodexAdapterUnderTest;
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        runtimeMode: "full-access",
      });

      expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe(nativeSessionId);
    }),
);

codexTest(
  "announces the native Codex thread id a resume response carries",
  ["resumed-native-session"],
  () =>
    Effect.gen(function* () {
      NativeSessionRegistry.clearAllNativeSessions();
      const adapter = yield* CodexAdapterUnderTest;
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        resumeCursor: { threadId: "resumed-native-session" },
        runtimeMode: "full-access",
      });

      expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe("resumed-native-session");
    }),
);

codexTest(
  "replaces the native Codex thread id when a replacement session starts",
  [nativeSessionId, "replacement-session"],
  () =>
    Effect.gen(function* () {
      NativeSessionRegistry.clearAllNativeSessions();
      const adapter = yield* CodexAdapterUnderTest;
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        runtimeMode: "full-access",
      });

      expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe("replacement-session");
    }),
);

codexTest("clears the native Codex thread id when the session stops", [nativeSessionId], () =>
  Effect.gen(function* () {
    NativeSessionRegistry.clearAllNativeSessions();
    const adapter = yield* CodexAdapterUnderTest;
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      runtimeMode: "full-access",
    });

    yield* adapter.stopSession(threadId);

    expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBeUndefined();
  }),
);

codexTest(
  "keeps one Codex thread's native id out of another thread",
  [nativeSessionId, "beta-session"],
  () =>
    Effect.gen(function* () {
      NativeSessionRegistry.clearAllNativeSessions();
      const adapter = yield* CodexAdapterUnderTest;
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId: alternateThreadId,
        provider: ProviderDriverKind.make("codex"),
        runtimeMode: "full-access",
      });

      expect(NativeSessionRegistry.readNativeSessionId(threadId)).toBe(nativeSessionId);
      expect(NativeSessionRegistry.readNativeSessionId(alternateThreadId)).toBe("beta-session");
    }),
);
