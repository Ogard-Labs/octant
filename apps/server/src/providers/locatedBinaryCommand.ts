import {
  acpAgentChangeCommandKind,
  type ProviderInstance,
  type ProviderRegistryCommand,
} from "@octant/contracts";
import { isAcpAgentInstance } from "@octant/domain";

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
  if (isAcpAgentInstance(instance)) {
    return {
      kind: acpAgentChangeCommandKind(instance.driverKind),
      ...target,
      configuration: { ...instance.configuration, binaryPath },
    };
  }
  switch (instance.driverKind) {
    case "codex":
    case "opencode":
      return { kind: "change-provider-binary", ...target, binaryPath };
    case "claude":
      return {
        kind: "change-claude-configuration",
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
