// ---
// relationships:
//   validates: external-mcp-registration
// ---
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  EXTERNAL_MCP_LIVE_TOOL_NAME,
  startExternalMcpLiveFixture,
  type ExternalMcpLiveFixture,
} from "./ExternalMcpLiveFixture.ts";

const authorizationHeader = "Bearer generic-fixture-credential";
const nonce = "generic-run-nonce";
let fixture: ExternalMcpLiveFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

const rpc = (method: string, params: unknown, id = 1) =>
  // @effect-diagnostics-next-line globalFetch:off -- exercises a native Node fixture outside Effect.
  fetch(fixture!.endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: authorizationHeader,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

describe("external MCP live fixture", () => {
  it("rejects requests without the exact registered Bearer credential", async () => {
    fixture = await startExternalMcpLiveFixture({ authorizationHeader, nonce });

    // @effect-diagnostics-next-line globalFetch:off -- exercises a native Node fixture outside Effect.
    const missing = await fetch(fixture.endpoint, { method: "POST" });
    // @effect-diagnostics-next-line globalFetch:off -- exercises a native Node fixture outside Effect.
    const wrong = await fetch(fixture.endpoint, {
      method: "POST",
      headers: { authorization: "Bearer wrong-credential" },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(fixture.calls).toEqual([]);
  });

  it("advertises exactly one distinctive tool and records its authenticated nonce call", async () => {
    fixture = await startExternalMcpLiveFixture({ authorizationHeader, nonce });

    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "generic-probe", version: "1.0.0" },
    });
    expect(initialized.status).toBe(200);

    const listed = await rpc("tools/list", {}, 2);
    const listPayload = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listPayload.result.tools.map(({ name }) => name)).toEqual([EXTERNAL_MCP_LIVE_TOOL_NAME]);

    const wrongTool = await rpc(
      "tools/call",
      { name: "generic_wrong_tool", arguments: { nonce } },
      3,
    );
    const wrongToolPayload = (await wrongTool.json()) as { error: { code: number } };
    expect(wrongToolPayload.error.code).toBe(-32602);

    const wrongNonce = await rpc(
      "tools/call",
      { name: EXTERNAL_MCP_LIVE_TOOL_NAME, arguments: { nonce: "generic-wrong-nonce" } },
      4,
    );
    const wrongNoncePayload = (await wrongNonce.json()) as { error: { code: number } };
    expect(wrongNoncePayload.error.code).toBe(-32602);
    expect(fixture.calls).toEqual([]);

    const called = await rpc(
      "tools/call",
      { name: EXTERNAL_MCP_LIVE_TOOL_NAME, arguments: { nonce } },
      5,
    );
    const callPayload = (await called.json()) as { result: { structuredContent: unknown } };
    expect(callPayload.result.structuredContent).toEqual({ nonce });
    expect(fixture.calls).toEqual([{ nonce }]);
  });
});
