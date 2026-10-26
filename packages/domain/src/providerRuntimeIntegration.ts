import type {
  ProviderCompactionOwner,
  ProviderDriverKind,
  ProviderObservedActivity,
  ProviderObservedState,
  ProviderRuntimeIntegration,
  ProviderToolTransport,
  ProviderUsageReporting,
} from "@octant/contracts/providers";
import { isAcpAgentKind } from "@octant/contracts/acp-agent-profiles";
import {
  isImageProfileDriverKind,
  isNativeHarnessDriverKind,
  providerKeepsConversation,
} from "./providerPolicy";

/**
 * The transport each driver uses to offer Octant's tools, mirroring the
 * adapters: the direct endpoints put tool definitions in each request, the
 * Claude Agent SDK connection owns an in-process tool server, Codex registers
 * dynamic tools on its app-server thread, the ACP drivers and OpenCode register
 * a loopback MCP server with one session, and Pi's extension calls a loopback
 * bridge. Oh My Pi and the image profiles have none. A settings card
 * that named a transport the adapter does not use would be the very guess this
 * mirror exists to prevent, so a new native driver kind must be placed here;
 * an ACP agent is placed by being one.
 */
export function providerToolTransport(
  driverKind: ProviderDriverKind,
): ProviderToolTransport | undefined {
  // Every ACP agent runs on the one shared ACP stack, whose only tool route is
  // the session bridge; whether a given agent takes it is still the runtime's
  // reported capability, never this placement.
  if (isAcpAgentKind(driverKind)) return "session-mcp-bridge";
  switch (driverKind) {
    case "openai-compatible":
    case "anthropic-compatible":
    case "azure-foundry":
    case "ollama":
      return "request-tool-calls";
    case "claude":
      return "sdk-tool-server";
    case "codex":
      return "app-server-dynamic-tools";
    case "opencode":
      return "session-mcp-bridge";
    case "pi":
      return "session-tool-bridge";
    case "oh-my-pi":
    case "openai-image":
    case "gemini-native-image":
    case "bfl-image":
    case "ideogram-image":
      return undefined;
  }
}

const OBSERVED_ACTIVITY: ReadonlyArray<
  readonly [ProviderObservedActivity, keyof ProviderObservedState["capabilities"]]
> = [
  ["replies", "streaming"],
  ["tool-calls", "toolActivity"],
  ["approvals", "approvals"],
  ["file-changes", "fileChanges"],
  ["task-progress", "taskProgress"],
];

/**
 * What a runtime's Settings card may claim about it: whether Octant's tools
 * reach it and how, what its sessions report, how a follow-up continues, and
 * whether a thread on it can show a context window or be compacted.
 * Everything comes from the driver kind and the last connection check, the
 * same facts the server gates a send on; nothing is inferred from what a
 * picker can mention. Image profiles run no turns and have no integration.
 */
export function describeProviderRuntimeIntegration(
  driverKind: ProviderDriverKind,
  observed: Pick<ProviderObservedState, "readiness" | "capabilities">,
): ProviderRuntimeIntegration | undefined {
  if (isImageProfileDriverKind(driverKind)) return undefined;
  const { capabilities } = observed;
  const transport = providerToolTransport(driverKind);
  const tools: ProviderRuntimeIntegration["tools"] =
    capabilities.appManagedTools === "supported" && transport !== undefined
      ? { status: "available", transport }
      : {
          status: "unavailable",
          ...(transport === undefined ? {} : { transport }),
          reason:
            transport === undefined
              ? "no-transport"
              : capabilities.appManagedTools === "unavailable"
                ? "not-confirmed"
                : isNativeHarnessDriverKind(driverKind)
                  ? "model-verification-required"
                  : "runtime-not-confirmed",
        };
  const runsTurns = observed.readiness !== "unavailable" && observed.readiness !== "incompatible";
  const observes = OBSERVED_ACTIVITY.flatMap(([activity, capability]) =>
    capabilities[capability] === "supported" ? [activity] : [],
  );
  const activity: ProviderRuntimeIntegration["activity"] =
    runsTurns && observes.length > 0 ? { source: "session", observes } : { source: "none" };
  const keepsConversation = providerKeepsConversation(driverKind);
  const resume = !keepsConversation
    ? "best-effort"
    : capabilities.resume === "supported"
      ? "precise"
      : "none";
  return {
    tools,
    activity,
    resume,
    context: {
      usage: usageReporting(capabilities.usage),
      compaction: keepsConversation ? runtimeCompaction(observed) : "octant",
    },
  };
}

function usageReporting(
  usage: ProviderObservedState["capabilities"]["usage"],
): ProviderUsageReporting {
  if (usage === "supported") return "reported";
  return usage === "unsupported" ? "not-reported" : "not-confirmed";
}

/**
 * Mirrors the host's compaction decision for a conversation the runtime keeps:
 * a mode the adapter did not answer reads as unsupported, as the host reads
 * it, so the card never claims a compaction the host would refuse. A runtime
 * that is not ready answered nothing (a signed-out Claude reports no
 * capabilities), so its silence is not read as "cannot compact".
 */
function runtimeCompaction(
  observed: Pick<ProviderObservedState, "readiness" | "capabilities">,
): ProviderCompactionOwner {
  const modes = observed.capabilities.sessionCompaction;
  if (modes === undefined) {
    return runtimeAnsweredCapabilities(observed.readiness) ? "none" : "not-confirmed";
  }
  const answers = [modes.chat, modes.work, modes.code];
  if (answers.includes("supported")) return "runtime";
  return answers.includes("unavailable") ? "runtime-update-required" : "none";
}

/**
 * Whether a runtime in this readiness reported the capabilities it has. A
 * degraded runtime still runs turns (an ACP agent that listed no models), so
 * its report stands; any other non-ready runtime reported placeholders.
 */
export function runtimeAnsweredCapabilities(
  readiness: ProviderObservedState["readiness"],
): boolean {
  return readiness === "ready" || readiness === "degraded";
}
