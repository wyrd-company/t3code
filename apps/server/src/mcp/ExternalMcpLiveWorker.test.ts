// ---
// relationships:
//   validates: external-mcp-registration
// ---
// @effect-diagnostics nodeBuiltinImport:off -- this test exercises operating-system process handles.
// @effect-diagnostics globalTimers:off -- the watchdog is independent from the boundary under test.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  EXTERNAL_MCP_LIVE_PROBE_ENV,
  publishExternalMcpLiveWorkerResult,
  readExternalMcpLiveWorkerContext,
  runExternalMcpLiveWorker,
  type ExternalMcpLiveHarness,
  type ExternalMcpLiveWorkerDiscardedOutput,
  type ExternalMcpLiveWorkerProcessHandle,
} from "./ExternalMcpLiveWorker.ts";
import {
  EXTERNAL_MCP_LIVE_WORKER_HARNESS_ENV,
  EXTERNAL_MCP_LIVE_WORKER_PROTOCOL_ENV,
  EXTERNAL_MCP_LIVE_WORKER_RESULT_FILE_ENV,
} from "./ExternalMcpLiveWorkerProtocol.ts";

const fixturePath = NodeURL.fileURLToPath(
  new URL("./fixtures/ExternalMcpLiveWorkerFixture.mjs", import.meta.url),
);
const activeHandles = new Set<ExternalMcpLiveWorkerProcessHandle>();

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const killRecordedGroup = (handle: ExternalMcpLiveWorkerProcessHandle): void => {
  try {
    process.kill(-handle.processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

afterEach(() => {
  for (const handle of activeHandles) killRecordedGroup(handle);
  activeHandles.clear();
  vi.restoreAllMocks();
});

interface FixtureRunOptions {
  readonly deadlineMs?: number;
  readonly graceMs?: number;
  readonly descendantPidFile?: string;
  readonly harness?: ExternalMcpLiveHarness;
  readonly onDiscardedOutput?: (summary: ExternalMcpLiveWorkerDiscardedOutput) => void;
  readonly onSpawn?: (handle: ExternalMcpLiveWorkerProcessHandle) => void;
  readonly secret?: string;
  readonly signalFile?: string;
}

const runFixture = async (mode: string, options: FixtureRunOptions = {}) => {
  const handles: Array<ExternalMcpLiveWorkerProcessHandle> = [];
  let watchdog: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      runExternalMcpLiveWorker({
        harness: options.harness ?? "codex",
        command: {
          executable: process.execPath,
          args: [fixturePath],
          environment: {
            [EXTERNAL_MCP_LIVE_PROBE_ENV]: "1",
            T3_EXTERNAL_MCP_WORKER_FIXTURE_MODE: mode,
            ...(options.descendantPidFile === undefined
              ? {}
              : { T3_EXTERNAL_MCP_WORKER_FIXTURE_DESCENDANT_PID_FILE: options.descendantPidFile }),
            ...(options.secret === undefined
              ? {}
              : { T3_EXTERNAL_MCP_WORKER_FIXTURE_SECRET: options.secret }),
            ...(options.signalFile === undefined
              ? {}
              : { T3_EXTERNAL_MCP_WORKER_FIXTURE_SIGNAL_FILE: options.signalFile }),
          },
        },
        deadlineMs: options.deadlineMs ?? 300,
        gracefulTerminationMs: options.graceMs ?? 100,
        forcedTerminationMs: 500,
        onSpawn: (handle) => {
          handles.push(handle);
          activeHandles.add(handle);
          options.onSpawn?.(handle);
        },
        ...(options.onDiscardedOutput === undefined
          ? {}
          : { onDiscardedOutput: options.onDiscardedOutput }),
      }),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          for (const handle of handles) killRecordedGroup(handle);
          reject(new Error(`outer watchdog expired for fixture mode ${mode}`));
        }, 2_000);
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    for (const handle of handles) {
      if (!processExists(handle.pid)) activeHandles.delete(handle);
    }
  }
};

describe("external MCP live worker boundary", () => {
  it("returns before its outer watchdog and reaps a worker whose finalizer never settles", async () => {
    let handle: ExternalMcpLiveWorkerProcessHandle | undefined;
    const result = await runFixture("stuck-finalizer", {
      harness: "claudeAgent",
      deadlineMs: 100,
      graceMs: 50,
      onSpawn: (spawned) => {
        handle = spawned;
      },
    });

    expect(result).toEqual({
      protocol: 1,
      harness: "claudeAgent",
      status: "failed",
      reachedStage: "complete",
      reason: "worker-deadline-exceeded",
      teardown: "terminated-forcibly",
    });
    expect(handle).toBeDefined();
    expect(processExists(handle!.pid)).toBe(false);
  }, 3_000);

  it("accepts one matching structured result and reaps a clean exit without a signal", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worker-success-"));
    const signalFile = NodePath.join(root, "signals");
    try {
      const result = await runFixture("success", { signalFile });
      expect(result).toEqual({
        protocol: 1,
        harness: "codex",
        status: "passed",
        reachedStage: "complete",
        reason: "all-assertions-passed",
        teardown: "exited-without-signal",
      });
      expect(NodeFS.existsSync(signalFile)).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("turns a non-zero worker exit into a secret-free failed result", async () => {
    expect(await runFixture("non-zero")).toMatchObject({
      status: "failed",
      reachedStage: "turn",
      reason: "worker-exited-nonzero",
      teardown: "exited-without-signal",
    });
  });

  it("rejects a malformed worker result", async () => {
    expect(await runFixture("malformed")).toMatchObject({
      status: "failed",
      reason: "malformed-worker-result",
      teardown: "exited-without-signal",
    });
  });

  it("rejects an internally inconsistent passed result", async () => {
    expect(await runFixture("inconsistent-passed")).toMatchObject({
      status: "failed",
      reason: "malformed-worker-result",
      teardown: "exited-without-signal",
    });
  });

  it("rejects a missing worker result", async () => {
    expect(await runFixture("no-result")).toMatchObject({
      status: "failed",
      reason: "missing-worker-result",
      teardown: "exited-without-signal",
    });
  });

  it("escalates an ignored graceful termination through the owned process group", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worker-signal-"));
    const signalFile = NodePath.join(root, "signals");
    try {
      const result = await runFixture("ignore-graceful", {
        deadlineMs: 100,
        graceMs: 50,
        signalFile,
      });
      expect(result).toMatchObject({
        status: "failed",
        reason: "worker-deadline-exceeded",
        teardown: "terminated-forcibly",
      });
      expect(NodeFS.readFileSync(signalFile, "utf8")).toBe("SIGTERM\n");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("awaits final exit before returning from graceful termination", async () => {
    let handle: ExternalMcpLiveWorkerProcessHandle | undefined;
    const result = await runFixture("delayed-graceful", {
      deadlineMs: 100,
      graceMs: 300,
      onSpawn: (spawned) => {
        handle = spawned;
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "worker-deadline-exceeded",
      teardown: "terminated-gracefully",
    });
    expect(handle).toBeDefined();
    expect(processExists(handle!.pid)).toBe(false);
  });

  it("kills a live descendant by the recorded group and returns only after both PIDs are gone", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worker-descendant-"));
    const descendantPidFile = NodePath.join(root, "descendant-pid");
    let workerHandle: ExternalMcpLiveWorkerProcessHandle | undefined;
    try {
      const result = await runFixture("live-descendant", {
        harness: "opencode",
        descendantPidFile,
        deadlineMs: 100,
        graceMs: 50,
        onSpawn: (handle) => {
          workerHandle = handle;
        },
      });
      const descendantPid = Number(NodeFS.readFileSync(descendantPidFile, "utf8"));
      expect(result).toMatchObject({
        status: "failed",
        reachedStage: "turn",
        reason: "stage-timed-out",
        teardown: "terminated-forcibly",
      });
      expect(workerHandle).toBeDefined();
      expect(processExists(workerHandle!.pid)).toBe(false);
      expect(processExists(descendantPid)).toBe(false);
    } finally {
      if (NodeFS.existsSync(descendantPidFile)) {
        const descendantPid = Number(NodeFS.readFileSync(descendantPidFile, "utf8"));
        if (processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
      }
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }, 3_000);

  it("reaps a detached descendant created immediately before the worker exits", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worker-late-descendant-"));
    const descendantPidFile = NodePath.join(root, "descendant-pid");
    try {
      const result = await runFixture("late-detached-descendant", { descendantPidFile });
      const descendant = JSON.parse(NodeFS.readFileSync(descendantPidFile, "utf8")) as {
        readonly hostPid: number;
        readonly namespacePid: number;
      };
      expect(result).toMatchObject({
        status: "failed",
        reason: "worker-left-descendants",
        teardown: "terminated-forcibly",
      });
      expect(descendant.hostPid).not.toBe(descendant.namespacePid);
      expect(processExists(descendant.hostPid)).toBe(false);
    } finally {
      if (NodeFS.existsSync(descendantPidFile)) {
        const descendant = JSON.parse(NodeFS.readFileSync(descendantPidFile, "utf8")) as {
          readonly hostPid: number;
        };
        if (processExists(descendant.hostPid)) process.kill(descendant.hostPid, "SIGKILL");
      }
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }, 3_000);

  it("rejects duplicate structured results", async () => {
    expect(await runFixture("duplicate")).toMatchObject({
      status: "failed",
      reason: "duplicate-worker-result",
    });
  });

  it("rejects a result for the wrong harness", async () => {
    expect(await runFixture("wrong-harness")).toMatchObject({
      harness: "codex",
      status: "failed",
      reason: "wrong-harness-result",
    });
  });

  it("rejects a result first written after the deadline", async () => {
    expect(await runFixture("late-result", { deadlineMs: 100 })).toMatchObject({
      status: "failed",
      reason: "late-worker-result",
      teardown: "terminated-gracefully",
    });
  });

  it("contains credential-shaped environment, stdout, and stderr values", async () => {
    const sentinel = `Bearer credential-${NodeCrypto.randomBytes(16).toString("hex")}`;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    let result: Awaited<ReturnType<typeof runFixture>> | undefined;
    let discardedOutput: ExternalMcpLiveWorkerDiscardedOutput | undefined;
    let thrown: unknown;
    try {
      result = await runFixture("secret-output", {
        secret: sentinel,
        onDiscardedOutput: (summary) => {
          discardedOutput = summary;
        },
      });
    } catch (cause) {
      thrown = cause;
    }

    const observable = JSON.stringify({
      result,
      thrown: thrown instanceof Error ? thrown.message : thrown,
      log: log.mock.calls,
      error: error.mock.calls,
      warn: warn.mock.calls,
      stdout: stdout.mock.calls.map(([chunk]) => String(chunk)),
      stderr: stderr.mock.calls.map(([chunk]) => String(chunk)),
    });
    expect(observable).not.toContain(sentinel);
    expect(result).toMatchObject({ status: "passed", reason: "all-assertions-passed" });
    expect(discardedOutput).toEqual({
      stdoutBytes: Buffer.byteLength(`${sentinel}\n`),
      stderrBytes: Buffer.byteLength(`${sentinel}\n`),
    });
  });

  it("lets a later worker complete after a prior worker required forced termination", async () => {
    const first = await runFixture("ignore-graceful", { deadlineMs: 100, graceMs: 50 });
    const second = await runFixture("success", { harness: "grok" });
    expect(first.teardown).toBe("terminated-forcibly");
    expect(second).toMatchObject({
      harness: "grok",
      status: "passed",
      teardown: "exited-without-signal",
    });
  });

  it("requires the top-level live-probe opt-in in a worker context", () => {
    expect(() =>
      readExternalMcpLiveWorkerContext({
        [EXTERNAL_MCP_LIVE_WORKER_PROTOCOL_ENV]: "1",
        [EXTERNAL_MCP_LIVE_WORKER_HARNESS_ENV]: "codex",
        [EXTERNAL_MCP_LIVE_WORKER_RESULT_FILE_ENV]: "/tmp/generic-worker-result",
      }),
    ).toThrow("live worker context unavailable");
  });

  it("publishes one versioned result bound to the parent-selected harness", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worker-publish-"));
    const resultFile = NodePath.join(root, "result.ndjson");
    try {
      publishExternalMcpLiveWorkerResult(
        {
          status: "failed",
          reachedStage: "turn",
          reason: "stage-timed-out",
        },
        {
          [EXTERNAL_MCP_LIVE_PROBE_ENV]: "1",
          [EXTERNAL_MCP_LIVE_WORKER_PROTOCOL_ENV]: "1",
          [EXTERNAL_MCP_LIVE_WORKER_HARNESS_ENV]: "opencode",
          [EXTERNAL_MCP_LIVE_WORKER_RESULT_FILE_ENV]: resultFile,
        },
      );
      expect(JSON.parse(NodeFS.readFileSync(resultFile, "utf8"))).toEqual({
        protocol: 1,
        harness: "opencode",
        status: "failed",
        reachedStage: "turn",
        reason: "stage-timed-out",
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a credential-shaped worker reason without disclosing it", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worker-reason-"));
    const resultFile = NodePath.join(root, "result.ndjson");
    const sentinel = `Bearer credential-${NodeCrypto.randomBytes(16).toString("hex")}`;
    let thrown: unknown;
    try {
      try {
        publishExternalMcpLiveWorkerResult(
          {
            status: "failed",
            reachedStage: "turn",
            reason: sentinel,
          } as never,
          {
            [EXTERNAL_MCP_LIVE_PROBE_ENV]: "1",
            [EXTERNAL_MCP_LIVE_WORKER_PROTOCOL_ENV]: "1",
            [EXTERNAL_MCP_LIVE_WORKER_HARNESS_ENV]: "claudeAgent",
            [EXTERNAL_MCP_LIVE_WORKER_RESULT_FILE_ENV]: resultFile,
          },
        );
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain(sentinel);
      expect(NodeFS.existsSync(resultFile)).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
