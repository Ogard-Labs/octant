import {
  decodeCommandCredentialCommand,
  decodeCommandCredentialResult,
  type CommandCredentialCommand,
  type CommandCredentialResult,
} from "@octant/contracts/command-credentials";
import { bindFetchPort } from "./bindFetchPort";
export interface CommandCredentialsClient {
  readonly read: (
    projectId?: string,
    signal?: AbortSignal,
    threadId?: string,
  ) => Promise<CommandCredentialResult>;
  readonly execute: (command: CommandCredentialCommand) => Promise<CommandCredentialResult>;
}
export function createCommandCredentialsClient(options: {
  readonly baseUrl: string;
  readonly windowCapability: string;
  readonly fetch: typeof globalThis.fetch;
}): CommandCredentialsClient {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password
  )
    throw Error("Credential commands require a local host.");
  const port = bindFetchPort(options.fetch);
  const endpoint = new URL("/api/secret-stores/command-bindings", base);
  const send = async (url: URL, init: RequestInit) => {
    const response = await port(url.toString(), {
      ...init,
      cache: "no-store",
      redirect: "error",
      headers: {
        "x-octant-window-capability": options.windowCapability,
        ...(init.method === "POST" ? { "content-type": "application/json" } : {}),
      },
    });
    if (!response.ok) throw Error("Credential commands are unavailable.");
    return decodeCommandCredentialResult(await response.json());
  };
  return {
    read: async (projectId, signal, threadId) => {
      const url = new URL(endpoint);
      if (projectId !== undefined) url.searchParams.set("projectId", projectId);
      if (threadId !== undefined) url.searchParams.set("threadId", threadId);
      return send(url, { method: "GET", ...(signal === undefined ? {} : { signal }) });
    },
    execute: async (input) => {
      const command = decodeCommandCredentialCommand(input);
      return send(endpoint, { method: "POST", body: JSON.stringify(command) });
    },
  };
}
