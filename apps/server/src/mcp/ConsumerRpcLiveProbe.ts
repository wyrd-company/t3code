// ---
// relationships:
//   validates: external-mcp-registration
// ---
// This probe deliberately speaks the raw wire a consumer speaks — global
// fetch, a plain interval, ISO timestamps — rather than Effect's idiomatic
// services, so that nothing it proves depends on running inside this codebase.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics globalConsole:off
//
// Consumer-path live probe.
//
// Proves the capability the fork exists to deliver: a client outside the
// server process registers its own MCP endpoint for a thread, starts a
// session over the RPC socket, and a real agent calls that tool. Every other
// test in this repository drives the server in-process; this one only ever
// speaks the wire a consumer speaks.
//
// The server under test is expected to be already running and reachable. The
// caller supplies its URL and a bearer token, so this script makes no
// assumption about how that server was installed.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { Effect, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { WsRpcGroup } from "@t3tools/contracts";

import {
  EXTERNAL_MCP_LIVE_TOOL_NAME,
  startExternalMcpLiveFixture,
} from "./ExternalMcpLiveFixture.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const httpUrl = required("T3_CONSUMER_PROBE_HTTP_URL");
const wsUrl = required("T3_CONSUMER_PROBE_WS_URL");
const token = required("T3_CONSUMER_PROBE_TOKEN");
// A fresh root per run: an existing project for the same root is an invariant
// failure, and reusing one would couple the probe to prior server state.
const workspaceRootBase = process.env.T3_CONSUMER_PROBE_WORKSPACE ?? "/home/vscode/consumer-probe";
const fixtureBind = process.env.T3_CONSUMER_PROBE_FIXTURE_BIND ?? "0.0.0.0";
const fixtureHost = process.env.T3_CONSUMER_PROBE_FIXTURE_HOST ?? "host.docker.internal";
const turnTimeoutMs = Number(process.env.T3_CONSUMER_PROBE_TURN_TIMEOUT_MS ?? "180000");
const container = process.env.T3_CONSUMER_PROBE_CONTAINER ?? "";

/**
 * Names of the MCP servers T3 handed the provider, read from the provider
 * process's own argv inside the container.
 *
 * The adapter passes each server as `-c mcp_servers.<name>.url=...` and keeps
 * the credential in an environment variable, so argv names the servers without
 * disclosing any secret. The provider process lives only for the turn, so this
 * samples while the turn runs rather than after it.
 */
const observedMcpServerNames = new Set<string>();

const sampleMcpServerNames = (): Promise<void> =>
  new Promise((resolve) => {
    if (!container) {
      resolve();
      return;
    }
    NodeChildProcess.execFile(
      "docker",
      [
        "exec",
        container,
        "sh",
        "-c",
        "for f in /proc/[0-9]*/cmdline; do tr '\\0' '\\n' <\"$f\" 2>/dev/null; done",
      ],
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) {
          for (const line of stdout.split("\n")) {
            const match = /^mcp_servers\.([^.]+)\.url=/.exec(line.trim());
            if (match) {
              observedMcpServerNames.add(match[1]!);
            }
          }
        }
        resolve();
      },
    );
  });

const protocolLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Socket.layerWebSocket(wsUrl).pipe(
      Layer.provide(
        Layer.succeed(
          Socket.WebSocketConstructor,
          (socketUrl, protocols) =>
            new NodeSocket.NodeWS.WebSocket(socketUrl, protocols, {
              headers: { authorization: `Bearer ${token}` },
            }) as unknown as globalThis.WebSocket,
        ),
      ),
    ),
  ),
  Layer.provide(RpcSerialization.layerJson),
);

const registerExternalMcp = async (input: {
  readonly threadId: string;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}): Promise<void> => {
  const response = await fetch(`${httpUrl}/api/mcp/provider-session`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      threadId: input.threadId,
      name: "external",
      endpoint: input.endpoint,
      authorizationHeader: input.authorizationHeader,
    }),
  });
  if (response.status !== 204) {
    throw new Error(`External MCP registration returned ${response.status}.`);
  }
};

const assertRegistrationFailsClosed = async (threadId: string): Promise<void> => {
  const response = await fetch(`${httpUrl}/api/mcp/provider-session`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, name: "external", endpoint: "http://127.0.0.1:9/mcp" }),
  });
  if (response.status !== 401) {
    throw new Error(`Unauthenticated registration returned ${response.status}, expected 401.`);
  }
};

const main = async (): Promise<void> => {
  const nonce = `consumer-${NodeCrypto.randomUUID()}`;
  const fixtureAuthorization = `Bearer ${NodeCrypto.randomUUID()}`;
  const fixture = await startExternalMcpLiveFixture({
    authorizationHeader: fixtureAuthorization,
    nonce,
    hostname: fixtureBind,
    advertisedHost: fixtureHost,
  });

  const projectId = NodeCrypto.randomUUID();
  const workspaceRoot = `${workspaceRootBase}-${projectId}`;
  const threadId = NodeCrypto.randomUUID();

  try {
    const sampler = container
      ? setInterval(() => {
          void sampleMcpServerNames();
        }, 500)
      : undefined;

    await assertRegistrationFailsClosed(threadId);
    await registerExternalMcp({
      threadId,
      endpoint: fixture.endpoint,
      authorizationHeader: fixtureAuthorization,
    });

    const modelSelection = {
      instanceId: "codex",
      model: process.env.T3_CONSUMER_PROBE_MODEL ?? "gpt-5.6-luna",
    };

    const program = RpcClient.make(WsRpcGroup).pipe(
      Effect.flatMap((client) =>
        Effect.gen(function* () {
          const rpc = client as any;
          const dispatch = (command: unknown) =>
            rpc["orchestration.dispatchCommand"](command as never);

          yield* dispatch({
            type: "project.create",
            commandId: NodeCrypto.randomUUID(),
            projectId,
            title: "consumer-probe",
            workspaceRoot,
            createWorkspaceRootIfMissing: true,
            createdAt: new Date().toISOString(),
          });

          const events = rpc["orchestration.subscribeThread"]({ threadId });

          yield* dispatch({
            type: "thread.turn.start",
            commandId: NodeCrypto.randomUUID(),
            threadId,
            message: {
              messageId: NodeCrypto.randomUUID(),
              role: "user",
              text:
                `Call the ${EXTERNAL_MCP_LIVE_TOOL_NAME} tool with nonce "${nonce}". ` +
                `Call it exactly once, then stop and report that you called it.`,
              attachments: [],
            },
            runtimeMode: "auto",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId,
                title: "consumer-probe",
                modelSelection,
                runtimeMode: "auto",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: new Date().toISOString(),
              },
            },
            createdAt: new Date().toISOString(),
          });

          // Waiting is not the assertion. A turn that never calls the tool
          // must reach the explicit check below rather than surface here as a
          // bare timeout, which says nothing about what went wrong.
          yield* (events as Stream.Stream<unknown>).pipe(
            Stream.takeUntil(() => fixture.calls.some((call) => call.nonce === nonce)),
            Stream.runDrain,
            Effect.timeout(turnTimeoutMs),
            Effect.ignore,
          );
        }),
      ),
      Effect.provide(protocolLayer),
      Effect.scoped,
    );

    await Effect.runPromise(program as never);

    if (sampler) {
      clearInterval(sampler);
    }

    const called = fixture.calls.filter((call) => call.nonce === nonce);
    if (called.length === 0) {
      throw new Error(
        `The agent did not call the externally registered tool within ${turnTimeoutMs}ms. ` +
          `The fixture recorded ${fixture.calls.length} call(s), none carrying this run's nonce.`,
      );
    }
    if (container) {
      // The whole point of the fork's correction: registering an external
      // server adds to the thread's MCP servers rather than replacing the
      // internal one.
      if (!observedMcpServerNames.has("external")) {
        throw new Error(
          "The provider process never received the external MCP server, though the fixture recorded a call.",
        );
      }
      if (!observedMcpServerNames.has("t3-code")) {
        throw new Error(
          "External registration suppressed T3's internal MCP server: the provider received " +
            `[${[...observedMcpServerNames].sort().join(", ")}] and no internal 't3-code' entry.`,
        );
      }
      console.log(
        `CONSUMER_PROBE_OK external tool called ${called.length} time(s); provider received MCP servers [${[
          ...observedMcpServerNames,
        ]
          .sort()
          .join(", ")}].`,
      );
      return;
    }

    console.log(`CONSUMER_PROBE_OK external tool called ${called.length} time(s).`);
  } finally {
    await fixture.stop();
  }
};

main().catch((error: unknown) => {
  console.error("CONSUMER_PROBE_FAILED", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
