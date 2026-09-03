import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { attachClaudeMcpForThread } from "../provider/Layers/ClaudeAdapter.ts";
import { attachCodexMcpForThread } from "../provider/Layers/CodexAdapter.ts";
import { attachCursorMcpForThread } from "../provider/Layers/CursorAdapter.ts";
import { attachGrokMcpForThread } from "../provider/Layers/GrokAdapter.ts";
import { addOpenCodeMcpForThread } from "../provider/Layers/OpenCodeAdapter.ts";
import { EXTERNAL_MCP_REGISTRATION_PATH } from "./ExternalMcpRegistration.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const threadId = ThreadId.make("thread-alpha");
const alternateThreadId = ThreadId.make("thread-beta");
const endpoint = "https://service.example.test/api";
const authorizationHeader = "Bearer token-alpha";

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
const mcpSessionRegistryLayer = McpSessionRegistry.layer.pipe(
  Layer.provide(serverEnvironmentLayer),
);
const serve = HttpRouter.serve(
  McpHttpServer.layer.pipe(
    Layer.provide(mcpSessionRegistryLayer),
    Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
  ),
  { disableListenLog: true, disableLogger: true },
);

const registrationBody = HttpBody.jsonUnsafe({
  threadId,
  endpoint,
  authorizationHeader,
});

it.effect("rejects unauthenticated external MCP registration without changing the thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.put(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: registrationBody,
      });

      expect(response.status, yield* response.text).toBe(401);
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)).toBeUndefined();
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(authLayer("missing"), NodeHttpServer.layerTest, NodeServices.layer),
    ),
  ),
);

it.effect("rejects external MCP registration without orchestration operate scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.put(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: registrationBody,
      });

      expect(response.status, yield* response.text).toBe(403);
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)).toBeUndefined();
    }),
  ).pipe(
    Effect.provide(Layer.mergeAll(authLayer("read"), NodeHttpServer.layerTest, NodeServices.layer)),
  ),
);

it.effect("rejects unauthenticated external MCP clear without changing the thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      McpProviderSession.setExternalMcpProviderSession({
        threadId,
        endpoint,
        authorizationHeader,
      });
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.del(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: HttpBody.jsonUnsafe({ threadId }),
      });

      expect(response.status, yield* response.text).toBe(401);
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)?.source).toBe(
        "external",
      );
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(authLayer("missing"), NodeHttpServer.layerTest, NodeServices.layer),
    ),
  ),
);

it.effect("rejects external MCP clear without orchestration operate scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      McpProviderSession.setExternalMcpProviderSession({
        threadId,
        endpoint,
        authorizationHeader,
      });
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.del(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: HttpBody.jsonUnsafe({ threadId }),
      });

      expect(response.status, yield* response.text).toBe(403);
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)?.source).toBe(
        "external",
      );
    }),
  ).pipe(
    Effect.provide(Layer.mergeAll(authLayer("read"), NodeHttpServer.layerTest, NodeServices.layer)),
  ),
);

it.effect("rejects a non-HTTP external MCP endpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.put(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: HttpBody.jsonUnsafe({
          threadId,
          endpoint: "file:///tmp/not-http",
          authorizationHeader,
        }),
      });
      const body = yield* response.text;

      expect(response.status).toBe(400);
      expect(body).not.toContain(authorizationHeader);
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)).toBeUndefined();
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(authLayer("operate"), NodeHttpServer.layerTest, NodeServices.layer),
    ),
  ),
);

it.effect("rejects a non-Bearer external MCP authorization header without returning it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const secret = "secret-without-bearer-scheme";
      const response = yield* client.put(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: HttpBody.jsonUnsafe({
          threadId,
          endpoint,
          authorizationHeader: secret,
        }),
      });
      const body = yield* response.text;

      expect(response.status).toBe(400);
      expect(body).not.toContain(secret);
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)).toBeUndefined();
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(authLayer("operate"), NodeHttpServer.layerTest, NodeServices.layer),
    ),
  ),
);

it.effect("rejects whitespace, CRLF, and oversized Bearer authorization tokens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      for (const invalidHeader of [
        "Bearer token with-spaces",
        "Bearer token-alpha\r\nX-Injected: value",
        `Bearer ${"x".repeat(8193)}`,
      ]) {
        const response = yield* client.put(EXTERNAL_MCP_REGISTRATION_PATH, {
          body: HttpBody.jsonUnsafe({ threadId, endpoint, authorizationHeader: invalidHeader }),
        });
        expect(response.status).toBe(400);
      }
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)).toBeUndefined();
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(authLayer("operate"), NodeHttpServer.layerTest, NodeServices.layer),
    ),
  ),
);

it.effect("registering external MCP preserves the active internal credential", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      const services = yield* Layer.merge(serve, mcpSessionRegistryLayer).pipe(Layer.build);
      const registry = Context.get(services, McpSessionRegistry.McpSessionRegistry);
      const issued = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const rawToken = issued?.config.authorizationHeader.slice("Bearer ".length);
      expect(rawToken).toBeDefined();
      expect(yield* registry.resolve(rawToken!)).toMatchObject({ threadId });
      McpProviderSession.setMcpProviderSession(issued!.config);

      const client = yield* HttpClient.HttpClient;
      const response = yield* client.put(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: registrationBody,
      });

      expect(response.status).toBe(204);
      expect(yield* registry.resolve(rawToken!)).toMatchObject({ threadId });
      expect(McpProviderSession.readMcpProviderSessions(threadId).map(({ name }) => name)).toEqual([
        "t3-code",
        "external",
      ]);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(authLayer("operate"), NodeHttpServer.layerTest, NodeServices.layer),
    ),
  ),
);

it.effect("rejects a blank external MCP thread ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.put(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: HttpBody.jsonUnsafe({
          threadId: " ",
          endpoint,
          authorizationHeader,
        }),
      });

      expect(response.status).toBe(400);
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)).toBeUndefined();
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(authLayer("operate"), NodeHttpServer.layerTest, NodeServices.layer),
    ),
  ),
);

it.effect("rejects an external MCP name collision with the internal t3-code entry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.put(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: HttpBody.jsonUnsafe({
          name: "t3-code",
          threadId,
          endpoint,
          authorizationHeader,
        }),
      });

      expect(response.status).toBe(400);
      expect(McpProviderSession.readMcpProviderSessions(threadId)).toEqual([]);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(authLayer("operate"), NodeHttpServer.layerTest, NodeServices.layer),
    ),
  ),
);

it.effect("clears only the named external MCP entry and preserves the internal entry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      McpProviderSession.setMcpProviderSession({
        source: "internal",
        environmentId: EnvironmentId.make("environment-alpha"),
        threadId,
        providerSessionId: "provider-session-alpha",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1/internal",
        authorizationHeader: "Bearer token-internal",
        browserToolsAvailable: true,
      });
      McpProviderSession.setExternalMcpProviderSession({
        name: "workflow-one",
        threadId,
        endpoint,
        authorizationHeader,
      });
      McpProviderSession.setExternalMcpProviderSession({
        name: "workflow-two",
        threadId,
        endpoint: "https://service.example.test/other",
        authorizationHeader: "Bearer token-other",
      });
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.del(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: HttpBody.jsonUnsafe({ threadId, name: "workflow-one" }),
      });

      expect(response.status).toBe(204);
      expect(McpProviderSession.readMcpProviderSessions(threadId).map(({ name }) => name)).toEqual([
        "t3-code",
        "workflow-two",
      ]);
      expect(McpProviderSession.hasInternalMcpProviderSession(threadId)).toBe(true);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(authLayer("operate"), NodeHttpServer.layerTest, NodeServices.layer),
    ),
  ),
);

it.effect("registers and clears one external MCP session through the mounted server", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const register = yield* client.put(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: registrationBody,
      });

      expect(register.status, yield* register.text).toBe(204);
      expect(McpProviderSession.readMcpProviderSession(threadId)).toBeUndefined();
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)).toMatchObject({
        source: "external",
        name: "external",
        browserToolsAvailable: false,
      });
      McpProviderSession.setExternalMcpProviderSession({
        threadId: alternateThreadId,
        endpoint: "https://service.example.test/other",
        authorizationHeader: "Bearer token-beta",
      });

      const clear = yield* client.del(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: HttpBody.jsonUnsafe({ threadId }),
      });
      expect(clear.status).toBe(204);
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)).toBeUndefined();
      expect(
        McpProviderSession.readMcpProviderSessionIncludingExternal(alternateThreadId)?.threadId,
      ).toBe(alternateThreadId);
      McpProviderSession.clearAllMcpProviderSessions();
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(authLayer("operate"), NodeHttpServer.layerTest, NodeServices.layer),
    ),
  ),
);

const arrangeExternalRegistration = () => {
  McpProviderSession.clearAllMcpProviderSessions();
  McpProviderSession.setExternalMcpProviderSession({ threadId, endpoint, authorizationHeader });
};

it("attaches external MCP through the Claude Agent SDK query options", () => {
  arrangeExternalRegistration();
  expect(attachClaudeMcpForThread(threadId, { marker: "claude" })).toEqual({
    marker: "claude",
    mcpServers: {
      external: {
        type: "http",
        url: endpoint,
        headers: { Authorization: authorizationHeader },
      },
    },
  });
});

it("attaches external MCP through the Codex session runtime options", () => {
  arrangeExternalRegistration();
  expect(attachCodexMcpForThread(threadId, { marker: "codex" }, { EXISTING: "kept" })).toEqual({
    marker: "codex",
    environment: {
      EXISTING: "kept",
      T3_MCP_BEARER_TOKEN_EXTERNAL: "token-alpha",
    },
    appServerArgs: [
      "-c",
      `mcp_servers.external.url=${endpoint}`,
      "-c",
      'mcp_servers.external.bearer_token_env_var="T3_MCP_BEARER_TOKEN_EXTERNAL"',
    ],
  });
});

const acpMcpServers = [
  {
    type: "http",
    name: "external",
    url: endpoint,
    headers: [{ name: "Authorization", value: authorizationHeader }],
  },
];

it("attaches external MCP through the Cursor ACP runtime input", () => {
  arrangeExternalRegistration();
  expect(attachCursorMcpForThread(threadId, { marker: "cursor" })).toEqual({
    marker: "cursor",
    mcpServers: acpMcpServers,
  });
});

it("attaches external MCP through the Grok ACP runtime input", () => {
  arrangeExternalRegistration();
  expect(attachGrokMcpForThread(threadId, { marker: "grok" })).toEqual({
    marker: "grok",
    mcpServers: acpMcpServers,
  });
});

it.effect("attaches external MCP through the OpenCode SDK mcp.add call", () =>
  Effect.gen(function* () {
    arrangeExternalRegistration();
    const added: Array<unknown> = [];
    yield* addOpenCodeMcpForThread(threadId, false, (input) => {
      added.push(input);
      return Promise.resolve({});
    });
    expect(added).toEqual([
      {
        name: "external",
        config: {
          type: "remote",
          url: endpoint,
          headers: { Authorization: authorizationHeader },
          oauth: false,
        },
      },
    ]);
  }),
);

it.effect("skips external MCP installation for a shared external OpenCode server", () =>
  Effect.gen(function* () {
    arrangeExternalRegistration();
    let addCalls = 0;
    yield* addOpenCodeMcpForThread(threadId, true, () => {
      addCalls += 1;
      return Promise.resolve({});
    });
    expect(addCalls).toBe(0);
  }),
);

it("keeps internal and external MCP entries additive in either registration order", () => {
  McpProviderSession.clearAllMcpProviderSessions();
  McpProviderSession.setExternalMcpProviderSession({
    threadId,
    endpoint,
    authorizationHeader,
  });

  McpProviderSession.setMcpProviderSession({
    source: "internal",
    environmentId: EnvironmentId.make("environment-alpha"),
    threadId,
    providerSessionId: "provider-session-alpha",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1/service",
    authorizationHeader: "Bearer token-beta",
    browserToolsAvailable: true,
  });
  expect(McpProviderSession.readMcpProviderSessions(threadId).map(({ name }) => name)).toEqual([
    "external",
    "t3-code",
  ]);

  McpProviderSession.clearAllMcpProviderSessions();
  McpProviderSession.setMcpProviderSession({
    source: "internal",
    environmentId: EnvironmentId.make("environment-alpha"),
    threadId,
    providerSessionId: "provider-session-alpha",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1/service",
    authorizationHeader: "Bearer token-beta",
    browserToolsAvailable: true,
  });
  McpProviderSession.setExternalMcpProviderSession({ threadId, endpoint, authorizationHeader });
  expect(McpProviderSession.readMcpProviderSessions(threadId).map(({ name }) => name)).toEqual([
    "t3-code",
    "external",
  ]);

  McpProviderSession.clearMcpProviderSession(threadId);
  expect(McpProviderSession.readMcpProviderSessions(threadId).map(({ name }) => name)).toEqual([
    "external",
  ]);
});
