import {
  decodeThreadSecretCommandResult,
  decodeThreadSecretsHostView,
  decodeThreadSecretsView,
  type ThreadSecretCommand,
  type ThreadSecretCommandResult,
  type ThreadSecretsHostView,
  type ThreadSecretsView,
} from "@octant/contracts/thread-secrets";
import {
  decodeSecretStoreBrowseResult,
  type SecretStoreBrowseResult,
} from "@octant/contracts/secret-stores";
import { bindFetchPort } from "./bindFetchPort";

/** The host's answer, or that it refused the request with nothing read from it. */
export type ThreadSecretReply = ThreadSecretCommandResult | { readonly status: "not-taken" };

/** Every command but a listing, which answers with names instead. */
export type ThreadSecretAction = Exclude<ThreadSecretCommand, { readonly kind: "browse" }>;

export interface ThreadSecretsClient {
  /** One thread's waiting cards for this window, and its active secrets. */
  readonly read: (threadId: string, signal?: AbortSignal) => Promise<ThreadSecretsView>;
  /** Every active and remembered secret on this host. */
  readonly readHost: (signal?: AbortSignal) => Promise<ThreadSecretsHostView>;
  /** Names in the linked store, for a card that is waiting. */
  readonly browse: (
    request: Omit<Extract<ThreadSecretCommand, { readonly kind: "browse" }>, "kind">,
    signal?: AbortSignal,
  ) => Promise<SecretStoreBrowseResult>;
  /** Throws where the outcome is not known. */
  readonly execute: (command: ThreadSecretAction) => Promise<ThreadSecretReply>;
}

/** Only this computer's own host: a secret is sent nowhere else. */
export function createThreadSecretsClient(options: {
  readonly baseUrl: string;
  readonly windowCapability: string;
  readonly fetch: typeof globalThis.fetch;
}): ThreadSecretsClient {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password
  )
    throw Error("Thread secrets require a local host.");
  const port = bindFetchPort(options.fetch);
  const endpoint = new URL("/api/thread-secrets", base);
  const send = (url: URL, init: RequestInit) =>
    port(url.toString(), {
      ...init,
      cache: "no-store",
      redirect: "error",
      headers: {
        "x-octant-window-capability": options.windowCapability,
        ...(init.method === "POST" ? { "content-type": "application/json" } : {}),
      },
    });
  const read = async (url: URL, signal: AbortSignal | undefined): Promise<unknown> => {
    const response = await send(url, {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw Error("Thread secrets are unavailable.");
    return response.json();
  };
  return {
    read: async (threadId, signal) => {
      const url = new URL(endpoint);
      url.searchParams.set("threadId", threadId);
      return decodeThreadSecretsView(await read(url, signal));
    },
    readHost: async (signal) => decodeThreadSecretsHostView(await read(endpoint, signal)),
    browse: async (request, signal) => {
      const response = await send(endpoint, {
        method: "POST",
        body: JSON.stringify({ kind: "browse", ...request }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw Error("The linked store could not be listed.");
      return decodeSecretStoreBrowseResult(await response.json());
    },
    execute: async (command) => {
      const response = await send(endpoint, { method: "POST", body: JSON.stringify(command) });
      // The host refuses a request before it reads an answer from it.
      if (response.status >= 400 && response.status < 500) return { status: "not-taken" };
      if (!response.ok) throw Error("The host did not take the answer.");
      return decodeThreadSecretCommandResult(await response.json());
    },
  };
}
