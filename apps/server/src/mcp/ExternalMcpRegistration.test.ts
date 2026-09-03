import { NodeHttpServer } from "@effect/platform-node";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { mcpServerForThread } from "../provider/Layers/ClaudeAdapter.ts";
import { mcpRuntimeOptionsForThread } from "../provider/Layers/CodexAdapter.ts";
import { EXTERNAL_MCP_REGISTRATION_PATH, layer } from "./ExternalMcpRegistration.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

const threadId = ThreadId.make("thread-external-mcp-test");
const endpoint = "https://mcp.example.test/session";
const authorizationHeader = "Bearer external-mcp-test-token";

const authenticatedSession = (
  scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make("external-mcp-registration-test"),
  subject: "external-mcp-registration-test",
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

const serve = HttpRouter.serve(layer, { disableListenLog: true, disableLogger: true });

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
  ).pipe(Effect.provide(Layer.mergeAll(authLayer("missing"), NodeHttpServer.layerTest))),
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
  ).pipe(Effect.provide(Layer.mergeAll(authLayer("read"), NodeHttpServer.layerTest))),
);

it.effect("rejects malformed external MCP registration without returning its secret", () =>
  Effect.scoped(
    Effect.gen(function* () {
      McpProviderSession.clearAllMcpProviderSessions();
      yield* serve.pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.put(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: HttpBody.jsonUnsafe({
          threadId,
          endpoint: "file:///tmp/not-http",
          authorizationHeader: "secret-without-bearer-scheme",
        }),
      });
      const body = yield* response.text;

      expect(response.status).toBe(400);
      expect(body).not.toContain("secret-without-bearer-scheme");
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)).toBeUndefined();
    }),
  ).pipe(Effect.provide(Layer.mergeAll(authLayer("operate"), NodeHttpServer.layerTest))),
);

it.effect("registers, plumbs, and clears one external MCP session for Claude and Codex", () =>
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
      expect(mcpServerForThread(threadId)).toEqual({
        "t3-code": {
          type: "http",
          url: endpoint,
          headers: { Authorization: authorizationHeader },
        },
      });
      expect(mcpRuntimeOptionsForThread(threadId, { EXISTING: "kept" })).toEqual({
        browserToolsAvailable: false,
        environment: {
          EXISTING: "kept",
          T3_MCP_BEARER_TOKEN: "external-mcp-test-token",
        },
        appServerArgs: [
          "-c",
          `mcp_servers.t3-code.url=${endpoint}`,
          "-c",
          'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
        ],
      });

      const clear = yield* client.del(EXTERNAL_MCP_REGISTRATION_PATH, {
        body: HttpBody.jsonUnsafe({ threadId }),
      });
      expect(clear.status).toBe(204);
      expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)).toBeUndefined();
    }),
  ).pipe(Effect.provide(Layer.mergeAll(authLayer("operate"), NodeHttpServer.layerTest))),
);

it("keeps external registration when the internal credential path clears or replaces a thread", () => {
  McpProviderSession.clearAllMcpProviderSessions();
  McpProviderSession.setExternalMcpProviderSession({ threadId, endpoint, authorizationHeader });

  McpProviderSession.setMcpProviderSession({
    source: "internal",
    environmentId: EnvironmentId.make("environment-external-mcp-test"),
    threadId,
    providerSessionId: "provider-session-external-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1/internal-mcp",
    authorizationHeader: "Bearer internal-mcp-token",
    browserToolsAvailable: true,
  });
  McpProviderSession.clearInternalMcpProviderSession(threadId);
  expect(McpProviderSession.readMcpProviderSessionIncludingExternal(threadId)?.source).toBe(
    "external",
  );
});
