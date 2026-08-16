import {
  decodeExtensionCommand,
  decodeExtensionCommandResult,
  decodeExtensionEffectiveStateQuery,
  decodeExtensionSnapshot,
  decodeExtensionToolApprovalDecision,
  decodeExtensionToolApprovalList,
  type ExtensionCommand,
  type ExtensionCommandResult,
  type ExtensionEffectiveSnapshot,
  type ExtensionEffectiveStateQuery,
  type ExtensionSnapshot,
  type ExtensionToolApprovalDecision,
  type ExtensionToolApprovalList,
} from "@octant/contracts/extension-rpc";
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
  /** Consume one native-picker receipt to register and inspect an Agent Plugins directory. */
  importLocalPluginReceipt(receiptId: string): Promise<ExtensionCommandResult>;
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
  return {
    snapshot() {
      return request(
        fetch,
        new URL("/api/extensions/snapshot", options.baseUrl).toString(),
        { method: "POST", headers },
        decodeExtensionSnapshot,
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
        decodeExtensionCommandResult,
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
        decodeExtensionCommandResult,
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
        decodeExtensionToolApprovalList,
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
        decodeExtensionCommandResult,
      );
    },
  };
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
