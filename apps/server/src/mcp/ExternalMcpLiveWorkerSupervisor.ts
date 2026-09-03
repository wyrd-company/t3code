// ---
// relationships:
//   supports: external-mcp-registration
// ---
// @effect-diagnostics nodeBuiltinImport:off -- this test boundary owns a Linux PID namespace.
import type * as NodeStream from "node:stream";
import * as NodeURL from "node:url";

export type ExternalMcpLiveWorkerSupervisorStatus =
  | { readonly protocol: 1; readonly kind: "spawn-failed" }
  | {
      readonly protocol: 1;
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly leftDescendants: boolean;
    };

const supervisorPath = NodeURL.fileURLToPath(
  new URL("./fixtures/ExternalMcpLiveWorkerSupervisor.mjs", import.meta.url),
);

export const EXTERNAL_MCP_LIVE_WORKER_UNSHARE = "/usr/bin/unshare";

export const externalMcpLiveWorkerSupervisorArgs = (
  executable: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "--user",
  "--map-current-user",
  "--pid",
  "--fork",
  "--mount-proc",
  "--",
  process.execPath,
  supervisorPath,
  executable,
  ...args,
];

const decodeSupervisorStatus = (
  line: string,
): ExternalMcpLiveWorkerSupervisorStatus | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.protocol !== 1) return undefined;
  if (record.kind === "spawn-failed") return { protocol: 1, kind: "spawn-failed" };
  if (
    record.kind !== "exited" ||
    !(record.code === null || (Number.isSafeInteger(record.code) && Number(record.code) >= 0)) ||
    !(record.signal === null || typeof record.signal === "string") ||
    typeof record.leftDescendants !== "boolean"
  ) {
    return undefined;
  }
  return {
    protocol: 1,
    kind: "exited",
    code: record.code as number | null,
    signal: record.signal as NodeJS.Signals | null,
    leftDescendants: record.leftDescendants,
  };
};

export const readExternalMcpLiveWorkerSupervisorStatus = (
  stream: NodeStream.Readable | null,
): Promise<ExternalMcpLiveWorkerSupervisorStatus | undefined> =>
  new Promise((resolve) => {
    if (stream === null) {
      resolve(undefined);
      return;
    }
    let settled = false;
    let buffer = "";
    const settle = (status: ExternalMcpLiveWorkerSupervisorStatus | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    stream.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      buffer += String(chunk);
      if (buffer.length > 4_096) {
        settle(undefined);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline !== -1) settle(decodeSupervisorStatus(buffer.slice(0, newline)));
    });
    stream.once("end", () => settle(undefined));
    stream.once("error", () => settle(undefined));
  });
