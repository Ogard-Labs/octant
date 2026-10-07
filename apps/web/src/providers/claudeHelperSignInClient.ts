import type { ClaudeHelperCommand, ClaudeHelperView } from "./ClaudeHelperSignIn";

const VIEW_KINDS = new Set(["not-connected", "connecting", "connected", "expired", "refused"]);

/** Reads only the public view; anything else in the response is dropped. */
export async function runClaudeHelperCommand(options: {
  readonly baseUrl: string;
  readonly windowCapability: string;
  readonly fetch?: typeof fetch;
  readonly command: ClaudeHelperCommand;
}): Promise<ClaudeHelperView | undefined> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(new URL("/api/providers/claude-helpers", options.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": options.windowCapability,
    },
    body: JSON.stringify(options.command),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.kind !== "string" || !VIEW_KINDS.has(record.kind)) return undefined;
  if (record.kind === "refused") {
    return {
      kind: "refused",
      reason: typeof record.reason === "string" ? record.reason : "Octant refused the request.",
    };
  }
  return { kind: record.kind as Exclude<ClaudeHelperView["kind"], "refused"> };
}
