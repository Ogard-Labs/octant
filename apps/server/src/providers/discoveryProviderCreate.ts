import {
  acpAgentConfigurationKind,
  acpAgentCreateCommandKind,
  acpAgentProfile,
  decodeProviderInstanceId,
  isAcpAgentKind,
  type CreateAcpAgentProviderCommand,
  type DiscoveryCandidate,
  type ProviderRegistryCommand,
} from "@octant/contracts";

type DiscoveryCreateCandidate = Pick<
  DiscoveryCandidate,
  "driverKind" | "displayName" | "binaryPath"
>;
type DiscoveryCreateCommand =
  | CreateAcpAgentProviderCommand
  | Extract<
      ProviderRegistryCommand,
      {
        kind:
          | "create-codex-provider"
          | "create-opencode-provider"
          | "create-claude-provider"
          | "create-pi-provider"
          | "create-oh-my-pi-provider"
          | "create-ollama-provider";
      }
    >;

export function createProviderFromDiscoveryCandidate(
  candidate: DiscoveryCreateCandidate,
  options: { readonly enabled: boolean },
): {
  instanceId: DiscoveryCreateCommand["instanceId"];
  command: DiscoveryCreateCommand;
} {
  const instanceId = decodeProviderInstanceId(crypto.randomUUID());
  const expectedVersion = 0 as DiscoveryCreateCommand["expectedVersion"];

  if (isAcpAgentKind(candidate.driverKind)) {
    // Discovery proves only that the binary is present, so it registers the
    // profile's first posture: the agent's own login wherever the profile
    // offers one.
    const authentication = acpAgentProfile(candidate.driverKind).authentication[0];
    return {
      instanceId,
      command: {
        kind: acpAgentCreateCommandKind(candidate.driverKind),
        instanceId,
        expectedVersion,
        displayName: candidate.displayName,
        configuration: {
          kind: acpAgentConfigurationKind(candidate.driverKind),
          binaryPath: candidate.binaryPath,
          ...(authentication === undefined ? {} : { authentication }),
        },
        enabled: options.enabled,
      },
    };
  }
  switch (candidate.driverKind) {
    case "codex":
      return {
        instanceId,
        command: {
          kind: "create-codex-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          binaryPath: candidate.binaryPath,
          enabled: options.enabled,
        },
      };
    case "opencode":
      return {
        instanceId,
        command: {
          kind: "create-opencode-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          binaryPath: candidate.binaryPath,
          enabled: options.enabled,
        },
      };
    case "claude":
      return {
        instanceId,
        command: {
          kind: "create-claude-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "claude-agent-sdk",
            binaryPath: candidate.binaryPath,
            authentication: "subscription",
          },
          enabled: options.enabled,
        },
      };
    case "oh-my-pi":
      return {
        instanceId,
        command: {
          kind: "create-oh-my-pi-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "oh-my-pi-rpc",
            binaryPath: candidate.binaryPath,
            // Discovery only proves binary presence; the fail-closed runtime probe
            // re-validates the pinned version before readiness is accepted.
            supportedVersion: "17.2.1",
          },
          enabled: options.enabled,
        },
      };
    case "pi":
      return {
        instanceId,
        command: {
          kind: "create-pi-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "pi-rpc",
            binaryPath: candidate.binaryPath,
          },
          enabled: options.enabled,
        },
      };
    case "ollama":
      return {
        instanceId,
        command: {
          kind: "create-ollama-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "ollama-native-http",
            baseUrl: "http://127.0.0.1:11434",
          },
          enabled: options.enabled,
        },
      };
    default:
      throw new Error(
        `Driver ${candidate.driverKind} cannot be connected from discovery automatically.`,
      );
  }
}
