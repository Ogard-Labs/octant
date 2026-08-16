import {
  decodeShellBootstrap,
  decodeShellCommandResult,
  decodeShellFailure,
  type ShellBootstrap,
  type ShellCommand,
  type ShellCommandResult,
  type ShellFailure,
  type WindowId,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ShellClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}

export interface ShellClient {
  bootstrap(windowId: WindowId): Promise<ShellBootstrap>;
  execute(command: ShellCommand): Promise<ShellCommandResult>;
}

export class ShellClientFailure extends Error {
  readonly category: ShellFailure["category"];
  readonly expectedVersion?: Extract<
    ShellFailure,
    { readonly category: "conflict" }
  >["expectedVersion"];
  readonly actualVersion?: Extract<
    ShellFailure,
    { readonly category: "conflict" }
  >["actualVersion"];

  constructor(failure: ShellFailure) {
    super(failure.message);
    this.name = "ShellClientFailure";
    this.category = failure.category;
    if (failure.category === "conflict") {
      this.expectedVersion = failure.expectedVersion;
      this.actualVersion = failure.actualVersion;
    }
  }
}

export function createShellClient(options: ShellClientOptions): ShellClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    bootstrap(windowId) {
      const url = new URL("/api/shell/bootstrap", options.baseUrl);
      url.searchParams.set("windowId", windowId);
      return request(fetch, url.toString(), { method: "GET" }, decodeShellBootstrap);
    },
    execute(command) {
      const url = new URL("/api/shell/commands", options.baseUrl);
      return request(
        fetch,
        url.toString(),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        decodeShellCommandResult,
      );
    },
  };
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decodeSuccess: (input: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw transportFailure(error);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidResponse();
  }

  if (!response.ok) {
    let failure: ShellFailure;
    try {
      failure = decodeShellFailure(body);
    } catch {
      throw invalidResponse();
    }
    throw new ShellClientFailure(failure);
  }

  try {
    return decodeSuccess(body);
  } catch {
    throw invalidResponse();
  }
}

function transportFailure(error: unknown): ShellClientFailure {
  return new ShellClientFailure(
    isAbortError(error)
      ? { category: "unavailable", message: "Shell request was aborted." }
      : { category: "unavailable", message: "Octant shell service is unavailable." },
  );
}

function invalidResponse(): ShellClientFailure {
  return new ShellClientFailure({
    category: "unavailable",
    message: "Shell service returned an invalid response.",
  });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
