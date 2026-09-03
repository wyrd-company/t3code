import type { Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { CursorAcpRuntimeInput } from "../provider/acp/CursorAcpSupport.ts";
import { makeClaudeAdapter } from "../provider/Layers/ClaudeAdapter.ts";
import { makeCodexAdapter } from "../provider/Layers/CodexAdapter.ts";
import { makeCursorAdapter } from "../provider/Layers/CursorAdapter.ts";
import { makeGrokAdapter } from "../provider/Layers/GrokAdapter.ts";
import { makeOpenCodeAdapter } from "../provider/Layers/OpenCodeAdapter.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../provider/opencodeRuntime.ts";
import type { CodexSessionRuntimeOptions } from "../provider/Layers/CodexSessionRuntime.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

const threadId = ThreadId.make("thread-start-evidence");
const endpoint = "https://service.example.test/api";
const authorizationHeader = "Bearer token-alpha";
const claudeSettings = Schema.decodeSync(ClaudeSettings)({});
const codexSettings = Schema.decodeSync(CodexSettings)({});
const cursorSettings = Schema.decodeSync(CursorSettings)({});
const grokSettings = Schema.decodeSync(GrokSettings)({});
const openCodeSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "test",
});

const dependencies = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

const arrange = () => {
  McpProviderSession.clearAllMcpProviderSessions();
  McpProviderSession.setExternalMcpProviderSession({
    threadId,
    endpoint,
    authorizationHeader,
  });
};

const makeCapturingOpenCodeRuntime = (added: Array<unknown>) =>
  ({
    connectToOpenCodeServer: () =>
      Effect.succeed({
        url: "http://127.0.0.1:9999",
        version: "test",
        exitCode: null,
        external: false,
      }),
    createOpenCodeSdkClient: () => ({
      mcp: {
        add: (input: unknown) => {
          added.push(input);
          return Promise.resolve({});
        },
      },
    }),
  }) as unknown as OpenCodeRuntimeShape;

it.effect("passes external MCP through the real Claude startSession query call site", () =>
  Effect.gen(function* () {
    arrange();
    let captured: ClaudeQueryOptions | undefined;
    const adapter = yield* makeClaudeAdapter(claudeSettings, {
      createQuery: (input) => {
        captured = input.options;
        throw new Error("capture complete");
      },
    });
    yield* adapter
      .startSession({
        provider: ProviderDriverKind.make("claudeAgent"),
        threadId,
        runtimeMode: "full-access",
      })
      .pipe(Effect.exit);
    expect(captured?.mcpServers).toEqual({
      "t3-code": {
        type: "http",
        url: endpoint,
        headers: { Authorization: authorizationHeader },
      },
    });
  }).pipe(Effect.provide(dependencies)),
);

it.effect("passes external MCP through the real Codex startSession runtime call site", () =>
  Effect.gen(function* () {
    arrange();
    let captured: CodexSessionRuntimeOptions | undefined;
    const adapter = yield* makeCodexAdapter(codexSettings, {
      makeRuntime: (input) => {
        captured = input;
        return Effect.die("capture complete");
      },
    });
    yield* adapter
      .startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      })
      .pipe(Effect.exit);
    expect(captured?.appServerArgs).toContain(`mcp_servers.t3-code.url=${endpoint}`);
    expect(captured?.environment?.T3_MCP_BEARER_TOKEN).toBe("token-alpha");
  }).pipe(Effect.provide(dependencies)),
);

it.effect("passes external MCP through the real Cursor startSession ACP call site", () =>
  Effect.gen(function* () {
    arrange();
    let captured: CursorAcpRuntimeInput | undefined;
    const adapter = yield* makeCursorAdapter(cursorSettings, {
      makeRuntime: (input) => {
        captured = input;
        return Effect.die("capture complete");
      },
    });
    yield* adapter
      .startSession({
        provider: ProviderDriverKind.make("cursor"),
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      })
      .pipe(Effect.exit);
    expect(captured?.mcpServers).toEqual([
      {
        type: "http",
        name: "t3-code",
        url: endpoint,
        headers: [{ name: "Authorization", value: authorizationHeader }],
      },
    ]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("passes external MCP through the real Grok startSession ACP call site", () =>
  Effect.gen(function* () {
    arrange();
    let captured: { readonly mcpServers?: ReadonlyArray<unknown> } | undefined;
    const adapter = yield* makeGrokAdapter(grokSettings, {
      makeRuntime: (input) => {
        captured = input;
        return Effect.die("capture complete");
      },
    });
    yield* adapter
      .startSession({
        provider: ProviderDriverKind.make("grok"),
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      })
      .pipe(Effect.exit);
    expect(captured?.mcpServers).toEqual([
      {
        type: "http",
        name: "t3-code",
        url: endpoint,
        headers: [{ name: "Authorization", value: authorizationHeader }],
      },
    ]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("passes external MCP through the real OpenCode startSession SDK call site", () => {
  const added: Array<unknown> = [];
  return Effect.gen(function* () {
    arrange();
    const adapter = yield* makeOpenCodeAdapter(openCodeSettings);
    yield* adapter
      .startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      })
      .pipe(Effect.exit);
    expect(added).toEqual([
      {
        name: "t3-code",
        config: {
          type: "remote",
          url: endpoint,
          headers: { Authorization: authorizationHeader },
          oauth: false,
        },
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.merge(
        dependencies,
        Layer.succeed(OpenCodeRuntime, makeCapturingOpenCodeRuntime(added)),
      ),
    ),
  );
});
