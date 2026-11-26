import type {
  DiscoveredAgentToolingListing,
  DiscoveredAgentToolingRequest,
  ExtensionCommand,
  ExtensionCommandResult,
  ExtensionEffectiveSnapshot,
  ExtensionEffectiveStateQuery,
  ExtensionProjectPinListing,
  ExtensionProjectPinRequest,
  ExtensionSnapshot,
  ExtensionToolApprovalDecision,
  ExtensionToolApprovalList,
  ExtensionToolGrantList,
  ExtensionToolGrantRequest,
  McpServerConnectionListing,
  McpServerConnectionRequest,
  McpServerReconnectResult,
  McpServerSignInRelayRequest,
  McpServerSignInRelayResult,
  McpServerSignInRequest,
  McpServerSignInView,
  RuntimeCompactionDefaults,
  UserAddedMcpServerRequest,
} from "@octant/contracts/extension-rpc";
import { decodeHostAnswer } from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

import type { RemoteSessionStanding } from "./remoteSurfaceMatrix";

const loadExtensionRpc = () => import("@octant/contracts/extension-rpc");

export interface ExtensionClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
  /**
   * Set by a client carried over a paired device's session, with what the
   * host said of that session. The base URL then only shapes the path, so the
   * host's word decides what the URL would otherwise decide.
   */
  readonly session?: RemoteSessionStanding;
}

export interface ExtensionClient {
  /** Local person only: resolves a one-use native skill-purpose receipt, granting no enablement. */
  resolveSkillFolder?(receiptId: string, signal?: AbortSignal): Promise<string>;
  snapshot(): Promise<ExtensionSnapshot>;
  effectiveState(query: ExtensionEffectiveStateQuery): Promise<ExtensionEffectiveSnapshot>;
  execute(command: ExtensionCommand, signal?: AbortSignal): Promise<ExtensionCommandResult>;
  listToolApprovals(signal?: AbortSignal): Promise<ExtensionToolApprovalList>;
  decideToolApproval(decision: ExtensionToolApprovalDecision): Promise<boolean>;
  /**
   * Whether this client may remember an approval or list and revoke remembered
   * ones. True for a local window and for a session that acts as the host's
   * own person; the host refuses every other device, so the client does not
   * offer it there.
   */
  readonly toolGrantsAvailable: boolean;
  /** The MCP tools a person always allows, per Project. A local window only. */
  listToolGrants(signal?: AbortSignal): Promise<ExtensionToolGrantList>;
  /** Takes one remembered approval away; false when it was already gone. */
  revokeToolGrant(grantId: string): Promise<boolean>;
  /** Consume one native-picker receipt to register and inspect an Agent Plugins directory. */
  importLocalPluginReceipt(receiptId: string): Promise<ExtensionCommandResult>;
  /** Adds an MCP server by hand; the host installs, trusts and enables its package. */
  addUserMcpServer(request: UserAddedMcpServerRequest): Promise<ExtensionCommandResult>;
  /** What other agent tools on this computer know: servers and plugins the person may add. */
  listDiscoveredTooling(): Promise<DiscoveredAgentToolingListing>;
  /** Adds a found server, or imports a found plugin for preview, by its listed id. */
  applyDiscoveredTooling(
    request: Exclude<
      DiscoveredAgentToolingRequest,
      { readonly kind: "list" } | { readonly kind: "compaction-defaults" }
    >,
  ): Promise<ExtensionCommandResult>;
  /** What the person's own Claude Code and Codex files say about compacting; read, never written. */
  runtimeCompactionDefaults(): Promise<RuntimeCompactionDefaults>;
  /** Sign-in state and actions for a hosted server a person added. */
  mcpServerSignIn(request: McpServerSignInRequest): Promise<McpServerSignInView>;
  /** Finishes a relayable paired-device sign-in attempt by sending its callback address once. */
  relayMcpServerSignIn?(request: McpServerSignInRelayRequest): Promise<McpServerSignInRelayResult>;
  /** How each installed MCP server is connecting, from what the host retained. */
  mcpServerConnections(): Promise<McpServerConnectionListing>;
  /**
   * The servers a thread's next turn would get and cannot use until someone
   * signs in. Asked only by a client that may sign in; the host refuses others.
   */
  mcpServersAwaitingSignIn?(
    thread: Omit<Extract<McpServerConnectionRequest, { readonly kind: "thread-sign-in" }>, "kind">,
    signal?: AbortSignal,
  ): Promise<McpServerConnectionListing>;
  /** Drops a server's connection and failure so the next task connects fresh; a local window only. */
  reconnectMcpServer(target: {
    readonly extensionId: string;
    readonly componentId: string;
  }): Promise<McpServerReconnectResult>;
  /** The plugins pinned to Projects; `set` changes one pin and answers with the whole list. */
  projectPins(request: ExtensionProjectPinRequest): Promise<ExtensionProjectPinListing>;
}

export class ExtensionClientFailure extends Error {
  readonly category: "invalid" | "unauthorized" | "blocked" | "unavailable" | "protocol";

  constructor(category: ExtensionClientFailure["category"], message: string) {
    super(message);
    this.name = "ExtensionClientFailure";
    this.category = category;
  }
}

export function createExtensionClient(options: ExtensionClientOptions): ExtensionClient {
  const fetch = bindFetchPort(options.fetch);
  const headers = { "x-octant-window-capability": options.windowCapability };
  const toolGrantsAvailable =
    options.session === undefined
      ? isLoopbackHttp(options.baseUrl)
      : options.session.actsAsHostPerson;
  return {
    toolGrantsAvailable,
    async resolveSkillFolder(receiptId, signal) {
      if (!toolGrantsAvailable || !/^[A-Za-z0-9_-]{43}$/.test(receiptId)) {
        throw new ExtensionClientFailure(
          "invalid",
          "Choose a skill folder in the local desktop window.",
        );
      }
      const { SkillFolderSelection } = await loadExtensionRpc();
      const result = await request(
        fetch,
        new URL("/api/extensions/skill-folder-selection", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ receiptId }),
          ...(signal === undefined ? {} : { signal }),
        },
        decodeHostAnswer(SkillFolderSelection),
      );
      return result.folderPath;
    },
    async snapshot() {
      const { ExtensionSnapshot } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/snapshot", options.baseUrl).toString(),
        { method: "POST", headers },
        decodeHostAnswer(ExtensionSnapshot),
      );
    },
    async effectiveState(query) {
      const { decodeExtensionEffectiveStateQuery, ExtensionCommandResult } =
        await loadExtensionRpc();
      let validated: ExtensionEffectiveStateQuery;
      try {
        validated = decodeExtensionEffectiveStateQuery(query);
      } catch {
        throw new ExtensionClientFailure("invalid", "Extension state query is invalid.");
      }
      const result = await request(
        fetch,
        new URL("/api/extensions/state", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            kind: "query-effective-state",
            commandVersion: 1,
            ...validated,
          }),
        },
        decodeHostAnswer(ExtensionCommandResult),
      );
      if (result.kind !== "extension-effective-state") {
        throw new ExtensionClientFailure(
          "protocol",
          "Extension service returned an invalid response.",
        );
      }
      return result.snapshot;
    },
    async execute(command, signal) {
      const { decodeExtensionCommand, ExtensionCommandResult } = await loadExtensionRpc();
      let validated: ExtensionCommand;
      try {
        validated = decodeExtensionCommand(command);
      } catch {
        throw new ExtensionClientFailure("invalid", "Extension command is invalid.");
      }
      return request(
        fetch,
        new URL(routeFor(validated), options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
          ...(signal === undefined ? {} : { signal }),
        },
        decodeHostAnswer(ExtensionCommandResult),
      );
    },
    async listToolApprovals(signal) {
      const { ExtensionToolApprovalList } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/tool-approvals", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "list" }),
          ...(signal === undefined ? {} : { signal }),
        },
        decodeHostAnswer(ExtensionToolApprovalList),
      );
    },
    async decideToolApproval(decision) {
      const { decodeExtensionToolApprovalDecision } = await loadExtensionRpc();
      let validated: ExtensionToolApprovalDecision;
      try {
        validated = decodeExtensionToolApprovalDecision(decision);
      } catch {
        throw new ExtensionClientFailure("invalid", "Extension approval decision is invalid.");
      }
      return request(
        fetch,
        new URL("/api/extensions/tool-approvals", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "decide", ...validated }),
        },
        (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            Object.keys(value).length !== 1 ||
            (value as { accepted?: unknown }).accepted !== true
          ) {
            throw new Error("invalid");
          }
          return true;
        },
      );
    },
    async listToolGrants(signal) {
      if (!toolGrantsAvailable) throw notOnThisHost();
      const { ExtensionToolGrantList } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/tool-grants", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "list" }),
          ...(signal === undefined ? {} : { signal }),
        },
        decodeHostAnswer(ExtensionToolGrantList),
      );
    },
    async revokeToolGrant(grantId) {
      if (!toolGrantsAvailable) throw notOnThisHost();
      const { decodeExtensionToolGrantRequest } = await loadExtensionRpc();
      let validated: ExtensionToolGrantRequest;
      try {
        validated = decodeExtensionToolGrantRequest({ kind: "revoke", grantId });
      } catch {
        throw new ExtensionClientFailure("invalid", "Remembered tool approval is invalid.");
      }
      return request(
        fetch,
        new URL("/api/extensions/tool-grants", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            Object.keys(value).length !== 1 ||
            !("revoked" in value) ||
            typeof value.revoked !== "boolean"
          ) {
            throw new Error("invalid");
          }
          return value.revoked;
        },
      );
    },
    async projectPins(pin) {
      const { ExtensionProjectPinListing } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/project-pins", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(pin),
        },
        decodeHostAnswer(ExtensionProjectPinListing),
      );
    },
    async mcpServerConnections() {
      const { McpServerConnectionListing } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/connections", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "list" }),
        },
        decodeHostAnswer(McpServerConnectionListing),
      );
    },
    async mcpServersAwaitingSignIn(thread, signal) {
      const { McpServerConnectionListing } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/connections", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "thread-sign-in", ...thread }),
          ...(signal === undefined ? {} : { signal }),
        },
        decodeHostAnswer(McpServerConnectionListing),
      );
    },
    async reconnectMcpServer(target) {
      const { McpServerReconnectResult } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/connections", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "reconnect", ...target }),
        },
        decodeHostAnswer(McpServerReconnectResult),
      );
    },
    async mcpServerSignIn(signIn) {
      const { McpServerSignInView } = await loadExtensionRpc();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          request(
            fetch,
            new URL("/api/extensions/sign-in", options.baseUrl).toString(),
            {
              method: "POST",
              signal: controller.signal,
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify(signIn),
            },
            decodeHostAnswer(McpServerSignInView),
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(
                new ExtensionClientFailure(
                  "unavailable",
                  "Sign-in response was not confirmed. Check the existing attempt before trying again.",
                ),
              );
            }, 30_000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async relayMcpServerSignIn(relay) {
      const { McpServerSignInRelayResult } = await loadExtensionRpc();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          request(
            fetch,
            new URL("/api/extensions/mcp-sign-in/relay", options.baseUrl).toString(),
            {
              method: "POST",
              signal: controller.signal,
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify(relay),
            },
            decodeHostAnswer(McpServerSignInRelayResult),
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(
                new ExtensionClientFailure(
                  "unavailable",
                  "Sign-in relay response was not confirmed. Check the existing attempt before trying again.",
                ),
              );
            }, 30_000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async listDiscoveredTooling() {
      const { DiscoveredAgentToolingListing } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/discovered", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "list" }),
        },
        decodeHostAnswer(DiscoveredAgentToolingListing),
      );
    },
    async runtimeCompactionDefaults() {
      const { RuntimeCompactionDefaults } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/discovered", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "compaction-defaults" }),
        },
        decodeHostAnswer(RuntimeCompactionDefaults),
      );
    },
    async applyDiscoveredTooling(discovered) {
      const { ExtensionCommandResult } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/discovered", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(discovered),
        },
        decodeHostAnswer(ExtensionCommandResult),
      );
    },
    async addUserMcpServer(server) {
      const { ExtensionCommandResult } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/user-servers", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(server),
        },
        decodeHostAnswer(ExtensionCommandResult),
      );
    },
    async importLocalPluginReceipt(receiptId) {
      if (typeof receiptId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(receiptId)) {
        throw new ExtensionClientFailure("invalid", "Local plugin receipt is required.");
      }
      const { ExtensionCommandResult } = await loadExtensionRpc();
      return request(
        fetch,
        new URL("/api/extensions/import-local", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ receiptId }),
        },
        decodeHostAnswer(ExtensionCommandResult),
      );
    },
  };
}

function isLoopbackHttp(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function notOnThisHost(): ExtensionClientFailure {
  return new ExtensionClientFailure(
    "unavailable",
    "Remembered tool approvals are managed at a window on the host.",
  );
}

function routeFor(command: ExtensionCommand): string {
  switch (command.kind) {
    case "search-catalog":
      return "/api/extensions/catalog";
    case "preview-package":
      return "/api/extensions/preview";
    case "inspect-package":
      return "/api/extensions/inspect";
    case "query-effective-state":
      return "/api/extensions/state";
    case "resolve-npm-package":
    case "check-npm-update":
      return "/api/extensions/npm";
    case "search-skills":
    case "preview-skill":
    case "install-skill":
    case "update-skill":
    case "remove-skill":
    case "reconcile-skills":
      return "/api/extensions/skills";
    default:
      return "/api/extensions/lifecycle";
  }
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ExtensionClientFailure("unavailable", "Extension service is unavailable.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ExtensionClientFailure("protocol", "Extension service returned an invalid response.");
  }
  if (!response.ok) {
    throw new ExtensionClientFailure(
      response.status === 401 ? "unauthorized" : response.status >= 500 ? "unavailable" : "invalid",
      "Extension request failed.",
    );
  }
  try {
    return decode(body);
  } catch {
    throw new ExtensionClientFailure("protocol", "Extension service returned an invalid response.");
  }
}
