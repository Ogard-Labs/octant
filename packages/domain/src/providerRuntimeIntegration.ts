import type {
  ProviderDriverKind,
  ProviderObservedActivity,
  ProviderObservedState,
  ProviderRuntimeIntegration,
  ProviderToolTransport,
} from "@octant/contracts/providers";
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
 * bridge. Ollama, Oh My Pi, and the image profiles have none. A settings card
 * that named a transport the adapter does not use would be the very guess this
 * mirror exists to prevent, so a new driver kind must be placed here.
 */
export function providerToolTransport(
  driverKind: ProviderDriverKind,
): ProviderToolTransport | undefined {
  switch (driverKind) {
    case "openai-compatible":
    case "anthropic-compatible":
    case "azure-foundry":
      return "request-tool-calls";
    case "claude":
      return "sdk-tool-server";
    case "codex":
      return "app-server-dynamic-tools";
    case "opencode":
    case "kilo":
    case "devin":
    case "mistral-vibe":
    case "kimi-code":
    case "grok":
    case "goose":
    case "glm":
    case "gemini":
    case "copilot":
    case "cline":
    case "qwen":
    case "fx":
      return "session-mcp-bridge";
    case "pi":
      return "session-tool-bridge";
    case "oh-my-pi":
    case "ollama":
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
 * reach it and how, what its sessions report, and how a follow-up continues.
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
  const resume = !providerKeepsConversation(driverKind)
    ? "best-effort"
    : capabilities.resume === "supported"
      ? "precise"
      : "none";
  return { tools, activity, resume };
}
