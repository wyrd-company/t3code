import { NodeHttpServer } from "@effect/platform-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as McpProviderSession from "./McpProviderSession.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

export class CursorMcpGatewayStartupError extends Data.TaggedError("CursorMcpGatewayStartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface Downstream {
  readonly name: string;
  readonly client: Client;
  readonly close: () => Promise<void>;
}

export interface CursorMcpGatewayConfig {
  readonly name: typeof McpProviderSession.INTERNAL_MCP_SERVER_NAME;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

const bearerToken = (authorizationHeader: string) =>
  authorizationHeader.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length).trim()
    : "";

const connectDownstream = (
  config: McpProviderSession.McpProviderSessionConfig,
): Effect.Effect<Downstream, CursorMcpGatewayStartupError> =>
  Effect.tryPromise({
    try: async () => {
      const client = new Client({
        name: "t3-code-cursor-gateway",
        version: packageJson.version,
      });
      const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
        requestInit: {
          headers: { Authorization: config.authorizationHeader },
        },
      });
      await client.connect(transport as Parameters<Client["connect"]>[0]);
      return { name: config.name, client, close: () => client.close() };
    },
    catch: (cause) =>
      new CursorMcpGatewayStartupError({
        message: `Failed to initialize MCP downstream '${config.name}'.`,
        cause,
      }),
  });

const closeDownstreams = (downstreams: ReadonlyArray<Downstream>) =>
  Effect.forEach(
    downstreams,
    (downstream) => Effect.promise(() => downstream.close()).pipe(Effect.ignore),
    { discard: true },
  );

const toEffectContent = (content: ReadonlyArray<Record<string, unknown>>) =>
  content.map((block) => {
    if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
      return {
        ...block,
        data: new Uint8Array(Buffer.from(block.data, "base64")),
      };
    }
    return block;
  }) as Array<typeof McpSchema.ContentBlock.Type>;

type GatewayHttpEffect = Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>;

type GatewayAuthMiddleware = (
  effect: GatewayHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

const authMiddleware = (input: {
  readonly threadId: McpProviderSession.InternalMcpProviderSessionConfig["threadId"];
  readonly providerSessionId: string;
}) => {
  const middleware: GatewayAuthMiddleware = Effect.fn("CursorMcpGateway.authenticate")(
    function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const presented = bearerToken(request.headers.authorization ?? "");
      const invocation = yield* McpSessionRegistry.resolveActiveMcpCredential(presented);
      if (
        invocation?.threadId !== input.threadId ||
        invocation.providerSessionId !== input.providerSessionId
      ) {
        return HttpServerResponse.empty({ status: 401 });
      }
      return yield* httpEffect;
    },
  );
  return HttpRouter.middleware()(middleware).layer;
};

/**
 * Starts one loopback MCP server for a Cursor provider session. The caller
 * supplies the provider session scope; closing it closes the listener and all
 * downstream MCP clients.
 */
export const startCursorMcpGateway = Effect.fn("CursorMcpGateway.start")(function* (input: {
  readonly sessions: ReadonlyArray<McpProviderSession.McpProviderSessionConfig>;
  readonly scope: Scope.Closeable;
}) {
  const internal = input.sessions.find(
    (entry): entry is McpProviderSession.InternalMcpProviderSessionConfig =>
      entry.source === "internal",
  );
  if (!internal) {
    return yield* new CursorMcpGatewayStartupError({
      message: "Cursor MCP aggregation requires an internal provider credential.",
    });
  }

  const downstreams: Array<Downstream> = [];
  for (const session of input.sessions) {
    const downstream = yield* connectDownstream(session).pipe(
      Effect.tapError(() => closeDownstreams(downstreams)),
    );
    downstreams.push(downstream);
  }
  yield* Scope.addFinalizer(input.scope, closeDownstreams(downstreams));

  const advertised = yield* Effect.forEach(
    downstreams,
    (downstream) =>
      Effect.tryPromise({
        try: () => downstream.client.listTools(),
        catch: (cause) =>
          new CursorMcpGatewayStartupError({
            message: `Failed to list tools from MCP downstream '${downstream.name}'.`,
            cause,
          }),
      }).pipe(Effect.map((result) => ({ downstream, tools: result.tools }))),
    { concurrency: "unbounded" },
  );
  const owners = new Map<string, Downstream>();
  for (const { downstream, tools } of advertised) {
    for (const tool of tools) {
      if (owners.has(tool.name)) {
        return yield* new CursorMcpGatewayStartupError({
          message: `MCP tool name collision: '${tool.name}'.`,
        });
      }
      owners.set(tool.name, downstream);
    }
  }

  const registerTools = Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const { downstream, tools } of advertised) {
      for (const tool of tools) {
        yield* server.addTool({
          tool: new McpSchema.Tool({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          }),
          annotations: Context.empty(),
          handle: (payload) =>
            Effect.tryPromise({
              try: () =>
                downstream.client.callTool({
                  name: tool.name,
                  arguments: payload,
                }),
              catch: () =>
                new McpSchema.InternalError({
                  message: "Downstream MCP tool call failed.",
                }),
            }).pipe(
              Effect.map(
                (result) =>
                  new McpSchema.CallToolResult({
                    content: toEffectContent(result.content as Array<Record<string, unknown>>),
                    ...(typeof result.structuredContent !== "object" ||
                    result.structuredContent === null
                      ? {}
                      : { structuredContent: result.structuredContent }),
                    ...(typeof result.isError !== "boolean" ? {} : { isError: result.isError }),
                  }),
              ),
            ),
        });
      }
    }
  });

  const transport = McpServer.layerHttp({
    name: "T3 Code Cursor Gateway",
    version: packageJson.version,
    path: "/mcp",
    protocols: [McpProtocol.v2025_06_18],
  }).pipe(
    Layer.provide(
      authMiddleware({
        threadId: internal.threadId,
        providerSessionId: internal.providerSessionId,
      }),
    ),
  );
  const registrations = Layer.effectDiscard(registerTools).pipe(Layer.provideMerge(transport));
  const nodeHttp = yield* Effect.promise(() => import("node:http"));
  const application = HttpRouter.serve(registrations, {
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(nodeHttp.createServer, {
        host: "127.0.0.1",
        port: 0,
      }),
    ),
  );
  const services = yield* Layer.buildWithScope(application, input.scope).pipe(
    Effect.mapError(
      (cause) =>
        new CursorMcpGatewayStartupError({
          message: "Failed to start Cursor MCP gateway.",
          cause,
        }),
    ),
  );
  const address = Context.get(services, HttpServer.HttpServer).address;
  if (address._tag !== "TcpAddress") {
    return yield* new CursorMcpGatewayStartupError({
      message: "Cursor MCP gateway did not bind a TCP listener.",
    });
  }

  yield* McpSessionRegistry.onActiveMcpProviderSessionRevoked(
    internal.providerSessionId,
    Scope.close(input.scope, Exit.void),
  ).pipe(Effect.provideService(Scope.Scope, input.scope));

  return {
    name: McpProviderSession.INTERNAL_MCP_SERVER_NAME,
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    authorizationHeader: internal.authorizationHeader,
  } satisfies CursorMcpGatewayConfig;
});
