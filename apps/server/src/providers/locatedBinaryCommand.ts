import type { ProviderInstance, ProviderRegistryCommand } from "@octant/contracts";

/**
 * The registry command that points an existing runtime at a binary the host
 * has already checked. Only the binary path changes: authentication and every
 * other setting stay as they were. Undefined for a provider that names no
 * binary, so the caller refuses it instead of guessing a command.
 */
export function locatedBinaryCommand(
  instance: ProviderInstance,
  binaryPath: string,
): ProviderRegistryCommand | undefined {
  const target = { instanceId: instance.id, expectedVersion: instance.version } as const;
  switch (instance.driverKind) {
    case "codex":
    case "opencode":
    case "kimi-code":
      return { kind: "change-provider-binary", ...target, binaryPath };
    case "claude":
      return {
        kind: "change-claude-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "mistral-vibe":
      return {
        kind: "change-mistral-vibe-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "grok":
      return {
        kind: "change-grok-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "goose":
      return {
        kind: "change-goose-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "gemini":
      return {
        kind: "change-gemini-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "copilot":
      return {
        kind: "change-copilot-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "cline":
      return {
        kind: "change-cline-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "qwen":
      return {
        kind: "change-qwen-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "fx":
      return {
        kind: "change-fx-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "devin":
      return {
        kind: "change-devin-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "kilo":
      return {
        kind: "change-kilo-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "pi":
      return {
        kind: "change-pi-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    case "oh-my-pi":
      return {
        kind: "change-oh-my-pi-configuration",
        ...target,
        configuration: { ...instance.configuration, binaryPath },
      };
    default:
      return undefined;
  }
}
