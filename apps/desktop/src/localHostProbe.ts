export interface LocalHostProbe {
  readonly url: string;
  readonly instanceId: string;
  readonly version?: string;
  readonly activeAgentCount?: number;
  readonly attentionRequired?: boolean;
  /** Why the host asks for a look, when it says. */
  readonly attentionReason?: HostAttentionReason;
}

/** The host's own categories, plus the desktop's for a host it cannot read. */
export type HostAttentionReason = "provider-not-ready" | "provider-stopped" | "host-unconfirmed";

export async function probeLocalHost(options: {
  readonly url: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<LocalHostProbe | undefined> {
  const fetch = options.fetch ?? globalThis.fetch;
  try {
    const baseUrl = new URL(options.url);
    if (
      baseUrl.protocol !== "http:" ||
      (baseUrl.hostname !== "127.0.0.1" && baseUrl.hostname !== "localhost") ||
      baseUrl.username !== "" ||
      baseUrl.password !== "" ||
      baseUrl.search !== "" ||
      baseUrl.hash !== ""
    ) {
      return undefined;
    }
    baseUrl.pathname = "/";
    const normalizedUrl = baseUrl.toString();
    const healthUrl = new URL("/health", normalizedUrl).toString();
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const body = payload as Record<string, unknown>;
    if (
      body.product !== "Octant" ||
      body.status !== "ok" ||
      body.storage !== "ready" ||
      typeof body.instanceId !== "string" ||
      body.instanceId.trim() === ""
    ) {
      return undefined;
    }
    const activeAgentCount = body.activeAgentCount;
    return {
      url: normalizedUrl,
      instanceId: body.instanceId,
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof activeAgentCount === "number" &&
      Number.isSafeInteger(activeAgentCount) &&
      activeAgentCount >= 0
        ? { activeAgentCount }
        : {}),
      ...(typeof body.attentionRequired === "boolean"
        ? { attentionRequired: body.attentionRequired }
        : {}),
      ...(body.attentionReason === "provider-not-ready" ||
      body.attentionReason === "provider-stopped"
        ? { attentionReason: body.attentionReason }
        : {}),
    };
  } catch {
    return undefined;
  }
}
