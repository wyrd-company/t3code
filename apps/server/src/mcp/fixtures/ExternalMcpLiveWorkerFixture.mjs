// ---
// relationships:
//   validates: external-mcp-registration
// ---
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const mode = process.env.T3_EXTERNAL_MCP_WORKER_FIXTURE_MODE;
const harness = process.env.T3_EXTERNAL_MCP_LIVE_WORKER_HARNESS;
const resultFile = process.env.T3_EXTERNAL_MCP_LIVE_WORKER_RESULT_FILE;
const signalFile = process.env.T3_EXTERNAL_MCP_WORKER_FIXTURE_SIGNAL_FILE;

const write = (value) => NodeFS.appendFileSync(resultFile, `${JSON.stringify(value)}\n`);
const result = (overrides = {}) => ({
  protocol: 1,
  harness,
  status: "passed",
  reachedStage: "complete",
  reason: "all-assertions-passed",
  ...overrides,
});
const recordSignal = (signal) => {
  if (signalFile !== undefined) NodeFS.appendFileSync(signalFile, `${signal}\n`);
};
const stayAlive = () => setInterval(() => undefined, 1_000);

switch (mode) {
  case "success":
    write(result());
    break;
  case "non-zero":
    write(result({ status: "failed", reachedStage: "turn", reason: "stage-failed" }));
    process.exit(17);
    break;
  case "malformed":
    NodeFS.appendFileSync(resultFile, "{not-json}\n");
    break;
  case "inconsistent-passed":
    write(result({ reachedStage: "turn", reason: "stage-failed" }));
    break;
  case "no-result":
    break;
  case "ignore-graceful":
    process.on("SIGTERM", () => recordSignal("SIGTERM"));
    stayAlive();
    break;
  case "stuck-finalizer":
    write(result());
    process.on("SIGTERM", () => recordSignal("SIGTERM"));
    stayAlive();
    break;
  case "live-descendant": {
    const descendantPidFile = process.env.T3_EXTERNAL_MCP_WORKER_FIXTURE_DESCENDANT_PID_FILE;
    const descendant = NodeChildProcess.spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => undefined, 1000);"],
      { detached: true, stdio: "ignore" },
    );
    NodeFS.writeFileSync(descendantPidFile, String(descendant.pid));
    write(result({ status: "failed", reachedStage: "turn", reason: "stage-timed-out" }));
    process.on("SIGTERM", () => process.exit(0));
    stayAlive();
    break;
  }
  case "duplicate":
    write(result());
    write(result());
    break;
  case "wrong-harness":
    write(result({ harness: harness === "codex" ? "grok" : "codex" }));
    break;
  case "late-result":
    process.on("SIGTERM", () => {
      write(result({ status: "failed", reachedStage: "turn", reason: "stage-timed-out" }));
      process.exit(0);
    });
    stayAlive();
    break;
  case "secret-output": {
    const secret = process.env.T3_EXTERNAL_MCP_WORKER_FIXTURE_SECRET;
    process.stdout.write(`${secret}\n`);
    process.stderr.write(`${secret}\n`);
    write(result());
    break;
  }
  default:
    process.exit(19);
}
