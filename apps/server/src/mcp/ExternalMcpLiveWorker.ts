// ---
// relationships:
//   supports: external-mcp-registration
// ---
// @effect-diagnostics nodeBuiltinImport:off -- this test boundary owns exact operating-system process groups.
// @effect-diagnostics globalTimers:off -- native timers bound child lifecycles outside Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";

import {
  decodeExternalMcpLiveWorkerResultFile,
  EXTERNAL_MCP_LIVE_WORKER_HARNESS_ENV,
  EXTERNAL_MCP_LIVE_WORKER_PROTOCOL,
  EXTERNAL_MCP_LIVE_WORKER_PROTOCOL_ENV,
  EXTERNAL_MCP_LIVE_WORKER_RESULT_FILE_ENV,
  type ExternalMcpLiveHarness,
  type ExternalMcpLiveWorkerParentReason,
  type ExternalMcpLiveWorkerResult,
  type ExternalMcpLiveWorkerResultSnapshot,
  type ExternalMcpLiveWorkerStage,
  type ExternalMcpLiveWorkerTeardown,
} from "./ExternalMcpLiveWorkerProtocol.ts";
import {
  ExternalMcpLiveWorkerProcessTree,
  type ExternalMcpLiveWorkerProcessHandle,
} from "./ExternalMcpLiveWorkerProcessTree.ts";
import {
  EXTERNAL_MCP_LIVE_WORKER_UNSHARE,
  externalMcpLiveWorkerSupervisorArgs,
  readExternalMcpLiveWorkerSupervisorStatus,
} from "./ExternalMcpLiveWorkerSupervisor.ts";

export {
  EXTERNAL_MCP_LIVE_PROBE_ENV,
  publishExternalMcpLiveWorkerResult,
  readExternalMcpLiveWorkerContext,
  type ExternalMcpLiveHarness,
  type ExternalMcpLiveWorkerReport,
} from "./ExternalMcpLiveWorkerProtocol.ts";
export type { ExternalMcpLiveWorkerProcessHandle } from "./ExternalMcpLiveWorkerProcessTree.ts";

export interface ExternalMcpLiveWorkerCommand {
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface RunExternalMcpLiveWorkerOptions {
  readonly harness: ExternalMcpLiveHarness;
  readonly command: ExternalMcpLiveWorkerCommand;
  readonly deadlineMs: number;
  readonly gracefulTerminationMs: number;
  readonly forcedTerminationMs: number;
  readonly onSpawn?: (handle: ExternalMcpLiveWorkerProcessHandle) => void;
  readonly onDiscardedOutput?: (summary: ExternalMcpLiveWorkerDiscardedOutput) => void;
}

export interface ExternalMcpLiveWorkerDiscardedOutput {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/**
 * How much of the harness's stderr to keep for diagnosis.
 *
 * Keeping none was the first shape, and it cost more than it saved: a harness
 * that could not start reported a bare "spawn-failed" with nothing to read,
 * twice, and the second time the cause was a kernel refusing the namespace
 * the worker is built from. A tail is enough for an errno or a missing
 * binary, and bounded so a chatty harness cannot fill memory.
 */
const RETAINED_STDERR_BYTES = 4096;

/**
 * Redacts the credentials this worker put into the harness's environment.
 *
 * These are the only secrets it knows: the per-thread MCP bearer tokens it
 * was handed. A credential the harness mints for itself is not covered, so
 * this is a floor rather than a guarantee — which is the right trade for
 * output that only ever reaches the developer who started the run.
 */
const redactKnownSecrets = (
  text: string,
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  let redacted = text;
  for (const value of Object.values(environment)) {
    if (value !== undefined && value.length >= 8) {
      redacted = redacted.split(value).join("[redacted]");
    }
  }
  return redacted;
};

interface TerminationOutcome {
  readonly teardown: "exited-without-signal" | "terminated-gracefully" | "terminated-forcibly";
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForProcessTreeExit = async (
  tree: ExternalMcpLiveWorkerProcessTree,
  milliseconds: number,
  signalNewGroups?: NodeJS.Signals,
  signaledGroups?: Set<number>,
): Promise<boolean> => {
  const deadline = performance.now() + milliseconds;
  while (tree.hasLiveProcess()) {
    if (performance.now() >= deadline) return false;
    if (signalNewGroups !== undefined) tree.signal(signalNewGroups, signaledGroups);
    await delay(5);
  }
  return true;
};

const failedResult = (
  harness: ExternalMcpLiveHarness,
  reason: ExternalMcpLiveWorkerParentReason,
  teardown: ExternalMcpLiveWorkerTeardown,
  reachedStage: ExternalMcpLiveWorkerStage = "setup",
  diagnostic?: string,
): ExternalMcpLiveWorkerResult => ({
  protocol: EXTERNAL_MCP_LIVE_WORKER_PROTOCOL,
  harness,
  status: "failed",
  reachedStage,
  reason,
  teardown,
  ...(diagnostic !== undefined && diagnostic !== "" ? { diagnostic } : {}),
});

const readResultFile = (resultFile: string): string => {
  try {
    return NodeFS.readFileSync(resultFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    return "";
  }
};

const resultFromSnapshot = (
  harness: ExternalMcpLiveHarness,
  snapshot: ExternalMcpLiveWorkerResultSnapshot,
  teardown: ExternalMcpLiveWorkerTeardown,
  // What the harness said, already redacted. A worker that left no result is
  // the case most in need of it: the reason names what is absent, never why.
  diagnostic?: string,
): ExternalMcpLiveWorkerResult => {
  switch (snapshot.kind) {
    case "missing":
      return failedResult(harness, "missing-worker-result", teardown, "setup", diagnostic);
    case "duplicate":
      return failedResult(harness, "duplicate-worker-result", teardown, "setup", diagnostic);
    case "malformed":
      return failedResult(harness, "malformed-worker-result", teardown, "setup", diagnostic);
    case "valid": {
      if (snapshot.result.harness !== harness) {
        return failedResult(harness, "wrong-harness-result", teardown, "setup", diagnostic);
      }
      if (snapshot.result.status === "passed") {
        return teardown === "exited-without-signal"
          ? { ...snapshot.result, teardown }
          : failedResult(harness, "worker-deadline-exceeded", teardown, "complete");
      }
      return { ...snapshot.result, teardown };
    }
  }
};

const terminateProcessGroup = async (
  tree: ExternalMcpLiveWorkerProcessTree,
  gracefulTerminationMs: number,
  forcedTerminationMs: number,
): Promise<TerminationOutcome> => {
  const gracefullySignaledGroups = new Set<number>();
  if (!tree.signal("SIGTERM", gracefullySignaledGroups)) {
    return { teardown: "exited-without-signal" };
  }
  const graceful = await waitForProcessTreeExit(
    tree,
    gracefulTerminationMs,
    "SIGTERM",
    gracefullySignaledGroups,
  );
  if (graceful) {
    return { teardown: "terminated-gracefully" };
  }

  tree.signal("SIGKILL");
  const forced = await waitForProcessTreeExit(tree, forcedTerminationMs);
  if (!forced) {
    throw new Error("External MCP live worker did not exit after forced termination.");
  }
  return { teardown: "terminated-forcibly" };
};

const assertPositiveMilliseconds = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
};

/**
 * Runs one live harness in one detached process group. Child output is drained
 * but never forwarded. Worker assertions use the private, versioned result
 * file; lifecycle status uses a supervisor-only pipe that the worker does not
 * inherit.
 */
export async function runExternalMcpLiveWorker(
  options: RunExternalMcpLiveWorkerOptions,
): Promise<ExternalMcpLiveWorkerResult> {
  assertPositiveMilliseconds("deadlineMs", options.deadlineMs);
  assertPositiveMilliseconds("gracefulTerminationMs", options.gracefulTerminationMs);
  assertPositiveMilliseconds("forcedTerminationMs", options.forcedTerminationMs);
  const resultDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "t3-external-mcp-live-worker-"),
  );
  const resultFile = NodePath.join(resultDirectory, "result.ndjson");
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(
      EXTERNAL_MCP_LIVE_WORKER_UNSHARE,
      externalMcpLiveWorkerSupervisorArgs(options.command.executable, options.command.args ?? []),
      {
        cwd: options.command.cwd,
        detached: true,
        env: {
          ...process.env,
          ...options.command.environment,
          [EXTERNAL_MCP_LIVE_WORKER_PROTOCOL_ENV]: String(EXTERNAL_MCP_LIVE_WORKER_PROTOCOL),
          [EXTERNAL_MCP_LIVE_WORKER_HARNESS_ENV]: options.harness,
          [EXTERNAL_MCP_LIVE_WORKER_RESULT_FILE_ENV]: resultFile,
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
  } catch (error) {
    NodeFS.rmSync(resultDirectory, { recursive: true, force: true });
    // Nothing has been spawned, so there is no output to read; the throw is
    // the only account of why. A kernel refusing the namespace and a missing
    // binary are indistinguishable without it.
    return failedResult(
      options.harness,
      "worker-spawn-failed",
      "spawn-failed",
      "setup",
      error instanceof Error ? error.message : String(error),
    );
  }

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderrTail = "";
  child.stdout!.on("data", (chunk: Buffer | string) => {
    stdoutBytes += Buffer.byteLength(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
    stderrTail = (stderrTail + String(chunk)).slice(-RETAINED_STDERR_BYTES);
  });

  const supervisorStatusStream = child.stdio[3] as NodeStream.Readable | null;
  const supervisorStatusPromise = readExternalMcpLiveWorkerSupervisorStatus(supervisorStatusStream);

  const exitPromise = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", () => reject(new Error("External MCP live worker failed to spawn.")));
  });
  const pid = child.pid;
  if (pid === undefined) {
    void exitPromise.catch(() => undefined);
    NodeFS.rmSync(resultDirectory, { recursive: true, force: true });
    return failedResult(options.harness, "worker-spawn-failed", "spawn-failed");
  }
  const handle = { pid, processGroupId: pid };
  const processTree = new ExternalMcpLiveWorkerProcessTree(handle);
  const processTreeMonitor = setInterval(() => processTree.refresh(), 5);
  let deadline: NodeJS.Timeout | undefined;
  try {
    options.onSpawn?.(handle);
    const leftDescendantsPromise = supervisorStatusPromise.then((status) =>
      status?.kind === "exited" && status.leftDescendants
        ? { kind: "left-descendants" as const, status }
        : new Promise<never>(() => undefined),
    );
    const first = await Promise.race([
      exitPromise.then(() => ({ kind: "exit" as const })),
      leftDescendantsPromise,
      new Promise<{ readonly kind: "deadline" }>((resolve) => {
        deadline = setTimeout(() => resolve({ kind: "deadline" }), options.deadlineMs);
      }),
    ]);

    if (first.kind === "deadline") {
      const timelyContent = readResultFile(resultFile);
      const timelySnapshot = decodeExternalMcpLiveWorkerResultFile(timelyContent);
      const termination = await terminateProcessGroup(
        processTree,
        options.gracefulTerminationMs,
        options.forcedTerminationMs,
      );
      const finalContent = readResultFile(resultFile);
      if (finalContent !== timelyContent) {
        return failedResult(options.harness, "late-worker-result", termination.teardown);
      }
      if (timelySnapshot.kind !== "missing") {
        const timelyResult = resultFromSnapshot(
          options.harness,
          timelySnapshot,
          termination.teardown,
        );
        if (timelyResult.status === "failed") return timelyResult;
      }
      const reachedStage =
        timelySnapshot.kind === "valid" ? timelySnapshot.result.reachedStage : "setup";
      return failedResult(
        options.harness,
        "worker-deadline-exceeded",
        termination.teardown,
        reachedStage,
      );
    }

    if (first.kind === "left-descendants") {
      const termination = await terminateProcessGroup(
        processTree,
        options.gracefulTerminationMs,
        options.forcedTerminationMs,
      );
      const snapshot = decodeExternalMcpLiveWorkerResultFile(readResultFile(resultFile));
      const reachedStage = snapshot.kind === "valid" ? snapshot.result.reachedStage : "setup";
      return failedResult(
        options.harness,
        "worker-left-descendants",
        termination.teardown,
        reachedStage,
      );
    }

    if (processTree.hasLiveProcess()) {
      const termination = await terminateProcessGroup(
        processTree,
        options.gracefulTerminationMs,
        options.forcedTerminationMs,
      );
      return failedResult(options.harness, "worker-left-descendants", termination.teardown);
    }

    const teardown = "exited-without-signal" as const;
    const snapshot = decodeExternalMcpLiveWorkerResultFile(readResultFile(resultFile));
    const supervisorStatus = await supervisorStatusPromise;
    if (supervisorStatus === undefined || supervisorStatus.kind === "spawn-failed") {
      return failedResult(
        options.harness,
        "worker-spawn-failed",
        "spawn-failed",
        "setup",
        redactKnownSecrets(stderrTail, { ...(options.command.environment ?? {}) }),
      );
    }
    if (supervisorStatus.signal !== null) {
      return failedResult(options.harness, "worker-exited-by-signal", "exited-by-signal");
    }
    if (supervisorStatus.code !== 0) {
      const reachedStage = snapshot.kind === "valid" ? snapshot.result.reachedStage : "setup";
      return failedResult(options.harness, "worker-exited-nonzero", teardown, reachedStage);
    }
    return resultFromSnapshot(
      options.harness,
      snapshot,
      teardown,
      redactKnownSecrets(stderrTail, { ...(options.command.environment ?? {}) }),
    );
  } catch {
    if (processTree.hasLiveProcess()) {
      await terminateProcessGroup(
        processTree,
        options.gracefulTerminationMs,
        options.forcedTerminationMs,
      );
    }
    return failedResult(options.harness, "worker-spawn-failed", "spawn-failed");
  } finally {
    clearInterval(processTreeMonitor);
    if (deadline !== undefined) clearTimeout(deadline);
    try {
      options.onDiscardedOutput?.({ stdoutBytes, stderrBytes });
    } catch {
      // An observation hook cannot change the bounded worker result.
    }
    NodeFS.rmSync(resultDirectory, { recursive: true, force: true });
  }
}
