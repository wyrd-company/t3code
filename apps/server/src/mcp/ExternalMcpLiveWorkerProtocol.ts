// ---
// relationships:
//   supports: external-mcp-registration
// ---
// @effect-diagnostics nodeBuiltinImport:off -- the test-worker protocol uses an owned result file.
import * as NodeFS from "node:fs";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const EXTERNAL_MCP_LIVE_WORKER_PROTOCOL = 1 as const;
export const EXTERNAL_MCP_LIVE_PROBE_ENV = "T3_EXTERNAL_MCP_LIVE_PROBE";
export const EXTERNAL_MCP_LIVE_WORKER_PROTOCOL_ENV = "T3_EXTERNAL_MCP_LIVE_WORKER_PROTOCOL";
export const EXTERNAL_MCP_LIVE_WORKER_HARNESS_ENV = "T3_EXTERNAL_MCP_LIVE_WORKER_HARNESS";
export const EXTERNAL_MCP_LIVE_WORKER_RESULT_FILE_ENV = "T3_EXTERNAL_MCP_LIVE_WORKER_RESULT_FILE";

export const ExternalMcpLiveHarness = Schema.Literals(["claudeAgent", "codex", "grok", "opencode"]);
export type ExternalMcpLiveHarness = typeof ExternalMcpLiveHarness.Type;

export const ExternalMcpLiveWorkerStage = Schema.Literals([
  "setup",
  "adapter",
  "registration",
  "session-start",
  "internal-mcp",
  "turn",
  "fixture-call",
  "cleanup",
  "complete",
]);
export type ExternalMcpLiveWorkerStage = typeof ExternalMcpLiveWorkerStage.Type;

export const ExternalMcpLiveWorkerReportedReason = Schema.Literals([
  "all-assertions-passed",
  "harness-unavailable",
  "stage-failed",
  "stage-timed-out",
]);
export type ExternalMcpLiveWorkerReportedReason = typeof ExternalMcpLiveWorkerReportedReason.Type;

export const ExternalMcpLiveWorkerReportedResult = Schema.Struct({
  protocol: Schema.Literal(EXTERNAL_MCP_LIVE_WORKER_PROTOCOL),
  harness: ExternalMcpLiveHarness,
  status: Schema.Literals(["passed", "failed"]),
  reachedStage: ExternalMcpLiveWorkerStage,
  reason: ExternalMcpLiveWorkerReportedReason,
});
export type ExternalMcpLiveWorkerReportedResult = typeof ExternalMcpLiveWorkerReportedResult.Type;

export const ExternalMcpLiveWorkerParentReason = Schema.Union([
  ExternalMcpLiveWorkerReportedReason,
  Schema.Literals([
    "worker-spawn-failed",
    "worker-deadline-exceeded",
    "worker-exited-nonzero",
    "worker-exited-by-signal",
    "worker-left-descendants",
    "missing-worker-result",
    "duplicate-worker-result",
    "wrong-harness-result",
    "malformed-worker-result",
    "late-worker-result",
  ]),
]);
export type ExternalMcpLiveWorkerParentReason = typeof ExternalMcpLiveWorkerParentReason.Type;

export const ExternalMcpLiveWorkerTeardown = Schema.Literals([
  "exited-without-signal",
  "exited-by-signal",
  "terminated-gracefully",
  "terminated-forcibly",
  "spawn-failed",
]);
export type ExternalMcpLiveWorkerTeardown = typeof ExternalMcpLiveWorkerTeardown.Type;

export const ExternalMcpLiveWorkerResult = Schema.Struct({
  protocol: Schema.Literal(EXTERNAL_MCP_LIVE_WORKER_PROTOCOL),
  harness: ExternalMcpLiveHarness,
  status: Schema.Literals(["passed", "failed"]),
  reachedStage: ExternalMcpLiveWorkerStage,
  reason: ExternalMcpLiveWorkerParentReason,
  teardown: ExternalMcpLiveWorkerTeardown,
});
export type ExternalMcpLiveWorkerResult = typeof ExternalMcpLiveWorkerResult.Type;

const decodeReportedResult = Schema.decodeUnknownOption(ExternalMcpLiveWorkerReportedResult);
const decodeHarness = Schema.decodeUnknownOption(ExternalMcpLiveHarness);

export interface ExternalMcpLiveWorkerContext {
  readonly harness: ExternalMcpLiveHarness;
  readonly resultFile: string;
}

/**
 * Reads the private parent-to-worker context. The internal selector cannot
 * enable a manually invoked live probe: the existing user opt-in must also be
 * present in the worker environment.
 */
export function readExternalMcpLiveWorkerContext(
  environment: NodeJS.ProcessEnv = process.env,
): ExternalMcpLiveWorkerContext {
  const harness = decodeHarness(environment[EXTERNAL_MCP_LIVE_WORKER_HARNESS_ENV]);
  const resultFile = environment[EXTERNAL_MCP_LIVE_WORKER_RESULT_FILE_ENV];
  if (
    environment[EXTERNAL_MCP_LIVE_PROBE_ENV] !== "1" ||
    environment[EXTERNAL_MCP_LIVE_WORKER_PROTOCOL_ENV] !==
      String(EXTERNAL_MCP_LIVE_WORKER_PROTOCOL) ||
    Option.isNone(harness) ||
    resultFile === undefined ||
    resultFile === ""
  ) {
    throw new Error("External MCP live worker context unavailable.");
  }
  return { harness: harness.value, resultFile };
}

export type ExternalMcpLiveWorkerReport = Omit<
  ExternalMcpLiveWorkerReportedResult,
  "protocol" | "harness"
>;

/** Writes exactly one small, versioned result record before worker finalizers run. */
export function publishExternalMcpLiveWorkerResult(
  report: ExternalMcpLiveWorkerReport,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const context = readExternalMcpLiveWorkerContext(environment);
  const result: ExternalMcpLiveWorkerReportedResult = {
    protocol: EXTERNAL_MCP_LIVE_WORKER_PROTOCOL,
    harness: context.harness,
    ...report,
  };
  const decoded = decodeReportedResult(result);
  if (Option.isNone(decoded)) {
    throw new Error("External MCP live worker result is invalid.");
  }
  NodeFS.appendFileSync(context.resultFile, `${JSON.stringify(decoded.value)}\n`, {
    encoding: "utf8",
    flag: "a",
    mode: 0o600,
  });
}

export type ExternalMcpLiveWorkerResultSnapshot =
  | { readonly kind: "missing" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "valid";
      readonly result: ExternalMcpLiveWorkerReportedResult;
    };

/** Decodes a result snapshot without retaining malformed child-controlled text. */
export function decodeExternalMcpLiveWorkerResultFile(
  content: string,
): ExternalMcpLiveWorkerResultSnapshot {
  const records = content.split("\n").filter((record) => record.trim() !== "");
  if (records.length === 0) return { kind: "missing" };
  if (records.length !== 1) return { kind: "duplicate" };
  let value: unknown;
  try {
    value = JSON.parse(records[0]!);
  } catch {
    return { kind: "malformed" };
  }
  const decoded = decodeReportedResult(value);
  return Option.isSome(decoded) ? { kind: "valid", result: decoded.value } : { kind: "malformed" };
}
