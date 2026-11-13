import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { access, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative } from "node:path";
import type { AnySchema, ValidateFunction } from "ajv";
import type { AgentPluginsMcpLaunchSpec } from "@octant/plugin-host/agent-plugins";
import type {
  ExtensionEffectiveSnapshot,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import {
  decodeProviderToolAnswer,
  decodeProviderToolDefinition,
  type ProviderToolDefinition,
  type ShieldWatcherLabel,
  type WindowId,
} from "@octant/contracts";
import type { ExtensionToolReach } from "@octant/domain/extension-tool-grant-policy";
import { watchedTextOf, watchOutsideContent } from "@octant/domain/shield-watcher-policy";
import {
  connectAgentPluginMcpSession,
  McpHttpStatusError,
  McpJsonRpcError,
  type AgentPluginMcpSession,
  type AgentPluginMcpStdioProcessPort,
  type McpToolDefinition,
} from "./agentPluginMcpClient";
import { prepareAgentPluginMcpRuntime } from "./agentPluginMcpRuntime";
import { startHostAllowListProxy } from "./hostAllowListProxy";
import { frameExternalContentForModel } from "../context/externalContentFraming";
import { recordShieldWatcherLabels } from "../providers/appManagedToolTaint";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { ExtensionPackageStore } from "./extensionPackageStore";
import type { ExtensionToolExecutionPort, ExtensionToolThread } from "./extensionChatResolver";
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

interface McpSessionAuthentication {
  readonly check: () => Promise<"unchanged" | "changed" | "unavailable">;
  readonly rejected: () => Promise<void>;
}

interface PreparedMcpTool {
  readonly listed: McpToolDefinition;
  readonly providerDefinition: ProviderToolDefinition;
  readonly validateInput: ValidateFunction<unknown>;
}

export interface AgentPluginMcpSessionRecord extends AgentPluginMcpSessionKey {
  readonly serverName: string;
  readonly session: AgentPluginMcpSession;
  readonly tools: ReadonlyArray<PreparedMcpTool>;
  readonly reach: ExtensionToolReach;
  readonly askEveryCall: ReadonlyArray<string>;
  readonly authenticationGeneration: number;
  readonly authentication?: McpSessionAuthentication;
  /** Each tool's definition digest, taken once from the listing at connect. */
  readonly toolDefinitionDigests: ReadonlyMap<string, string>;
}

/**
 * One MCP tool call as the host must judge it: who asks, which tool of which
 * package version, how that tool was listed when its session connected, and
 * where its server can reach.
 */
export interface ExtensionToolCall {
  readonly windowId?: WindowId;
  readonly thread: ExtensionToolThread;
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly serverName: string;
  readonly version: string;
  readonly digest: string;
  readonly definitionDigest: string;
  readonly reach: ExtensionToolReach;
  /** True when the catalog lists this tool as ask-every-call. */
  readonly askEveryCall?: boolean;
  readonly providerToolName: string;
  readonly mcpToolName: string;
  readonly inputJson: string;
  readonly signal?: AbortSignal;
}

/** What the manager last saw of one server, for the Settings connection listing. */
export interface McpConnectionObservation {
  readonly extensionId: string;
  readonly componentId: string;
  readonly state: "connected" | "connecting" | "failed" | "idle";
  readonly reason?: string;
  readonly at?: string;
}

function pick(
  target: Pick<AgentPluginMcpSessionKey, "extensionId" | "componentId">,
): Pick<McpConnectionObservation, "extensionId" | "componentId"> {
  return { extensionId: String(target.extensionId), componentId: String(target.componentId) };
}

/** A component the manager should keep connected, with the server name its mcp.json uses. */
type AgentPluginMcpSessionTarget = AgentPluginMcpSessionKey & {
  readonly serverNameHint: string;
  /** True for a package the host wrote for a server the person added by hand. */
  readonly userAdded: boolean;
  /**
   * The hosts a stdio server may reach through the host's proxy, from the
   * bundled catalog entry the host's own store vouches for. Never read from
   * the package.
   */
  readonly egressHosts?: ReadonlyArray<string>;
  /** Tool names the catalog entry lists as ask-every-call, from the same vouched source. */
  readonly askEveryCall?: ReadonlyArray<string>;
  /**
   * The server keeps one login in its plugin data, which two processes must not
   * share (a second refresh revokes it), so at most one process runs at a time.
   */
  readonly exclusive?: true;
};

export interface AgentPluginMcpSessionManagerOptions {
  readonly bindUserAddedAuthentication?: (
    launch: AgentPluginsMcpLaunchSpec,
    target: Pick<AgentPluginMcpSessionKey, "extensionId" | "componentId">,
  ) => Promise<McpSessionAuthentication | undefined>;
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
  /** The host platform; the macOS profile is the one that cannot run a launcher script. */
  readonly platform?: NodeJS.Platform;
  readonly authorizeToolCall?: (call: ExtensionToolCall) => Promise<boolean>;
  readonly recordExternalContentIngestion?: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid?: () => string;
  /** The clock for when a connection opened or failed, as Settings shows it. */
  readonly now?: () => Date;
  /**
   * Fills in the secret references in a launch for a package the host wrote
   * for a server the person added by hand. Only a package the host's own
   * store vouches for (`isUserAddedSource`, by source reference, since an
   * installed manifest's source kind is not trustworthy) is offered the
   * broker: a third-party package never gets to name a secret.
   */
  readonly isUserAddedSource?: (sourceRef: string) => boolean;
  /** The catalog's listed hosts for a package the host wrote for a command connector. */
  readonly egressHostsForSource?: (sourceRef: string) => ReadonlyArray<string> | undefined;
  readonly askEveryCallForSource?: (sourceRef: string) => ReadonlyArray<string> | undefined;
  readonly exclusiveForSource?: (sourceRef: string) => boolean;
  readonly resolveUserAddedSecrets?: (
    launch: AgentPluginsMcpLaunchSpec,
    target: { readonly extensionId: string; readonly componentId: string },
  ) => Promise<AgentPluginsMcpLaunchSpec>;
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
  readonly #platform: NodeJS.Platform;
  readonly #authorizeToolCall: AgentPluginMcpSessionManagerOptions["authorizeToolCall"];
  readonly #recordExternalContentIngestion: AgentPluginMcpSessionManagerOptions["recordExternalContentIngestion"];
  readonly #uuid: () => string;
  readonly #isUserAddedSource: AgentPluginMcpSessionManagerOptions["isUserAddedSource"];
  readonly #egressHostsForSource: AgentPluginMcpSessionManagerOptions["egressHostsForSource"];
  readonly #askEveryCallForSource: AgentPluginMcpSessionManagerOptions["askEveryCallForSource"];
  readonly #exclusiveForSource: AgentPluginMcpSessionManagerOptions["exclusiveForSource"];
  /** Packages whose one process is running or starting, by package and component. */
  readonly #exclusiveHolders = new Set<string>();
  readonly #resolveUserAddedSecrets: AgentPluginMcpSessionManagerOptions["resolveUserAddedSecrets"];
  readonly #bindUserAddedAuthentication: AgentPluginMcpSessionManagerOptions["bindUserAddedAuthentication"];
  readonly #sessions = new Map<string, AgentPluginMcpSessionRecord>();
  readonly #desired = new Map<string, AgentPluginMcpSessionTarget>();
  readonly #authenticationGenerations = new Map<string, number>();
  readonly #connections = new Map<
    string,
    {
      readonly target: AgentPluginMcpSessionTarget;
      readonly generation: number;
      readonly controller: AbortController;
      readonly promise: Promise<void>;
    }
  >();
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
      readonly at: string;
    }
  >();
  readonly #now: () => Date;
  /**
   * When each server last opened a session in any scope or version, keyed
   * by extension and component. Kept after an idle close so Settings can say
   * when it last worked; dropped with the component.
   */
  readonly #lastConnected = new Map<
    string,
    { readonly target: AgentPluginMcpSessionKey; readonly at: string }
  >();

  constructor(options: AgentPluginMcpSessionManagerOptions) {
    this.#store = options.store;
    this.#fetch = options.fetch;
    this.#connectionTimeoutMs = options.connectionTimeoutMs ?? 5_000;
    this.#toolCallTimeoutMs = boundedTimeout(options.toolCallTimeoutMs, 30_000, 60_000);
    this.#idleTimeoutMs = boundedTimeout(options.idleTimeoutMs, 5 * 60_000, 30 * 60_000);
    this.#stdioSupervisor = options.stdioSupervisor;
    this.#baseEnv = options.baseEnv ?? approvedAgentPluginMcpBaseEnvironment();
    this.#platform = options.platform ?? process.platform;
    this.#authorizeToolCall = options.authorizeToolCall;
    this.#recordExternalContentIngestion = options.recordExternalContentIngestion;
    this.#uuid = options.uuid ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#isUserAddedSource = options.isUserAddedSource;
    this.#egressHostsForSource = options.egressHostsForSource;
    this.#askEveryCallForSource = options.askEveryCallForSource;
    this.#exclusiveForSource = options.exclusiveForSource;
    this.#resolveUserAddedSecrets = options.resolveUserAddedSecrets;
    this.#bindUserAddedAuthentication = options.bindUserAddedAuthentication;
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

  /**
   * What the manager last saw of each server, across every authority scope:
   * an open session, a connect in flight, a failure, or when it last
   * connected. A read of memory only; it never connects or lists tools.
   */
  connectionObservations(): ReadonlyArray<McpConnectionObservation> {
    // One server can hold sessions and failures in several task scopes and
    // package versions; the row shows the newest fact. A connect in flight
    // wins, then the latest failure unless a session connected after it.
    type Facts = {
      readonly target: AgentPluginMcpSessionKey;
      connecting: boolean;
      connected: boolean;
      failure?: { readonly reason: string; readonly at: string };
    };
    const components = new Map<string, Facts>();
    const entry = (target: AgentPluginMcpSessionKey): Facts => {
      const key = authenticationKey(target);
      const known = components.get(key);
      if (known !== undefined) return known;
      const created: Facts = { target, connecting: false, connected: false };
      components.set(key, created);
      return created;
    };
    for (const { target } of this.#lastConnected.values()) entry(target);
    for (const { target, reason, at } of this.#failures.values()) {
      const known = entry(target);
      if (known.failure === undefined || known.failure.at < at) known.failure = { reason, at };
    }
    for (const { target } of this.#connections.values()) entry(target).connecting = true;
    for (const record of this.#sessions.values()) entry(record).connected = true;
    return [...components.entries()].map(([key, known]) => {
      const lastConnected = this.#lastConnected.get(key)?.at;
      const since = lastConnected === undefined ? {} : { at: lastConnected };
      if (known.connecting) return { ...pick(known.target), state: "connecting", ...since };
      if (
        known.failure !== undefined &&
        (!known.connected || lastConnected === undefined || known.failure.at >= lastConnected)
      )
        return {
          ...pick(known.target),
          state: "failed",
          reason: known.failure.reason,
          at: known.failure.at,
        };
      return { ...pick(known.target), state: known.connected ? "connected" : "idle", ...since };
    });
  }

  /**
   * A person's Reconnect: drop the server's sessions and failures in every
   * task scope so the next task's authority reconciliation connects fresh;
   * a task using it elsewhere connects again on its next turn. Nothing connects
   * from here and no failed call is replayed; connecting stays with the task
   * that has authority to use the server.
   */
  async reconnect(extensionId: string, componentId: string): Promise<void> {
    await this.invalidateAuthentication(extensionId, componentId);
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
        if (record === undefined || !this.#currentRecord(indexed.sessionKey, record)) {
          return { result: { error: "extension-tool-unavailable" }, isError: true };
        }
        if (
          String(record.scope.threadId) !== String(thread.id) ||
          String(record.scope.projectId ?? "") !== String(thread.projectId ?? "")
        ) {
          return { result: { error: "extension-tool-authority-mismatch" }, isError: true };
        }
        const tool = record.tools.find((candidate) => candidate.listed.name === indexed.toolName);
        if (tool === undefined) {
          return { result: { error: "extension-tool-unavailable" }, isError: true };
        }
        let args: unknown;
        try {
          args = inputJson.trim() === "" ? {} : JSON.parse(inputJson);
        } catch {
          return { result: { error: "extension-tool-input-invalid" }, isError: true };
        }
        if (!tool.validateInput(args)) {
          return { result: { error: "extension-tool-input-invalid" }, isError: true };
        }
        const definitionDigest = record.toolDefinitionDigests.get(indexed.toolName);
        const approved =
          this.#authorizeToolCall === undefined || definitionDigest === undefined
            ? false
            : await this.#authorizeToolCall({
                thread,
                ...(windowId === undefined ? {} : { windowId }),
                extensionId: record.extensionId,
                packageId: record.packageId,
                componentId: record.componentId,
                serverName: record.serverName,
                version: record.version,
                digest: record.digest,
                definitionDigest,
                reach: record.reach,
                ...(record.askEveryCall.includes(indexed.toolName) ? { askEveryCall: true } : {}),
                providerToolName: name,
                mcpToolName: indexed.toolName,
                inputJson,
                ...(signal === undefined ? {} : { signal }),
              }).catch(() => false);
        if (!approved) {
          return { result: { error: "extension-tool-approval-required" }, isError: true };
        }
        if (!this.#currentRecord(indexed.sessionKey, record))
          return { result: { error: "extension-tool-authentication-changed" }, isError: true };
        if (record.authentication !== undefined) {
          const authentication = await record.authentication
            .check()
            .catch(() => "unavailable" as const);
          if (!this.#currentRecord(indexed.sessionKey, record))
            return { result: { error: "extension-tool-authentication-changed" }, isError: true };
          if (authentication !== "unchanged") {
            await this.invalidateAuthentication(record.extensionId, record.componentId);
            return {
              result: {
                error:
                  authentication === "changed"
                    ? "Authentication changed. Refresh this task's extension tools before invoking the tool again; no tool call was sent."
                    : "Credentials are unavailable. Restore the credential broker, then refresh this task's extension tools; no tool call was sent.",
              },
              isError: true,
            };
          }
        }
        if (signal?.aborted)
          return {
            result: { error: "MCP tool call was cancelled before dispatch." },
            isError: true,
          };
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
          const result = await record.session.callTool(indexed.toolName, args, controller.signal);
          if (!this.#currentRecord(indexed.sessionKey, record))
            return {
              result: {
                error:
                  "Authentication changed while this tool call was in flight. Its outcome may have completed; check before trying again.",
              },
              isError: true,
            };
          if (!isProviderSafeToolResult(result)) {
            return {
              result: { error: "MCP tool result exceeded provider limits." },
              isError: true,
            };
          }
          return this.#taintToolResult(thread.id, result);
        } catch (error) {
          if (!this.#currentRecord(indexed.sessionKey, record))
            return {
              result: {
                error:
                  "Authentication changed while this tool call was in flight. Its outcome is uncertain; check before trying again.",
              },
              isError: true,
            };
          if (error instanceof McpHttpStatusError && error.status === 401) {
            const rejected = record.authentication?.rejected().catch(() => undefined);
            await this.invalidateAuthentication(record.extensionId, record.componentId);
            await rejected;
            return {
              result: {
                error:
                  "The server rejected authentication. Refresh this task's extension tools or reconnect before trying again. The failed tool call was not replayed.",
              },
              isError: true,
            };
          }
          if (error instanceof McpJsonRpcError) {
            return {
              ...this.#taintToolResult(thread.id, { error: error.serverMessage }),
              isError: true,
            };
          }
          if (controller.signal.aborted) {
            await this.#close(indexed.sessionKey, record);
            const desired = this.#desired.get(indexed.sessionKey);
            if (
              desired !== undefined &&
              record.authenticationGeneration === this.#authenticationGeneration(record) &&
              !this.#sessions.has(indexed.sessionKey)
            ) {
              this.#failures.set(indexed.sessionKey, {
                target: desired,
                reason: "MCP tool transport closed; authority reconciliation is required.",
                at: this.#now().toISOString(),
              });
            }
          }
          return {
            result: {
              error: timedOut ? "MCP tool call timed out." : "MCP tool call failed.",
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

  #taintToolResult(
    threadId: ExtensionToolThread["id"],
    result: unknown,
  ): {
    readonly result: unknown;
    readonly isError?: boolean;
    readonly outsideContent?: { readonly labels: ReadonlyArray<ShieldWatcherLabel> };
  } {
    const record = this.#recordExternalContentIngestion;
    if (record === undefined) {
      return { result: { error: "extension-tool-unavailable" }, isError: true };
    }
    let body: string;
    try {
      const serialized = JSON.stringify(result);
      if (typeof serialized !== "string") {
        return { result: { error: "extension-tool-unavailable" }, isError: true };
      }
      body = serialized;
    } catch {
      return { result: { error: "extension-tool-unavailable" }, isError: true };
    }
    const digest = createHash("sha256").update(body).digest("hex");
    const ingested = record({
      threadId,
      provenance: { origin: "tool-result", sourceLabel: "mcp-tool" },
      contentReference: `mcp-${digest}`,
      correlationId: this.#uuid(),
      authorized: true,
    });
    if (ingested.kind === "refused") {
      return { result: { error: "extension-tool-unavailable" }, isError: true };
    }
    // Octant Shield's Watcher reads what the server returned before the model does.
    const labels = watchOutsideContent(watchedTextOf(result));
    if (
      !recordShieldWatcherLabels({ record, threadId, uuid: () => this.#uuid(), labels, digest })
    ) {
      return { result: { error: "extension-tool-unavailable" }, isError: true };
    }
    const framed = frameExternalContentForModel({
      origin: "tool-result",
      sourceLabel: "mcp-tool",
      body,
      section: "tool-results",
    });
    if (!isProviderSafeToolResult(framed.text)) {
      return {
        result: { error: "MCP tool result exceeded provider limits." },
        isError: true,
      };
    }
    return { result: framed.text, outsideContent: { labels } };
  }

  async reconcile(effective: ExtensionEffectiveSnapshot): Promise<void> {
    const currentScope = authorityScopeKey(effective.scope);
    const desired = new Map<string, AgentPluginMcpSessionTarget>();
    for (const packageState of effective.packages) {
      for (const componentState of packageState.components) {
        if (componentState.effectiveState.kind !== "effective") continue;
        if (componentState.component.kind !== "mcp-server") continue;
        const sourceRef =
          "sourceRef" in packageState.source ? packageState.source.sourceRef : undefined;
        const egressHosts =
          sourceRef === undefined ? undefined : this.#egressHostsForSource?.(sourceRef);
        const askEveryCall =
          sourceRef === undefined ? undefined : this.#askEveryCallForSource?.(sourceRef);
        const key = {
          extensionId: packageState.extensionId,
          packageId: packageState.packageId,
          componentId: componentState.component.id,
          version: packageState.version,
          digest: packageState.digest,
          configurationEntryPoint: componentState.component.entryPoint ?? "mcp.json",
          scope: effective.scope,
          serverNameHint: componentState.component.displayName,
          userAdded:
            "sourceRef" in packageState.source &&
            this.#isUserAddedSource?.(packageState.source.sourceRef) === true,
          ...(egressHosts === undefined || egressHosts.length === 0 ? {} : { egressHosts }),
          ...(askEveryCall === undefined || askEveryCall.length === 0 ? {} : { askEveryCall }),
          ...(sourceRef !== undefined && this.#exclusiveForSource?.(sourceRef) === true
            ? { exclusive: true as const }
            : {}),
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
      const authenticationGeneration = this.#authenticationGeneration(target);
      const existing = this.#sessions.get(key);
      if (
        existing !== undefined &&
        existing.version === target.version &&
        existing.digest === target.digest &&
        existing.authenticationGeneration === authenticationGeneration
      ) {
        this.#failures.delete(key);
        continue;
      }
      if (existing !== undefined) await this.#close(key, existing);
      if (
        authenticationGeneration !== this.#authenticationGeneration(target) ||
        !this.#desired.has(key)
      )
        continue;
      try {
        await this.#connectOnce(target);
        if (authenticationGeneration !== this.#authenticationGeneration(target)) continue;
        this.#failures.delete(key);
      } catch (error) {
        if (
          authenticationGeneration !== this.#authenticationGeneration(target) ||
          !this.#desired.has(key)
        )
          continue;
        // Independent MCP server failure must not block siblings, but the
        // component must not remain advertised as effective/active.
        this.#failures.set(key, {
          target,
          reason: error instanceof Error ? error.message : "MCP connection failed.",
          at: this.#now().toISOString(),
        });
      }
    }
  }

  async invalidateAuthentication(extensionId: string, componentId: string): Promise<void> {
    const matches = (target: AgentPluginMcpSessionKey) =>
      target.extensionId === extensionId && target.componentId === componentId;
    const identity = { extensionId, componentId };
    this.#authenticationGenerations.set(
      authenticationKey(identity),
      this.#authenticationGeneration(identity) + 1,
    );
    for (const [key, connection] of this.#connections)
      if (matches(connection.target)) {
        connection.controller.abort();
        if (this.#connections.get(key) === connection) this.#connections.delete(key);
      }
    for (const [key, target] of this.#desired) if (matches(target)) this.#desired.delete(key);
    for (const [key, failure] of this.#failures)
      if (matches(failure.target)) this.#failures.delete(key);
    const closing: Promise<void>[] = [];
    for (const [key, record] of this.#sessions)
      if (matches(record)) closing.push(this.#close(key, record));
    await Promise.allSettled(closing);
  }

  #authenticationGeneration(
    target: Pick<AgentPluginMcpSessionKey, "extensionId" | "componentId">,
  ): number {
    return this.#authenticationGenerations.get(authenticationKey(target)) ?? 0;
  }

  #currentRecord(key: string, record: AgentPluginMcpSessionRecord): boolean {
    return (
      this.#sessions.get(key) === record &&
      this.#desired.has(key) &&
      record.authenticationGeneration === this.#authenticationGeneration(record)
    );
  }

  async drainAll(): Promise<void> {
    this.#desired.clear();
    this.#failures.clear();
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
    for (const connection of this.#connections.values()) connection.controller.abort();
    await Promise.allSettled(
      [...this.#connections.values()].map((connection) => connection.promise),
    );
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
    const installed = new Set(
      snapshot.packages.flatMap((packageState) =>
        packageState.components.map((componentState) =>
          authenticationKey({
            extensionId: packageState.extensionId,
            componentId: componentState.component.id,
          }),
        ),
      ),
    );
    for (const key of this.#lastConnected.keys()) {
      if (!installed.has(key)) this.#lastConnected.delete(key);
    }
  }

  async #connect(
    target: AgentPluginMcpSessionTarget,
    authenticationGeneration: number,
    controller: AbortController,
  ): Promise<void> {
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
    const selectedLaunch = selectMcpServer(
      plan.launches,
      target.serverNameHint,
      target.componentId,
    );
    if (selectedLaunch === undefined) {
      throw new Error(`MCP server for ${target.componentId} is unavailable.`);
    }
    const withSecrets =
      target.userAdded && this.#resolveUserAddedSecrets !== undefined
        ? await this.#resolveUserAddedSecrets(selectedLaunch, {
            extensionId: target.extensionId,
            componentId: target.componentId,
          })
        : selectedLaunch;
    if (
      controller.signal.aborted ||
      authenticationGeneration !== this.#authenticationGeneration(target)
    )
      return;
    const launch =
      withSecrets.transport === "stdio" && !isAbsolute(withSecrets.command)
        ? {
            ...withSecrets,
            command: await resolveApprovedExecutable(withSecrets.command, this.#baseEnv.PATH),
          }
        : withSecrets;
    if (
      controller.signal.aborted ||
      authenticationGeneration !== this.#authenticationGeneration(target)
    )
      return;
    const authentication =
      target.userAdded && launch.transport === "streamable-http"
        ? await this.#bindUserAddedAuthentication?.(launch, target)
        : undefined;
    if (
      controller.signal.aborted ||
      authenticationGeneration !== this.#authenticationGeneration(target)
    )
      return;
    const timeout = setTimeout(() => controller.abort(), this.#connectionTimeoutMs);
    timeout.unref?.();
    let session: AgentPluginMcpSession;
    let connectedSession: AgentPluginMcpSession | undefined;
    try {
      session = await connectAgentPluginMcpSession(launch, {
        signal: controller.signal,
        onTransportClosed: () =>
          this.#handleTransportClosed(
            sessionKey(target),
            target,
            authenticationGeneration,
            controller,
            connectedSession,
          ),
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        ...(launch.transport !== "stdio" || this.#stdioSupervisor === undefined
          ? {}
          : {
              stdioProcess: supervisedStdioProcessPort({
                supervisor: this.#stdioSupervisor,
                target,
                platform: this.#platform,
                ...(target.egressHosts === undefined ? {} : { egressHosts: target.egressHosts }),
                ...(target.exclusive === true
                  ? {
                      exclusive: {
                        acquire: () => {
                          const key = `${target.extensionId}:${target.packageId}:${target.componentId}`;
                          if (this.#exclusiveHolders.has(key)) return undefined;
                          this.#exclusiveHolders.add(key);
                          // Effective once: a late second release (exit, then stop)
                          // must not delete a later holder's entry.
                          let released = false;
                          return () => {
                            if (released) return;
                            released = true;
                            this.#exclusiveHolders.delete(key);
                          };
                        },
                      },
                    }
                  : {}),
              }),
            }),
      });
    } catch (error) {
      if (
        error instanceof McpHttpStatusError &&
        error.status === 401 &&
        authenticationGeneration === this.#authenticationGeneration(target)
      )
        await authentication?.rejected().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    connectedSession = session;
    const duplicateToolNames = duplicatedMcpToolNames(session.tools);
    const tools: PreparedMcpTool[] = [];
    for (const tool of session.tools) {
      if (duplicateToolNames.has(tool.name)) continue;
      const prepared = await prepareMcpTool(target, tool);
      if (prepared !== undefined) tools.push(prepared);
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
      tools,
      // A stdio server only ever starts through `supervisedStdioProcessPort`,
      // which denies it the network, or lets it reach only its catalog entry's
      // hosts through the host's proxy, and confines its writes to plugin data.
      reach:
        session.transport !== "stdio"
          ? "network"
          : target.egressHosts === undefined
            ? "confined-stdio"
            : "proxied-stdio",
      askEveryCall: target.askEveryCall ?? [],
      authenticationGeneration,
      ...(authentication === undefined ? {} : { authentication }),
      toolDefinitionDigests: new Map(
        tools.map((tool) => [tool.listed.name, extensionToolDefinitionDigest(tool.listed)]),
      ),
    };
    const key = sessionKey(target);
    if (
      controller.signal.aborted ||
      authenticationGeneration !== this.#authenticationGeneration(target) ||
      !this.#desired.has(key) ||
      this.#sessions.has(key)
    ) {
      await this.#closeTransport(session);
      if (
        controller.signal.aborted &&
        authenticationGeneration === this.#authenticationGeneration(target) &&
        this.#desired.has(key)
      )
        throw new Error("MCP connection closed before initialization completed.");
      return;
    }
    this.#sessions.set(key, record);
    this.#lastConnected.set(authenticationKey(target), {
      target,
      at: this.#now().toISOString(),
    });
    this.#touchIdle(key);
    this.#reindex();
  }

  #connectOnce(target: AgentPluginMcpSessionTarget): Promise<void> {
    const key = sessionKey(target);
    const generation = this.#authenticationGeneration(target);
    const existing = this.#connections.get(key);
    if (
      existing !== undefined &&
      existing.generation === generation &&
      !existing.controller.signal.aborted
    )
      return existing.promise;
    const controller = new AbortController();
    const pending = this.#connect(target, generation, controller).finally(() => {
      if (this.#connections.get(key)?.promise === pending) this.#connections.delete(key);
    });
    this.#connections.set(key, { target, generation, controller, promise: pending });
    return pending;
  }

  #handleTransportClosed(
    key: string,
    target: AgentPluginMcpSessionTarget,
    authenticationGeneration: number,
    controller: AbortController,
    session: AgentPluginMcpSession | undefined,
  ): void {
    if (authenticationGeneration !== this.#authenticationGeneration(target)) return;
    if (session === undefined) {
      if (this.#connections.get(key)?.controller !== controller) return;
      controller.abort();
    } else if (this.#sessions.get(key)?.session !== session) return;
    const idleTimer = this.#idleTimers.get(key);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    this.#idleTimers.delete(key);
    this.#sessions.delete(key);
    this.#reindex();
    this.#failures.set(key, {
      target,
      reason: "MCP transport closed; authority reconciliation is required.",
      at: this.#now().toISOString(),
    });
  }

  async #close(key: string, record: AgentPluginMcpSessionRecord): Promise<void> {
    // A late failed call from a retired transport must not remove its replacement.
    if (this.#sessions.get(key) === record) {
      const idleTimer = this.#idleTimers.get(key);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      this.#idleTimers.delete(key);
      this.#sessions.delete(key);
      this.#reindex();
    }
    await this.#closeTransport(record.session);
  }

  async #closeTransport(session: AgentPluginMcpSession): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve()
          .then(() => session.close())
          .catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 10_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
        this.#toolIndex.set(tool.providerDefinition.name, {
          sessionKey: key,
          toolName: tool.listed.name,
        });
      }
    }
  }

  #definitions(
    records: ReadonlyArray<AgentPluginMcpSessionRecord>,
  ): ReadonlyArray<ProviderToolDefinition> {
    return records.flatMap((record) => record.tools.map((tool) => tool.providerDefinition));
  }
}

function duplicatedMcpToolNames(tools: ReadonlyArray<McpToolDefinition>): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) duplicates.add(tool.name);
    else seen.add(tool.name);
  }
  return duplicates;
}

const MAX_MCP_SCHEMA_EVALUATION_NODES = 1_024;

/**
 * MCP schemas are server-controlled and Ajv evaluates them synchronously on
 * the control-plane event loop. Reject regex-bearing schemas, reference cycles,
 * and reference graphs that can expand into excessive synchronous work.
 */
function mcpInputSchemaIsUnsafeToValidate(schema: unknown): boolean {
  const visited = new Set<unknown>();
  const visit = (candidate: unknown): boolean => {
    if (Array.isArray(candidate)) return candidate.some(visit);
    if (candidate === null || typeof candidate !== "object") return false;
    if (visited.has(candidate)) return false;
    visited.add(candidate);
    const record = candidate as Readonly<Record<string, unknown>>;
    if (
      Object.prototype.hasOwnProperty.call(record, "pattern") ||
      Object.prototype.hasOwnProperty.call(record, "patternProperties")
    ) {
      return true;
    }
    if (
      Object.prototype.hasOwnProperty.call(record, "$async") ||
      Object.prototype.hasOwnProperty.call(record, "$dynamicRef") ||
      Object.prototype.hasOwnProperty.call(record, "$recursiveRef")
    ) {
      return true;
    }
    if (typeof record.$ref === "string") {
      const referenced = localJsonPointerTarget(schema, record.$ref);
      // Ajv can resolve more reference forms than this bounded inspector. Omit
      // those tools instead of compiling a schema whose safety is unknown.
      if (referenced === undefined || visit(referenced)) return true;
    }
    for (const keyword of [
      "additionalItems",
      "additionalProperties",
      "contains",
      "contentSchema",
      "else",
      "if",
      "items",
      "not",
      "propertyNames",
      "then",
      "unevaluatedItems",
      "unevaluatedProperties",
    ] as const) {
      if (visit(record[keyword])) return true;
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
      const nested = record[keyword];
      if (Array.isArray(nested) && nested.some(visit)) return true;
    }
    for (const keyword of [
      "$defs",
      "definitions",
      "dependencies",
      "dependentSchemas",
      "properties",
    ] as const) {
      const nested = record[keyword];
      if (
        nested !== null &&
        typeof nested === "object" &&
        !Array.isArray(nested) &&
        Object.values(nested).some(visit)
      ) {
        return true;
      }
    }
    return false;
  };
  return visit(schema) || mcpInputSchemaEvaluationIsUnsafe(schema);
}

/**
 * Bound the maximum schema graph Ajv may synchronously explore for one input
 * node. This deliberately expands repeated local references instead of
 * deduplicating them: two branches that point at the same schema are two units
 * of validation work. An active reference is a cycle whose work can grow with
 * attacker-controlled input depth, so it is never admitted.
 */
function mcpInputSchemaEvaluationIsUnsafe(schema: unknown): boolean {
  let remainingNodes = MAX_MCP_SCHEMA_EVALUATION_NODES;
  const active = new Set<unknown>();
  const visit = (candidate: unknown): boolean => {
    if (Array.isArray(candidate)) return candidate.some(visit);
    if (candidate === null || typeof candidate !== "object") return false;
    if (active.has(candidate) || --remainingNodes < 0) return true;
    active.add(candidate);
    try {
      const record = candidate as Readonly<Record<string, unknown>>;
      if (
        Object.prototype.hasOwnProperty.call(record, "$dynamicRef") ||
        Object.prototype.hasOwnProperty.call(record, "$recursiveRef")
      ) {
        return true;
      }
      if (typeof record.$ref === "string") {
        const referenced = localJsonPointerTarget(schema, record.$ref);
        if (referenced === undefined || visit(referenced)) return true;
      }
      for (const keyword of [
        "additionalItems",
        "additionalProperties",
        "contains",
        "contentSchema",
        "else",
        "if",
        "items",
        "not",
        "propertyNames",
        "then",
        "unevaluatedItems",
        "unevaluatedProperties",
      ] as const) {
        if (visit(record[keyword])) return true;
      }
      for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
        const nested = record[keyword];
        if (Array.isArray(nested) && nested.some(visit)) return true;
      }
      for (const keyword of ["dependencies", "dependentSchemas", "properties"] as const) {
        const nested = record[keyword];
        if (
          nested !== null &&
          typeof nested === "object" &&
          !Array.isArray(nested) &&
          Object.values(nested).some(visit)
        ) {
          return true;
        }
      }
      return false;
    } finally {
      active.delete(candidate);
    }
  };
  return visit(schema);
}

function localJsonPointerTarget(root: unknown, reference: string): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(2));
  } catch {
    return undefined;
  }
  let target = root;
  for (const encodedToken of pointer.split("/")) {
    if (target === null || typeof target !== "object") return undefined;
    const token = encodedToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.prototype.hasOwnProperty.call(target, token)) return undefined;
    target = (target as Readonly<Record<string, unknown>>)[token];
  }
  return target;
}

type McpInputSchemaDialect = "draft-07" | "2019-09" | "2020-12";

let ajvDraft7Module: Promise<typeof import("ajv")> | undefined;
let ajv2019Module: Promise<typeof import("ajv/dist/2019.js")> | undefined;
let ajv2020Module: Promise<typeof import("ajv/dist/2020.js")> | undefined;

function loadAjvDraft7() {
  return (ajvDraft7Module ??= import("ajv"));
}

function loadAjv2019() {
  return (ajv2019Module ??= import("ajv/dist/2019.js"));
}

function loadAjv2020() {
  return (ajv2020Module ??= import("ajv/dist/2020.js"));
}

function mcpInputSchemaDialect(
  schema: Readonly<Record<string, unknown>>,
): McpInputSchemaDialect | undefined {
  if (schema.$schema === undefined) return "2020-12";
  if (typeof schema.$schema !== "string") return undefined;
  const dialect = schema.$schema.endsWith("#") ? schema.$schema.slice(0, -1) : schema.$schema;
  if (dialect === "http://json-schema.org/draft-07/schema") return "draft-07";
  if (dialect === "https://json-schema.org/draft/2019-09/schema") return "2019-09";
  if (dialect === "https://json-schema.org/draft/2020-12/schema") return "2020-12";
  return undefined;
}

async function compileMcpInputSchema(
  schema: Readonly<Record<string, unknown>>,
): Promise<ValidateFunction<unknown> | undefined> {
  const dialect = mcpInputSchemaDialect(schema);
  if (dialect === undefined) return undefined;
  const options = {
    allErrors: false,
    strict: false,
    validateFormats: false,
    validateSchema: true,
  } as const;
  let validateInput: ValidateFunction<unknown>;
  if (dialect === "draft-07") {
    const { default: AjvDraft7 } = await loadAjvDraft7();
    validateInput = new AjvDraft7(options).compile<unknown>(schema as AnySchema);
  } else if (dialect === "2019-09") {
    const { default: Ajv2019 } = await loadAjv2019();
    validateInput = new Ajv2019(options).compile<unknown>(schema as AnySchema);
  } else {
    const { default: Ajv2020 } = await loadAjv2020();
    validateInput = new Ajv2020(options).compile<unknown>(schema as AnySchema);
  }
  return "$async" in validateInput ? undefined : validateInput;
}

async function prepareMcpTool(
  record: Pick<AgentPluginMcpSessionRecord, "extensionId" | "packageId" | "componentId" | "scope">,
  tool: McpToolDefinition,
): Promise<PreparedMcpTool | undefined> {
  try {
    if (
      tool.inputSchema === undefined ||
      typeof tool.inputSchema !== "object" ||
      tool.inputSchema === null ||
      Array.isArray(tool.inputSchema)
    ) {
      return undefined;
    }
    const providerDefinition = decodeProviderToolDefinition({
      name: toolQualifiedName(record, tool.name),
      ...boundedToolDescription(tool.description),
      inputSchema: tool.inputSchema,
    });
    if (mcpInputSchemaIsUnsafeToValidate(providerDefinition.inputSchema)) return undefined;
    const validateInput = await compileMcpInputSchema(providerDefinition.inputSchema);
    if (validateInput === undefined) return undefined;
    return { listed: tool, providerDefinition, validateInput };
  } catch {
    return undefined;
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

/**
 * The sandbox grants read access around the file it launches, not around the
 * interpreter a `#!` line hands it to, so a server declared as a script inside
 * the plugin exits right after it starts. It is refused before spawn instead,
 * with the fix. The same holds for a launcher found on the host path or at an
 * absolute path outside the plugin, such as `npx`, whose `env` interpreter lookup
 * the profile blocks before the server runs; on macOS that is refused too. A
 * command that cannot be opened is left to the normal start path.
 */
async function startsWithShebang(command: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(command, "r");
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    return bytesRead === 2 && buffer[0] === 0x23 && buffer[1] === 0x21;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function shebangCommandRefusal(serverName: string): string {
  return (
    `MCP server ${serverName} runs a script from the plugin that starts with a #! line, which the sandbox cannot run. ` +
    'Declare the interpreter as the command instead, for example "command": "node", ' +
    '"args": ["${PLUGIN_ROOT}/server.mjs"].'
  );
}

function launcherCommandRefusal(serverName: string, command: string): string {
  return (
    `MCP server ${serverName} starts ${basename(command)}, a launcher script that the sandbox cannot run, ` +
    "and it reads only the plugin's own folder. Put the server's package inside the plugin, for example " +
    '`npm install --prefix "${PLUGIN_ROOT}" <package>` when building it, then set "command" to "node" ' +
    'and "args" to ["${PLUGIN_ROOT}/node_modules/<package>/<entry>.js"].'
  );
}

/**
 * `uvx` and `uv tool run` / `uv run` are native binaries, not scripts: they
 * fail under the profile because they read `uv` beside them through a link it
 * does not allow. Matched by name, narrowly; every other binary starts as before.
 */
function isSandboxedPythonLauncher(command: string, args: ReadonlyArray<string>): boolean {
  const name = basename(command);
  return name === "uvx" || (name === "uv" && (args[0] === "tool" || args[0] === "run"));
}

function pythonLauncherRefusal(serverName: string, command: string): string {
  return (
    `MCP server ${serverName} starts ${basename(command)}, a launcher that the sandbox cannot run, ` +
    "and it reads only the plugin's own folder. Put the server's package inside the plugin, for example " +
    '`uv venv "${PLUGIN_ROOT}/.venv"` and `uv pip install --python "${PLUGIN_ROOT}/.venv/bin/python" <package>` ' +
    'when building it, then set "command" to "${PLUGIN_ROOT}/.venv/bin/python" and "args" to the package\'s script or ["-m", "<module>"].'
  );
}

function supervisedStdioProcessPort(input: {
  readonly supervisor: Pick<ExtensionSupervisor, "startInteractive">;
  readonly target: AgentPluginMcpSessionKey;
  readonly platform: NodeJS.Platform;
  readonly egressHosts?: ReadonlyArray<string>;
  /** Returns a release, or undefined when another process already holds the one slot. */
  readonly exclusive?: { readonly acquire: () => (() => void) | undefined };
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
      if (input.platform === "darwin" && isSandboxedPythonLauncher(launch.command, launch.args)) {
        throw new Error(pythonLauncherRefusal(launch.name, launch.command));
      }
      const insidePlugin = isContainedPath(pluginRoot, launch.command);
      if (
        (insidePlugin || input.platform === "darwin") &&
        (await startsWithShebang(launch.command))
      ) {
        throw new Error(
          insidePlugin
            ? shebangCommandRefusal(launch.name)
            : launcherCommandRefusal(launch.name, launch.command),
        );
      }
      const release = input.exclusive?.acquire();
      if (input.exclusive !== undefined && release === undefined) {
        throw new Error(
          "This connector keeps one login for the whole computer and is already running for another thread. It frees up when that thread's connection closes.",
        );
      }
      let proxy: Awaited<ReturnType<typeof startHostAllowListProxy>> | undefined;
      try {
        proxy =
          input.egressHosts === undefined
            ? undefined
            : await startHostAllowListProxy({ allowedHosts: input.egressHosts });
      } catch (error) {
        // No process started, so the one slot must not stay taken.
        release?.();
        throw error;
      }
      const proxyAddress =
        proxy === undefined ? undefined : `http://127.0.0.1:${String(proxy.port)}`;
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
          ...(proxyAddress === undefined
            ? {}
            : {
                HTTPS_PROXY: proxyAddress,
                https_proxy: proxyAddress,
                NODE_USE_ENV_PROXY: "1",
              }),
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
          ...(proxy === undefined ? {} : { allowLoopbackPorts: [proxy.port] }),
        },
      };
      let started: Awaited<ReturnType<typeof input.supervisor.startInteractive>>;
      try {
        started = await input.supervisor.startInteractive(runtime, signal);
      } catch (error) {
        await proxy?.stop();
        release?.();
        throw error;
      }
      if (started.process.stdin === undefined || started.process.stdout === undefined) {
        await started.process.stop().catch(() => undefined);
        await proxy?.stop();
        release?.();
        throw new Error("Supervised MCP process did not expose stdio.");
      }
      return {
        stdin: started.process.stdin,
        stdout: started.process.stdout,
        stop: async () => {
          try {
            await started.process.stop();
          } finally {
            await proxy?.stop();
            release?.();
          }
        },
        once: (_event, listener) =>
          started.process.once("exit", () => {
            void proxy?.stop();
            release?.();
            listener();
          }),
      };
    },
  };
}

/**
 * What a person approves when they remember a tool: its name, description,
 * and input schema exactly as the server listed them. A server that later
 * lists the same name with another description or schema is offering a
 * different tool, and the changed digest makes the next call ask again.
 */
export function extensionToolDefinitionDigest(tool: McpToolDefinition): string {
  const listed = canonicalJson({
    name: tool.name,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? null,
  });
  return `sha256:${createHash("sha256").update(listed).digest("hex")}`;
}

/** JSON with object keys in a fixed order, so equal listings hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sessionKey(target: AgentPluginMcpSessionKey): string {
  return `${authorityScopeKey(target.scope)}\u0000${target.extensionId}:${target.packageId}:${target.componentId}:${target.version}:${target.digest}`;
}

function toolQualifiedName(
  record: Pick<AgentPluginMcpSessionRecord, "extensionId" | "packageId" | "componentId" | "scope">,
  toolName: string,
): string {
  const identity = `${authorityScopeKey(record.scope)}:${record.extensionId}:${record.packageId}:${record.componentId}:${toolName}`;
  // Letters, digits, and underscores only: measured against codex-cli 0.159.2,
  // a dynamic tool named `ext_mcp-notes_…` never reached the model while the
  // same tool named `ext_mcp_notes_…` did, because Codex exposes tools to its
  // code mode as identifiers and drops a name that cannot be one.
  const readable = trimUnderscores(
    `${record.componentId}_${toolName}`.replace(/[^A-Za-z0-9_]+/g, "_"),
  ).slice(0, 42);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `ext_${readable || "tool"}_${digest}`;
}

// `/^_+|_+$/` is quadratic on a long run of underscores.
function trimUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charAt(start) === "_") start += 1;
  while (end > start && value.charAt(end - 1) === "_") end -= 1;
  return value.slice(start, end);
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

/**
 * The entry of a shared mcp.json a component runs: the one its display name
 * names, else the one whose name the component id was derived from.
 */
export function selectMcpServer<T extends { readonly name: string }>(
  servers: ReadonlyArray<T>,
  displayName: string,
  componentId: string,
): T | undefined {
  return (
    servers.find((candidate) => candidate.name === displayName) ??
    servers.find((candidate) => `mcp-${tokenize(candidate.name)}` === componentId)
  );
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

function authenticationKey(target: {
  readonly extensionId: string;
  readonly componentId: string;
}): string {
  return `${target.extensionId}\u0000${target.componentId}`;
}
