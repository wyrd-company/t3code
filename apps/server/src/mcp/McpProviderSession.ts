import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export const INTERNAL_MCP_SERVER_NAME = "t3-code";
export const DEFAULT_EXTERNAL_MCP_SERVER_NAME = "external";

interface McpProviderSessionConfigBase {
  readonly name: string;
  readonly threadId: ThreadId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly browserToolsAvailable: boolean;
}

export interface InternalMcpProviderSessionConfig extends McpProviderSessionConfigBase {
  readonly name: typeof INTERNAL_MCP_SERVER_NAME;
  readonly source: "internal";
  readonly environmentId: EnvironmentId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface ExternalMcpProviderSessionConfig extends McpProviderSessionConfigBase {
  readonly source: "external";
  readonly browserToolsAvailable: false;
}

export type McpProviderSessionConfig =
  | InternalMcpProviderSessionConfig
  | ExternalMcpProviderSessionConfig;

const sessionsByThread = new Map<ThreadId, Map<string, McpProviderSessionConfig>>();

const entriesForThread = (threadId: ThreadId) => {
  const existing = sessionsByThread.get(threadId);
  if (existing) return existing;
  const entries = new Map<string, McpProviderSessionConfig>();
  sessionsByThread.set(threadId, entries);
  return entries;
};

const deleteEntry = (threadId: ThreadId, name: string) => {
  const entries = sessionsByThread.get(threadId);
  if (!entries) return;
  entries.delete(name);
  if (entries.size === 0) sessionsByThread.delete(threadId);
};

export function setMcpProviderSession(
  config: Omit<InternalMcpProviderSessionConfig, "name">,
): void {
  entriesForThread(config.threadId).set(INTERNAL_MCP_SERVER_NAME, {
    ...config,
    name: INTERNAL_MCP_SERVER_NAME,
  });
}

export function readMcpProviderSession(
  threadId: ThreadId,
): InternalMcpProviderSessionConfig | undefined {
  const config = sessionsByThread.get(threadId)?.get(INTERNAL_MCP_SERVER_NAME);
  return config?.source === "internal" ? config : undefined;
}

export function readMcpProviderSessions(
  threadId: ThreadId,
): ReadonlyArray<McpProviderSessionConfig> {
  return Array.from(sessionsByThread.get(threadId)?.values() ?? []);
}

/** @deprecated Read all entries with `readMcpProviderSessions`. */
export function readMcpProviderSessionIncludingExternal(
  threadId: ThreadId,
): McpProviderSessionConfig | undefined {
  return readMcpProviderSessions(threadId)[0];
}

export function hasInternalMcpProviderSession(threadId: ThreadId): boolean {
  return readMcpProviderSession(threadId) !== undefined;
}

export function setExternalMcpProviderSession(
  config: Omit<ExternalMcpProviderSessionConfig, "source" | "browserToolsAvailable" | "name"> & {
    readonly name?: string;
  },
): boolean {
  const name = config.name ?? DEFAULT_EXTERNAL_MCP_SERVER_NAME;
  if (name === INTERNAL_MCP_SERVER_NAME) return false;
  entriesForThread(config.threadId).set(name, {
    ...config,
    name,
    source: "external",
    browserToolsAvailable: false,
  });
  return true;
}

export function clearInternalMcpProviderSession(threadId: ThreadId): void {
  deleteEntry(threadId, INTERNAL_MCP_SERVER_NAME);
}

export function clearExternalMcpProviderSession(
  threadId: ThreadId,
  name = DEFAULT_EXTERNAL_MCP_SERVER_NAME,
): void {
  const entry = sessionsByThread.get(threadId)?.get(name);
  if (entry?.source === "external") deleteEntry(threadId, name);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  clearInternalMcpProviderSession(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
