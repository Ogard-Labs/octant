import {
  decodeSandboxRestrictionsResult,
  decodeSandboxRestrictionsSnapshot,
  type SandboxRestrictionsCommand,
  type SandboxRestrictionsResult,
  type SandboxRestrictionsScope,
  type SandboxRestrictionsSnapshot,
} from "@octant/contracts/sandbox-policy";
import { bindFetchPort } from "./bindFetchPort";
export interface SandboxRestrictionsClient {
  settings(
    scope: SandboxRestrictionsScope,
    signal?: AbortSignal,
  ): Promise<SandboxRestrictionsSnapshot>;
  change(
    command: SandboxRestrictionsCommand,
    signal?: AbortSignal,
  ): Promise<SandboxRestrictionsResult>;
}
function scopeKey(scope: SandboxRestrictionsScope): string {
  return scope.kind === "settings"
    ? `settings:${scope.mode}`
    : scope.kind === "project"
      ? `project:${scope.projectId}`
      : `session:${scope.threadId}`;
}

export function createSandboxRestrictionsClient(options: {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}): SandboxRestrictionsClient {
  const fetch = bindFetchPort(options.fetch);
  const send = async (url: URL, init: RequestInit): Promise<unknown> => {
    const response = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
    });
    const body: unknown = await response.json();
    if (
      !response.ok &&
      !(
        typeof body === "object" &&
        body !== null &&
        "kind" in body &&
        body.kind === "sandbox-restrictions-refused"
      )
    )
      throw new Error("Sandbox settings could not be read from this host.");
    return body;
  };
  return {
    settings: async (scope, signal) => {
      const url = new URL("/api/sandbox-restrictions", options.baseUrl);
      if (scope.kind === "project") url.searchParams.set("projectId", scope.projectId);
      else if (scope.kind === "session") url.searchParams.set("threadId", scope.threadId);
      else url.searchParams.set("mode", scope.mode);
      const value = decodeSandboxRestrictionsSnapshot(
        await send(url, { method: "GET", ...(signal === undefined ? {} : { signal }) }),
      );
      if (scopeKey(value.scope) !== scopeKey(scope))
        throw new Error("The host returned sandbox settings for a different scope.");
      return value;
    },
    change: async (command, signal) =>
      decodeSandboxRestrictionsResult(
        await send(new URL("/api/sandbox-restrictions/commands", options.baseUrl), {
          method: "POST",
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        }),
      ),
  };
}
