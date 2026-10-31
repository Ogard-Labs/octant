import {
  decodeExtensionCommand,
  decodeExtensionEffectiveStateQuery,
  decodeExtensionToolApprovalDecision,
  decodeExtensionToolGrantRequest,
  type ExtensionCommand,
  ExtensionCommandResult,
  type ExtensionEffectiveSnapshot,
  type ExtensionEffectiveStateQuery,
  ExtensionSnapshot,
  type ExtensionToolApprovalDecision,
  ExtensionToolApprovalList,
  ExtensionToolGrantList,
  type ExtensionToolGrantRequest,
  type UserAddedMcpServerRequest,
  DiscoveredAgentToolingListing,
  type DiscoveredAgentToolingRequest,
  McpServerSignInView,
  type McpServerSignInRequest,
  ExtensionProjectPinListing,
  type ExtensionProjectPinRequest,
} from "@octant/contracts/extension-rpc";
import { decodeHostAnswer } from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ExtensionClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ExtensionClient {
  snapshot(): Promise<ExtensionSnapshot>;
  effectiveState(query: ExtensionEffectiveStateQuery): Promise<ExtensionEffectiveSnapshot>;
  execute(command: ExtensionCommand, signal?: AbortSignal): Promise<ExtensionCommandResult>;
  listToolApprovals(signal?: AbortSignal): Promise<ExtensionToolApprovalList>;
  decideToolApproval(decision: ExtensionToolApprovalDecision): Promise<boolean>;
  /**
   * Whether this client may remember an approval or list and revoke remembered
   * ones. True for a local window; the host refuses a paired device, so the
   * client does not offer it off a loopback host.
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
    request: Exclude<DiscoveredAgentToolingRequest, { readonly kind: "list" }>,
  ): Promise<ExtensionCommandResult>;
  /** Sign-in state and actions for a hosted server a person added. */
  mcpServerSignIn(request: McpServerSignInRequest): Promise<McpServerSignInView>;
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
  const toolGrantsAvailable = isLoopbackHttp(options.baseUrl);
  return {
    toolGrantsAvailable,
    snapshot() {
      return request(
        fetch,
        new URL("/api/extensions/snapshot", options.baseUrl).toString(),
        { method: "POST", headers },
        decodeHostAnswer(ExtensionSnapshot),
      );
    },
    async effectiveState(query) {
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
    execute(command, signal) {
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
    listToolApprovals(signal) {
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
    listToolGrants(signal) {
      if (!toolGrantsAvailable) return Promise.reject(notOnThisHost());
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
    projectPins(pin) {
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
    mcpServerSignIn(signIn) {
      return request(
        fetch,
        new URL("/api/extensions/sign-in", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(signIn),
        },
        decodeHostAnswer(McpServerSignInView),
      );
    },
    listDiscoveredTooling() {
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
    applyDiscoveredTooling(discovered) {
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
    addUserMcpServer(server) {
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
    importLocalPluginReceipt(receiptId) {
      if (typeof receiptId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(receiptId)) {
        return Promise.reject(
          new ExtensionClientFailure("invalid", "Local plugin receipt is required."),
        );
      }
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
