// ---
// relationships:
//   supports: external-mcp-registration
// ---
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const [executable, ...args] = process.argv.slice(2);

const childPids = () => {
  const children = new Set();
  for (const task of NodeFS.readdirSync("/proc/self/task", { withFileTypes: true })) {
    if (!task.isDirectory()) continue;
    try {
      const value = NodeFS.readFileSync(`/proc/self/task/${task.name}/children`, "utf8");
      for (const token of value.trim().split(/\s+/u)) {
        const pid = Number(token);
        if (Number.isSafeInteger(pid) && pid > 0) children.add(pid);
      }
    } catch {
      // A thread or adopted child can exit between the directory read and this read.
    }
  }
  return children;
};

const publishStatus = (status) => {
  NodeFS.writeSync(3, `${JSON.stringify({ protocol: 1, ...status })}\n`);
};

process.on("SIGTERM", () => {
  // The supervisor must retain adopted descendants through the parent's grace period.
});

if (executable === undefined) {
  publishStatus({ kind: "spawn-failed" });
  process.exit(1);
}

const worker = NodeChildProcess.spawn(executable, args, {
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
});

worker.once("error", () => {
  publishStatus({ kind: "spawn-failed" });
  process.exit(1);
});

worker.once("exit", (code, signal) => {
  const leftDescendants = childPids().size > 0;
  publishStatus({ kind: "exited", code, signal, leftDescendants });
  if (leftDescendants) {
    setInterval(() => undefined, 1_000);
    return;
  }
  process.exit(0);
});
