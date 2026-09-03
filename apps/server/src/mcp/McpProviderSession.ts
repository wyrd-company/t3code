import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

interface McpProviderSessionConfigBase {
  readonly threadId: ThreadId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly browserToolsAvailable: boolean;
}

export interface InternalMcpProviderSessionConfig extends McpProviderSessionConfigBase {
  readonly source: "internal";
  readonly environmentId: EnvironmentId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<InternalMcpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

export interface ExternalMcpProviderSessionConfig extends McpProviderSessionConfigBase {
  readonly source: "external";
  readonly browserToolsAvailable: false;
}

export type McpProviderSessionConfig =
  | InternalMcpProviderSessionConfig
  | ExternalMcpProviderSessionConfig;

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: InternalMcpProviderSessionConfig): void {
  if (sessionsByThread.get(config.threadId)?.source === "external") {
    return;
  }
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  const config = sessionsByThread.get(threadId);
  return config?.source === "internal" ? config : undefined;
}

export function readMcpProviderSessionIncludingExternal(
  threadId: ThreadId,
): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function setExternalMcpProviderSession(
  config: Omit<ExternalMcpProviderSessionConfig, "source" | "browserToolsAvailable">,
): void {
  sessionsByThread.set(config.threadId, {
    ...config,
    source: "external",
    // An external MCP endpoint does not expose T3's browser automation tools.
    browserToolsAvailable: false,
  });
}

export function clearInternalMcpProviderSession(threadId: ThreadId): void {
  if (sessionsByThread.get(threadId)?.source === "internal") {
    sessionsByThread.delete(threadId);
  }
}

export function clearExternalMcpProviderSession(threadId: ThreadId): void {
  if (sessionsByThread.get(threadId)?.source === "external") {
    sessionsByThread.delete(threadId);
  }
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
