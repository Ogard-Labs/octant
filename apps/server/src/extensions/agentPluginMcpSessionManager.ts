import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import type {
  ExtensionEffectiveSnapshot,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import {
  decodeProviderToolAnswer,
  decodeProviderToolDefinition,
  type ChatThread,
  type ProviderToolDefinition,
  type WindowId,
} from "@octant/contracts";
import {
  connectAgentPluginMcpSession,
  type AgentPluginMcpSession,
  type AgentPluginMcpStdioProcessPort,
  type McpToolDefinition,
} from "./agentPluginMcpClient";
import { prepareAgentPluginMcpRuntime } from "./agentPluginMcpRuntime";
import type { ExtensionPackageStore } from "./extensionPackageStore";
import type { ExtensionToolExecutionPort } from "./extensionChatResolver";
import type { ExtensionRuntimeStartInput, ExtensionSupervisor } from "./extensionSupervisor";

export interface AgentPluginMcpSessionKey {
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly version: string;
  readonly digest: string;
  readonly configurationEntryPoint: string;
  readonly scope: ExtensionEffectiveSnapshot["scope"];
}

export interface AgentPluginMcpSessionRecord extends AgentPluginMcpSessionKey {
  readonly serverName: string;
  readonly session: AgentPluginMcpSession;
  readonly tools: ReadonlyArray<McpToolDefinition>;
}

export interface AgentPluginMcpSessionManagerOptions {
  readonly store: Pick<
    ExtensionPackageStore,
    "contentRoot" | "readVerifiedConfiguration" | "pluginDataRoot"
  >;
  readonly fetch?: typeof globalThis.fetch;
  readonly connectionTimeoutMs?: number;
  readonly toolCallTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly stdioSupervisor?: Pick<ExtensionSupervisor, "startInteractive">;
  readonly baseEnv?: Readonly<Record<string, string>>;
  readonly authorizeToolCall?: (input: {
    readonly windowId?: WindowId;
    readonly thread: ChatThread;
    readonly packageId: string;
    readonly componentId: string;
    readonly providerToolName: string;
    readonly mcpToolName: string;
    readonly inputJson: string;
    readonly signal?: AbortSignal;
  }) => Promise<boolean>;
}

/**
 * Connects Agent Plugins MCP servers for effective components and exposes tools
 * for chat execution. Continues after individual server failures.
 */
export class AgentPluginMcpSessionManager {
  readonly #store: AgentPluginMcpSessionManagerOptions["store"];
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #connectionTimeoutMs: number;
  readonly #toolCallTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #stdioSupervisor: Pick<ExtensionSupervisor, "startInteractive"> | undefined;
  readonly #baseEnv: Readonly<Record<string, string>>;
  readonly #authorizeToolCall: AgentPluginMcpSessionManagerOptions["authorizeToolCall"];
  readonly #sessions = new Map<string, AgentPluginMcpSessionRecord>();
  readonly #desired = new Map<
    string,
    AgentPluginMcpSessionKey & { readonly serverNameHint: string }
  >();
  readonly #connections = new Map<string, Promise<void>>();
  readonly #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #toolIndex = new Map<
    string,
    { readonly sessionKey: string; readonly toolName: string }
  >();
  readonly #failures = new Map<
    string,
    {
      readonly target: AgentPluginMcpSessionKey;
      readonly reason: string;
    }
  >();

  constructor(options: AgentPluginMcpSessionManagerOptions) {
    this.#store = options.store;
    this.#fetch = options.fetch;
    this.#connectionTimeoutMs = options.connectionTimeoutMs ?? 5_000;
    this.#toolCallTimeoutMs = boundedTimeout(options.toolCallTimeoutMs, 30_000, 60_000);
    this.#idleTimeoutMs = boundedTimeout(options.idleTimeoutMs, 5 * 60_000, 30 * 60_000);
    this.#stdioSupervisor = options.stdioSupervisor;
    this.#baseEnv = options.baseEnv ?? approvedAgentPluginMcpBaseEnvironment();
    this.#authorizeToolCall = options.authorizeToolCall;
  }

  sessions(): ReadonlyArray<AgentPluginMcpSessionRecord> {
    return [...this.#sessions.values()];
  }

  failedComponents(): ReadonlyArray<{
    readonly packageId: string;
    readonly componentId: string;
    readonly reason: string;
  }> {
    return [...this.#failures.values()].map(({ target, reason }) => ({
      packageId: target.packageId,
      componentId: target.componentId,
      reason,
    }));
  }

  projectEffectiveState(effective: ExtensionEffectiveSnapshot): ExtensionEffectiveSnapshot {
    if (this.#failures.size === 0) return effective;
    const failed = new Set(
      [...this.#failures.values()]
        .filter(
          ({ target }) => authorityScopeKey(target.scope) === authorityScopeKey(effective.scope),
        )
        .map(({ target }) => `${target.packageId}\u0000${target.componentId}`),
    );
    return {
      ...effective,
      packages: effective.packages.map((packageState) => ({
        ...packageState,
        components: packageState.components.map((componentState) => {
          if (
            componentState.effectiveState.kind !== "effective" ||
            !failed.has(`${packageState.packageId}\u0000${componentState.component.id}`)
          ) {
            return componentState;
          }
          return {
            ...componentState,
            effectiveState: { kind: "blocked" as const, reason: "unavailable" as const },
            contextContribution: { kind: "zero" as const, reason: "unavailable" as const },
          };
        }),
      })),
    };
  }

  toolDefinitions(): ReadonlyArray<ProviderToolDefinition> {
    return this.#definitions([...this.#sessions.values()]);
  }

  toolDefinitionsFor(
    packageId: string,
    componentId: string,
    scope: ExtensionEffectiveSnapshot["scope"],
  ): ReadonlyArray<ProviderToolDefinition> {
    const requestedScope = authorityScopeKey(scope);
    return this.#definitions(
      [...this.#sessions.values()].filter(
        (record) =>
          record.packageId === packageId &&
          record.componentId === componentId &&
          authorityScopeKey(record.scope) === requestedScope,
      ),
    );
  }

  createToolExecutionPort(): ExtensionToolExecutionPort {
    return {
      availability: ({ definitions }) => {
        if (definitions.length === 0) return "unavailable";
        const missing = definitions.some((definition) => !this.#toolIndex.has(definition.name));
        return missing ? "unavailable" : "available";
      },
      execute: async ({ windowId, thread, name, inputJson, signal }) => {
        const indexed = this.#toolIndex.get(name);
        if (indexed === undefined) {
          return { result: { error: "extension-tool-unavailable" }, isError: true };
        }
        const record = this.#sessions.get(indexed.sessionKey);
        if (record === undefined) {
          return { result: { error: "extension-tool-unavailable" }, isError: true };
        }
        if (
          String(record.scope.threadId) !== String(thread.id) ||
          String(record.scope.projectId ?? "") !== String(thread.projectId ?? "")
        ) {
          return { result: { error: "extension-tool-authority-mismatch" }, isError: true };
        }
        const approved =
          this.#authorizeToolCall === undefined
            ? false
            : await this.#authorizeToolCall({
                thread,
                ...(windowId === undefined ? {} : { windowId }),
                packageId: record.packageId,
                componentId: record.componentId,
                providerToolName: name,
                mcpToolName: indexed.toolName,
                inputJson,
                ...(signal === undefined ? {} : { signal }),
              }).catch(() => false);
        if (!approved) {
          return { result: { error: "extension-tool-approval-required" }, isError: true };
        }
        this.#touchIdle(indexed.sessionKey);
        const controller = new AbortController();
        const onCallerAbort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener("abort", onCallerAbort, { once: true });
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.#toolCallTimeoutMs);
        timeout.unref?.();
        try {
          const args = inputJson.trim() === "" ? {} : JSON.parse(inputJson);
          const result = await record.session.callTool(indexed.toolName, args, controller.signal);
          if (!isProviderSafeToolResult(result)) {
            return {
              result: { error: "MCP tool result exceeded provider limits." },
              isError: true,
            };
          }
          return { result };
        } catch (error) {
          if (controller.signal.aborted) {
            await this.#close(indexed.sessionKey, record);
            const desired = this.#desired.get(indexed.sessionKey);
            if (desired !== undefined) {
              this.#failures.set(indexed.sessionKey, {
                target: desired,
                reason: "MCP tool transport closed; authority reconciliation is required.",
              });
            }
          }
          return {
            result: {
              error: timedOut
                ? "MCP tool call timed out."
                : error instanceof Error
                  ? error.message
                  : "MCP tool call failed",
            },
            isError: true,
          };
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onCallerAbort);
        }
      },
    };
  }

  async reconcile(effective: ExtensionEffectiveSnapshot): Promise<void> {
    const currentScope = authorityScopeKey(effective.scope);
    const desired = new Map<string, AgentPluginMcpSessionKey & { serverNameHint: string }>();
    for (const packageState of effective.packages) {
      for (const componentState of packageState.components) {
        if (componentState.effectiveState.kind !== "effective") continue;
        if (componentState.component.kind !== "mcp-server") continue;
        const key = {
          extensionId: packageState.extensionId,
          packageId: packageState.packageId,
          componentId: componentState.component.id,
          version: packageState.version,
          digest: packageState.digest,
          configurationEntryPoint: componentState.component.entryPoint ?? "mcp.json",
          scope: effective.scope,
          serverNameHint: componentState.component.displayName,
        };
        desired.set(sessionKey(key), key);
      }
    }
    for (const [key, target] of this.#desired) {
      if (authorityScopeKey(target.scope) === currentScope && !desired.has(key)) {
        this.#desired.delete(key);
      }
    }
    for (const [key, target] of desired) this.#desired.set(key, target);

    for (const [key, record] of this.#sessions) {
      if (authorityScopeKey(record.scope) === currentScope && !desired.has(key)) {
        await this.#close(key, record);
      }
    }

    for (const [key, failure] of this.#failures) {
      if (authorityScopeKey(failure.target.scope) === currentScope && !desired.has(key)) {
        this.#failures.delete(key);
      }
    }

    for (const [key, target] of desired) {
      const existing = this.#sessions.get(key);
      if (
        existing !== undefined &&
        existing.version === target.version &&
        existing.digest === target.digest
      ) {
        this.#failures.delete(key);
        continue;
      }
      if (existing !== undefined) await this.#close(key, existing);
      try {
        await this.#connectOnce(target);
        this.#failures.delete(key);
      } catch (error) {
        // Independent MCP server failure must not block siblings, but the
        // component must not remain advertised as effective/active.
        this.#failures.set(key, {
          target,
          reason: error instanceof Error ? error.message : "MCP connection failed.",
        });
      }
    }
  }

  async drainAll(): Promise<void> {
    this.#desired.clear();
    this.#failures.clear();
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
    await Promise.allSettled(this.#connections.values());
    for (const [key, record] of this.#sessions) {
      await this.#close(key, record);
    }
  }

  /**
   * Applies lifecycle mutations without widening Settings into thread authority.
   * Only sessions whose installed package/component stopped being effective are
   * drained; unrelated transports and in-flight calls remain intact.
   */
  async reconcileLifecycleSnapshot(snapshot: ExtensionSnapshot): Promise<void> {
    const retained = new Set<string>();
    for (const [key, target] of this.#desired) {
      const packageState = snapshot.packages.find(
        (candidate) =>
          candidate.extensionId === target.extensionId &&
          candidate.packageId === target.packageId &&
          candidate.version === target.version &&
          candidate.digest === target.digest,
      );
      const componentState = packageState?.components.find(
        (candidate) => candidate.component.id === target.componentId,
      );
      if (componentState?.effectiveState.kind === "effective") retained.add(key);
    }

    for (const [key, record] of this.#sessions) {
      if (!retained.has(key)) await this.#close(key, record);
    }
    for (const key of this.#desired.keys()) {
      if (!retained.has(key)) this.#desired.delete(key);
    }
    for (const key of this.#failures.keys()) {
      if (!retained.has(key)) this.#failures.delete(key);
    }
  }

  async #connect(target: AgentPluginMcpSessionKey & { serverNameHint: string }): Promise<void> {
    const versionRef = {
      extensionId: target.extensionId,
      packageId: target.packageId,
      version: target.version,
      digest: target.digest,
    };
    const mcpJson = JSON.parse(
      await this.#store.readVerifiedConfiguration(versionRef, target.componentId),
    );
    const pluginRoot = this.#store.contentRoot(versionRef);
    const plan = await prepareAgentPluginMcpRuntime(mcpJson, {
      pluginRoot,
      pluginDataRoot: this.#store.pluginDataRoot(),
      pluginIdentity: `${target.extensionId}-${target.packageId}`,
      baseEnv: this.#baseEnv,
      supportedTransports: new Set(["stdio", "streamable-http"]),
    });
    const selectedLaunch =
      plan.launches.find((candidate) => candidate.name === target.serverNameHint) ??
      plan.launches.find((candidate) => `mcp-${tokenize(candidate.name)}` === target.componentId);
    if (selectedLaunch === undefined) {
      throw new Error(`MCP server for ${target.componentId} is unavailable.`);
    }
    const launch =
      selectedLaunch.transport === "stdio" && !isAbsolute(selectedLaunch.command)
        ? {
            ...selectedLaunch,
            command: await resolveApprovedExecutable(selectedLaunch.command, this.#baseEnv.PATH),
          }
        : selectedLaunch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#connectionTimeoutMs);
    timeout.unref?.();
    let session: AgentPluginMcpSession;
    try {
      session = await connectAgentPluginMcpSession(launch, {
        signal: controller.signal,
        onTransportClosed: () => this.#handleTransportClosed(sessionKey(target), target),
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        ...(launch.transport !== "stdio" || this.#stdioSupervisor === undefined
          ? {}
          : {
              stdioProcess: supervisedStdioProcessPort({
                supervisor: this.#stdioSupervisor,
                target,
              }),
            }),
      });
    } finally {
      clearTimeout(timeout);
    }
    const record: AgentPluginMcpSessionRecord = {
      extensionId: target.extensionId,
      packageId: target.packageId,
      componentId: target.componentId,
      version: target.version,
      digest: target.digest,
      configurationEntryPoint: target.configurationEntryPoint,
      scope: target.scope,
      serverName: launch.name,
      session,
      tools: session.tools,
    };
    const key = sessionKey(target);
    if (!this.#desired.has(key) || this.#sessions.has(key)) {
      await session.close().catch(() => undefined);
      return;
    }
    this.#sessions.set(key, record);
    this.#touchIdle(key);
    this.#reindex();
  }

  #connectOnce(
    target: AgentPluginMcpSessionKey & { readonly serverNameHint: string },
  ): Promise<void> {
    const key = sessionKey(target);
    const existing = this.#connections.get(key);
    if (existing !== undefined) return existing;
    const pending = this.#connect(target).finally(() => {
      if (this.#connections.get(key) === pending) this.#connections.delete(key);
    });
    this.#connections.set(key, pending);
    return pending;
  }

  #handleTransportClosed(
    key: string,
    target: AgentPluginMcpSessionKey & { readonly serverNameHint: string },
  ): void {
    const idleTimer = this.#idleTimers.get(key);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    this.#idleTimers.delete(key);
    this.#sessions.delete(key);
    this.#reindex();
    this.#failures.set(key, {
      target,
      reason: "MCP stdio transport closed; authority reconciliation is required.",
    });
  }

  async #close(key: string, record: AgentPluginMcpSessionRecord): Promise<void> {
    const idleTimer = this.#idleTimers.get(key);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    this.#idleTimers.delete(key);
    this.#sessions.delete(key);
    this.#reindex();
    await record.session.close().catch(() => undefined);
  }

  #touchIdle(key: string): void {
    const existing = this.#idleTimers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#idleTimers.delete(key);
      const record = this.#sessions.get(key);
      if (record === undefined) return;
      // Retire the scope entirely so an intentional idle close cannot trigger
      // reconnect. The next turn's authority reconciliation recreates it.
      this.#desired.delete(key);
      void this.#close(key, record);
    }, this.#idleTimeoutMs);
    timer.unref?.();
    this.#idleTimers.set(key, timer);
  }

  #reindex(): void {
    this.#toolIndex.clear();
    for (const [key, record] of this.#sessions) {
      for (const tool of record.tools) {
        this.#toolIndex.set(toolQualifiedName(record, tool.name), {
          sessionKey: key,
          toolName: tool.name,
        });
      }
    }
  }

  #definitions(
    records: ReadonlyArray<AgentPluginMcpSessionRecord>,
  ): ReadonlyArray<ProviderToolDefinition> {
    return records.flatMap((record) =>
      record.tools.flatMap((tool) => {
        try {
          return [
            decodeProviderToolDefinition({
              name: toolQualifiedName(record, tool.name),
              ...boundedToolDescription(tool.description),
              inputSchema:
                tool.inputSchema !== undefined &&
                typeof tool.inputSchema === "object" &&
                tool.inputSchema !== null &&
                !Array.isArray(tool.inputSchema)
                  ? tool.inputSchema
                  : {},
            }),
          ];
        } catch {
          return [];
        }
      }),
    );
  }
}

export function approvedAgentPluginMcpBaseEnvironment(): Readonly<Record<string, string>> {
  return {
    HOME: homedir(),
    PATH: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
  };
}

async function resolveApprovedExecutable(command: string, approvedPath: string | undefined) {
  if (isAbsolute(command)) return command;
  for (const directory of (approvedPath ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the fixed, reviewed search path.
    }
  }
  throw new Error(`MCP stdio executable ${command} is unavailable on the approved host path.`);
}

function supervisedStdioProcessPort(input: {
  readonly supervisor: Pick<ExtensionSupervisor, "startInteractive">;
  readonly target: AgentPluginMcpSessionKey;
}): AgentPluginMcpStdioProcessPort {
  return {
    start: async (launch, signal) => {
      if (!isAbsolute(launch.command)) {
        throw new Error("MCP stdio command was not resolved before supervisor admission.");
      }
      const pluginRoot = launch.env.PLUGIN_ROOT;
      const pluginData = launch.env.PLUGIN_DATA;
      if (
        typeof pluginRoot !== "string" ||
        typeof pluginData !== "string" ||
        !isAbsolute(pluginRoot) ||
        !isAbsolute(pluginData)
      ) {
        throw new Error("MCP stdio sandbox roots are unavailable.");
      }
      const runtime: ExtensionRuntimeStartInput = {
        extensionId: input.target.extensionId,
        packageId: input.target.packageId,
        componentId: input.target.componentId,
        version: input.target.version,
        digest: input.target.digest,
        entryPoint: isContainedPath(pluginRoot, launch.command)
          ? launch.command
          : join(pluginRoot, input.target.configurationEntryPoint),
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: {
          ...launch.env,
          HOME: pluginData,
          TMPDIR: pluginData,
        },
        effective: true,
        approved: true,
        authority: { kind: "trusted-extension", extensionId: input.target.extensionId },
        readiness: "spawn",
        sandbox: {
          kind: "macos-seatbelt",
          scope: input.target.scope,
          allowRead: [pluginRoot, pluginData, launch.cwd],
          allowWrite: [pluginData],
          allowNetwork: false,
        },
      };
      const started = await input.supervisor.startInteractive(runtime, signal);
      if (started.process.stdin === undefined || started.process.stdout === undefined) {
        await started.process.stop().catch(() => undefined);
        throw new Error("Supervised MCP process did not expose stdio.");
      }
      return {
        stdin: started.process.stdin,
        stdout: started.process.stdout,
        stop: started.process.stop,
        once: (_event, listener) => started.process.once("exit", () => listener()),
      };
    },
  };
}

function sessionKey(target: AgentPluginMcpSessionKey): string {
  return `${authorityScopeKey(target.scope)}\u0000${target.extensionId}:${target.packageId}:${target.componentId}:${target.version}:${target.digest}`;
}

function toolQualifiedName(
  record: Pick<AgentPluginMcpSessionRecord, "extensionId" | "packageId" | "componentId" | "scope">,
  toolName: string,
): string {
  const identity = `${authorityScopeKey(record.scope)}:${record.extensionId}:${record.packageId}:${record.componentId}:${toolName}`;
  const readable = `${record.componentId}_${toolName}`
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `ext_${readable || "tool"}_${digest}`;
}

function authorityScopeKey(scope: ExtensionEffectiveSnapshot["scope"]): string {
  return [
    scope.hostId,
    scope.mode,
    scope.projectId ?? "",
    scope.threadId ?? "",
    scope.providerFamily,
  ].join("\u0000");
}

function isContainedPath(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && !child.split(/[\\/]/).includes(".."));
}

function tokenize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function boundedTimeout(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(1, Math.min(Math.floor(value), maximum));
}

function boundedToolDescription(description: string | undefined): {
  readonly description?: string;
} {
  const value = description?.trim();
  return value === undefined || value === "" ? {} : { description: value.slice(0, 2_048) };
}

function isProviderSafeToolResult(result: unknown): boolean {
  try {
    const resultJson = JSON.stringify(result);
    if (typeof resultJson !== "string") return false;
    decodeProviderToolAnswer({
      sessionId: "00000000-0000-4000-8000-000000000001",
      requestId: "extension-tool-result-boundary",
      resultJson,
      isError: false,
    });
    return true;
  } catch {
    return false;
  }
}
