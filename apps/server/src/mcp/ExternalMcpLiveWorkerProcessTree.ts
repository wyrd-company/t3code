// ---
// relationships:
//   supports: external-mcp-registration
// ---
// @effect-diagnostics nodeBuiltinImport:off -- Linux /proc binds descendants to the exact spawned worker.
import * as NodeFS from "node:fs";

export interface ExternalMcpLiveWorkerProcessHandle {
  readonly pid: number;
  readonly processGroupId: number;
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const processGroupExists = (processGroupId: number): boolean => {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const readProcessGroupId = (pid: number): number | undefined => {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const processGroupId = Number(fields[2]);
    return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : undefined;
  } catch {
    return undefined;
  }
};

const readChildPids = (pid: number): ReadonlyArray<number> => {
  try {
    const taskDirectory = `/proc/${pid}/task`;
    const children = new Set<number>();
    for (const task of NodeFS.readdirSync(taskDirectory, { withFileTypes: true })) {
      if (!task.isDirectory()) continue;
      try {
        const value = NodeFS.readFileSync(`${taskDirectory}/${task.name}/children`, "utf8");
        for (const token of value.trim().split(/\s+/u)) {
          const childPid = Number(token);
          if (Number.isSafeInteger(childPid) && childPid > 0) children.add(childPid);
        }
      } catch {
        // A thread or child can exit between the directory read and this read.
      }
    }
    return [...children];
  } catch {
    return [];
  }
};

/** Records Linux descendants by their exact parent-child relation, never by command name. */
export class ExternalMcpLiveWorkerProcessTree {
  readonly #handles = new Map<number, ExternalMcpLiveWorkerProcessHandle>();

  constructor(root: ExternalMcpLiveWorkerProcessHandle) {
    this.#handles.set(root.pid, root);
  }

  refresh(): void {
    const pending = [...this.#handles.keys()];
    const inspected = new Set<number>();
    while (pending.length > 0) {
      const pid = pending.pop()!;
      if (inspected.has(pid)) continue;
      inspected.add(pid);
      for (const childPid of readChildPids(pid)) {
        if (!this.#handles.has(childPid)) {
          const processGroupId = readProcessGroupId(childPid);
          if (processGroupId !== undefined) {
            this.#handles.set(childPid, { pid: childPid, processGroupId });
          }
        }
        pending.push(childPid);
      }
    }
  }

  signal(signal: NodeJS.Signals, signaledGroups?: Set<number>): boolean {
    this.refresh();
    let sent = false;
    const processGroups = new Set(
      [...this.#handles.values()].map(({ processGroupId }) => processGroupId),
    );
    for (const processGroupId of processGroups) {
      if (signaledGroups?.has(processGroupId)) continue;
      signaledGroups?.add(processGroupId);
      try {
        process.kill(-processGroupId, signal);
        sent = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return sent;
  }

  hasLiveProcess(): boolean {
    this.refresh();
    return [...this.#handles.values()].some(
      ({ pid, processGroupId }) => processExists(pid) || processGroupExists(processGroupId),
    );
  }
}
