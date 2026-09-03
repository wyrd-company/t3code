import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { startCursorMcpGateway } from "./CursorMcpGateway.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

interface FixtureServer {
  readonly endpoint: string;
  readonly authorizationHeaders: Array<string | undefined>;
  readonly close: () => void;
}

const startFixtureServer = (input: {
  readonly toolName: string;
  readonly response: string;
}): Effect.Effect<FixtureServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const nodeHttp = yield* Effect.promise(() => import("node:http"));
    return yield* Effect.acquireRelease(
      Effect.callback<FixtureServer>((resume) => {
        const authorizationHeaders: Array<string | undefined> = [];
        const server = nodeHttp.createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          request.on("end", () => {
            authorizationHeaders.push(request.headers.authorization);
            const body = Buffer.concat(chunks).toString("utf8");
            if (body.length === 0) {
              response.writeHead(request.method === "DELETE" ? 200 : 405).end();
              return;
            }
            const message = JSON.parse(body) as {
              readonly id?: string | number;
              readonly method: string;
              readonly params?: { readonly name?: string };
            };
            if (message.method === "notifications/initialized") {
              response.writeHead(202).end();
              return;
            }
            const result =
              message.method === "initialize"
                ? {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "fixture", version: "1.0.0" },
                  }
                : message.method === "tools/list"
                  ? {
                      tools: [
                        {
                          name: input.toolName,
                          description: "fixture tool",
                          inputSchema: { type: "object", properties: {} },
                        },
                      ],
                    }
                  : {
                      content: [
                        {
                          type: "text",
                          text: `${input.response}:${message.params?.name ?? "unknown"}`,
                        },
                      ],
                    };
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address && typeof address === "object") {
            resume(
              Effect.succeed({
                endpoint: `http://127.0.0.1:${address.port}/mcp`,
                authorizationHeaders,
                close: () => server.close(),
              }),
            );
          }
        });
        return Effect.sync(() => server.close());
      }),
      (fixture) => Effect.sync(fixture.close),
    );
  });

const environmentId = EnvironmentId.make("environment-gateway-test");
const threadId = ThreadId.make("thread-gateway-test");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const fakeHttpServer = (endpoint: string) => {
  const url = new URL(endpoint);
  return HttpServer.HttpServer.of({
    address: {
      _tag: "TcpAddress",
      hostname: url.hostname,
      port: Number(url.port),
    },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
};

const connectGateway = (endpoint: string, authorizationHeader: string) =>
  Effect.tryPromise(() => {
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: authorizationHeader } },
    });
    return client.connect(transport as Parameters<Client["connect"]>[0]).then(() => client);
  });

const withGateway = Effect.fn("CursorMcpGatewayTest.withGateway")(function* (input: {
  readonly internalToolName?: string;
  readonly externalToolName?: string;
}) {
  const internalFixture = yield* startFixtureServer({
    toolName: input.internalToolName ?? "internal_tool",
    response: "internal",
  });
  const externalFixture = yield* startFixtureServer({
    toolName: input.externalToolName ?? "external_tool",
    response: "external",
  });
  const sessionScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(sessionScope, Exit.void));
  const registryScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(registryScope, Exit.void));
  const registryServices = yield* Layer.buildWithScope(
    McpSessionRegistry.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpServer.HttpServer, fakeHttpServer(internalFixture.endpoint)),
          Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
    registryScope,
  );
  const issued = yield* McpSessionRegistry.issueActiveMcpCredential({
    threadId,
    providerInstanceId: ProviderInstanceId.make("cursor"),
  });
  if (!issued) return yield* Effect.die("registry did not issue credential");
  const sessions: ReadonlyArray<McpProviderSession.McpProviderSessionConfig> = [
    issued.config,
    {
      name: "external",
      source: "external",
      threadId,
      endpoint: externalFixture.endpoint,
      authorizationHeader: "Bearer external-secret",
      browserToolsAvailable: false,
    },
  ];
  McpProviderSession.setExternalMcpProviderSession(sessions[1]!);
  return {
    internalFixture,
    externalFixture,
    issued,
    sessions,
    sessionScope,
    registry: Context.get(registryServices, McpSessionRegistry.McpSessionRegistry),
  };
});

it.effect("routes raw tool names and contains downstream credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* withGateway({});
      const gateway = yield* startCursorMcpGateway({
        sessions: fixture.sessions,
        scope: fixture.sessionScope,
      });
      McpProviderSession.clearExternalMcpProviderSession(threadId);
      const client = yield* connectGateway(gateway.endpoint, gateway.authorizationHeader);
      const listed = yield* Effect.promise(() => client.listTools());
      expect(listed.tools.map(({ name }) => name)).toEqual(["internal_tool", "external_tool"]);
      expect(
        yield* Effect.promise(() => client.callTool({ name: "internal_tool", arguments: {} })),
      ).toMatchObject({
        content: [{ type: "text", text: "internal:internal_tool" }],
      });
      expect(
        yield* Effect.promise(() => client.callTool({ name: "external_tool", arguments: {} })),
      ).toMatchObject({
        content: [{ type: "text", text: "external:external_tool" }],
      });
      expect(fixture.externalFixture.authorizationHeaders).toContain("Bearer external-secret");
      expect(gateway.authorizationHeader).toBe(fixture.issued.config.authorizationHeader);
      yield* Effect.promise(() => client.close());
    }),
  ),
);

it.effect("rejects another thread credential and closes on provider stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* withGateway({});
      const gateway = yield* startCursorMcpGateway({
        sessions: fixture.sessions,
        scope: fixture.sessionScope,
      });
      const other = yield* fixture.registry.issue({
        threadId: ThreadId.make("thread-gateway-other"),
        providerInstanceId: ProviderInstanceId.make("cursor"),
      });
      const crossThread = yield* connectGateway(
        gateway.endpoint,
        other.config.authorizationHeader,
      ).pipe(Effect.exit);
      expect(Exit.isFailure(crossThread)).toBe(true);

      yield* Scope.close(fixture.sessionScope, Exit.void);
      const stopped = yield* connectGateway(gateway.endpoint, gateway.authorizationHeader).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(stopped)).toBe(true);
    }),
  ),
);

it.effect("rejects duplicate raw tool names before returning a gateway", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* withGateway({
        internalToolName: "duplicate_tool",
        externalToolName: "duplicate_tool",
      });
      const exit = yield* startCursorMcpGateway({
        sessions: fixture.sessions,
        scope: fixture.sessionScope,
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("MCP tool name collision: 'duplicate_tool'");
    }),
  ),
);

it.effect("closes the loopback gateway on credential revocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* withGateway({});
      const gateway = yield* startCursorMcpGateway({
        sessions: fixture.sessions,
        scope: fixture.sessionScope,
      });
      yield* fixture.registry.revokeProviderSession(fixture.issued.config.providerSessionId);
      const exit = yield* Effect.tryPromise(() => fetch(gateway.endpoint)).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  ),
);
