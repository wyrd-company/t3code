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

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

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
): ExternalMcpLiveWorkerResult => ({
  protocol: EXTERNAL_MCP_LIVE_WORKER_PROTOCOL,
  harness,
  status: "failed",
  reachedStage,
  reason,
  teardown,
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
): ExternalMcpLiveWorkerResult => {
  switch (snapshot.kind) {
    case "missing":
      return failedResult(harness, "missing-worker-result", teardown);
    case "duplicate":
      return failedResult(harness, "duplicate-worker-result", teardown);
    case "malformed":
      return failedResult(harness, "malformed-worker-result", teardown);
    case "valid": {
      if (snapshot.result.harness !== harness) {
        return failedResult(harness, "wrong-harness-result", teardown);
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
 * but never forwarded; the only accepted data channel is the private,
 * versioned result file.
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
  let child: NodeChildProcess.ChildProcessByStdio<null, NodeStream.Readable, NodeStream.Readable>;
  try {
    child = NodeChildProcess.spawn(options.command.executable, [...(options.command.args ?? [])], {
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
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    NodeFS.rmSync(resultDirectory, { recursive: true, force: true });
    return failedResult(options.harness, "worker-spawn-failed", "spawn-failed");
  }

  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutBytes += Buffer.byteLength(chunk);
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
  });

  const exitPromise = new Promise<ChildExit>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
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
    const first = await Promise.race([
      exitPromise.then((exit) => ({ kind: "exit" as const, exit })),
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
    if (first.exit.signal !== null) {
      return failedResult(options.harness, "worker-exited-by-signal", "exited-by-signal");
    }
    if (first.exit.code !== 0) {
      const reachedStage = snapshot.kind === "valid" ? snapshot.result.reachedStage : "setup";
      return failedResult(options.harness, "worker-exited-nonzero", teardown, reachedStage);
    }
    return resultFromSnapshot(options.harness, snapshot, teardown);
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
