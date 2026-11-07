import {
  decodeUtcTimestamp,
  type ExtensionBlockReason,
  type ExtensionPackageState,
  type ExtensionSnapshot,
  type McpServerConnection,
  type McpServerConnectionListing,
  type McpServerConnectionState,
  type McpServerSignInView,
  type UtcTimestamp,
} from "@octant/contracts";
import type { McpConnectionObservation } from "./agentPluginMcpSessionManager";

type PrincipalKind = "local-window" | "remote-device";

/**
 * Where the Settings connection listing reads from. Every source is a
 * retained fact: the lifecycle snapshot, the session manager's memory, the
 * stored sign-in record, and the installed package's own configuration file.
 * None of them connects, signs in, or asks a server for its tools.
 */
export interface McpServerConnectionSources {
  readonly snapshot: () => ExtensionSnapshot;
  readonly observations: () => ReadonlyArray<McpConnectionObservation>;
  readonly signInStatus: (
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
  ) => Promise<McpServerSignInView>;
  readonly readConfiguration: (
    packageState: ExtensionPackageState,
    componentId: string,
  ) => Promise<string>;
}

type ComponentState = ExtensionPackageState["components"][number];

const BLOCKED_REASONS: Partial<Record<ExtensionBlockReason, string>> = {
  untrusted: "The package is not trusted yet.",
  "review-required": "The package is waiting for review.",
  incompatible: "The package does not work with this version of Octant.",
  quarantined: "The package is quarantined.",
  broken: "The package is broken. Reinstall it.",
  unavailable: "The server is not available on this host.",
  "host-prohibited": "This host's policy does not allow it.",
};

const SIGN_IN_AGAIN: Record<
  Extract<McpServerSignInView, { kind: "sign-in-again" }>["reason"],
  string
> = {
  revoked: "The sign-in was revoked. Sign in again.",
  expired: "The sign-in expired. Sign in again.",
  "refresh-reused": "The sign-in stopped working. Sign in again.",
  "identity-unavailable": "The sign-in stopped working. Sign in again.",
  "account-changed": "A different account signed in. Sign in again.",
  "permission-missing": "The sign-in lacks a permission this server needs. Sign in again.",
  "permission-mismatch": "The sign-in lacks a permission this server needs. Sign in again.",
};

/**
 * One server's state, from most to least decisive: switched off, then a
 * sign-in the person must redo, then what the session manager saw, then a
 * lifecycle block, then ready.
 */
export function describeMcpServerConnection(input: {
  readonly component: ComponentState;
  readonly signIn: McpServerSignInView;
  readonly observation?: McpConnectionObservation;
}): {
  readonly state: McpServerConnectionState;
  readonly reason?: string;
  readonly checkedAt?: UtcTimestamp;
} {
  const { component, observation, signIn } = input;
  const at = observation?.at === undefined ? {} : { checkedAt: decodeUtcTimestamp(observation.at) };
  const effective = component.effectiveState;
  if (
    !component.activation.pluginDesired ||
    !component.activation.componentDesired ||
    (effective.kind === "blocked" &&
      (effective.reason === "plugin-disabled" || effective.reason === "component-disabled"))
  )
    return { state: "off", reason: "Switched off." };
  if (signIn.kind === "signed-out")
    return { state: "needs-sign-in", reason: "Not signed in.", ...at };
  if (signIn.kind === "sign-in-again")
    return { state: "needs-sign-in", reason: SIGN_IN_AGAIN[signIn.reason], ...at };
  if (signIn.kind === "awaiting-consent")
    return { state: "needs-sign-in", reason: "Finish signing in in the browser.", ...at };
  if (observation?.state === "connected") return { state: "connected", ...at };
  if (observation?.state === "connecting") return { state: "connecting", ...at };
  if (observation?.state === "failed")
    return { state: "failed", reason: failureSentence(observation.reason), ...at };
  if (effective.kind === "blocked")
    return {
      state: "blocked",
      reason: BLOCKED_REASONS[effective.reason] ?? "The host is not running it now.",
      ...at,
    };
  return { state: "ready", ...at };
}

function failureSentence(reason: string | undefined): string {
  const detail = (reason ?? "").trim().replace(/\s+/g, " ");
  if (detail === "") return "Could not connect.";
  const sentence = `Could not connect: ${detail}`;
  return sentence.length > 512 ? `${sentence.slice(0, 509)}...` : sentence;
}

/** The transport the installed mcp.json names for this server, read from disk. */
export function transportOf(configuration: string): McpServerConnection["transport"] {
  try {
    const parsed: unknown = JSON.parse(configuration);
    const servers =
      typeof parsed === "object" && parsed !== null && "mcpServers" in parsed
        ? parsed.mcpServers
        : undefined;
    if (typeof servers !== "object" || servers === null) return "unknown";
    const first: unknown = Object.values(servers)[0];
    if (typeof first !== "object" || first === null) return "unknown";
    if ("url" in first) return "streamable-http";
    if ("command" in first) return "stdio";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function listMcpServerConnections(
  sources: McpServerConnectionSources,
  principalKind: PrincipalKind,
): Promise<McpServerConnectionListing> {
  const observations = new Map(
    sources
      .observations()
      .map((observation) => [
        `${observation.extensionId}\u0000${observation.componentId}`,
        observation,
      ]),
  );
  const servers: McpServerConnection[] = [];
  for (const packageState of sources.snapshot().packages) {
    for (const component of packageState.components) {
      if (component.component.kind !== "mcp-server") continue;
      const extensionId = String(packageState.extensionId);
      const componentId = String(component.component.id);
      const [signIn, configuration] = await Promise.all([
        sources
          .signInStatus(extensionId, componentId, principalKind)
          .catch((): McpServerSignInView => ({ kind: "not-applicable" })),
        sources.readConfiguration(packageState, componentId).catch(() => ""),
      ]);
      const observation = observations.get(`${extensionId}\u0000${componentId}`);
      servers.push({
        extensionId: packageState.extensionId,
        packageId: packageState.packageId,
        componentId: component.component.id,
        packageName:
          packageState.displayName ?? packageState.slug ?? String(packageState.packageId),
        serverName: component.component.displayName,
        transport: transportOf(configuration),
        ...describeMcpServerConnection({
          component,
          signIn,
          ...(observation === undefined ? {} : { observation }),
        }),
      });
    }
  }
  return { servers };
}
