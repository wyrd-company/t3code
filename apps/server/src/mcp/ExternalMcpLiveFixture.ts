// ---
// relationships:
//   validates: external-mcp-registration
// ---
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

export const EXTERNAL_MCP_LIVE_TOOL_NAME = "t3_external_mcp_nonce";

export interface ExternalMcpLiveFixtureCall {
  readonly nonce: string;
}

export interface ExternalMcpLiveFixture {
  readonly endpoint: string;
  readonly calls: ReadonlyArray<ExternalMcpLiveFixtureCall>;
  readonly stop: () => Promise<void>;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const readBody = (request: NodeHttp.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer | string) =>
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const writeJson = (response: NodeHttp.ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
};

const rpcResult = (id: unknown, result: unknown) => ({
  jsonrpc: "2.0",
  id,
  result,
});

export async function startExternalMcpLiveFixture(input: {
  readonly authorizationHeader: string;
  readonly nonce: string;
  /**
   * Interface to bind. Defaults to loopback. A probe whose T3 server runs in
   * another network namespace must bind an interface that namespace can reach.
   */
  readonly hostname?: string;
  /** Host the endpoint advertises, when it differs from the bound interface. */
  readonly advertisedHost?: string;
}): Promise<ExternalMcpLiveFixture> {
  const calls: Array<ExternalMcpLiveFixtureCall> = [];
  const server = NodeHttp.createServer(async (request, response) => {
    if (request.headers.authorization !== input.authorizationHeader) {
      response.writeHead(401, {
        "cache-control": "no-store",
        "www-authenticate": "Bearer",
      });
      response.end();
      return;
    }

    if (request.method === "DELETE") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST, DELETE" });
      response.end();
      return;
    }

    let message: JsonRpcRequest;
    try {
      message = JSON.parse(await readBody(request)) as JsonRpcRequest;
    } catch {
      writeJson(response, 400, { error: "invalid_json" });
      return;
    }

    if (message.method === "notifications/initialized") {
      response.writeHead(202, { "cache-control": "no-store" });
      response.end();
      return;
    }

    if (message.method === "initialize") {
      const params = message.params as { readonly protocolVersion?: unknown } | undefined;
      writeJson(
        response,
        200,
        rpcResult(message.id, {
          protocolVersion:
            typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: {
            name: "t3-external-mcp-live-fixture",
            version: "1.0.0",
          },
        }),
      );
      return;
    }

    if (message.method === "tools/list") {
      writeJson(
        response,
        200,
        rpcResult(message.id, {
          tools: [
            {
              name: EXTERNAL_MCP_LIVE_TOOL_NAME,
              description: "Return the nonce supplied by the live probe.",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["nonce"],
                properties: { nonce: { type: "string" } },
              },
            },
          ],
        }),
      );
      return;
    }

    if (message.method === "tools/call") {
      const params = message.params as
        | {
            readonly name?: unknown;
            readonly arguments?: { readonly nonce?: unknown };
          }
        | undefined;
      if (params?.name !== EXTERNAL_MCP_LIVE_TOOL_NAME || params.arguments?.nonce !== input.nonce) {
        writeJson(response, 200, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "Invalid tool call" },
        });
        return;
      }
      calls.push({ nonce: input.nonce });
      writeJson(
        response,
        200,
        rpcResult(message.id, {
          content: [{ type: "text", text: input.nonce }],
          structuredContent: { nonce: input.nonce },
          isError: false,
        }),
      );
      return;
    }

    writeJson(response, 200, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, input.hostname ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("External MCP live fixture did not bind a TCP address.");
  }

  return {
    endpoint: `http://${input.advertisedHost ?? "127.0.0.1"}:${address.port}/mcp`,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
