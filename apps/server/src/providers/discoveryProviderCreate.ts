import {
  decodeProviderInstanceId,
  type DiscoveryCandidate,
  type ProviderRegistryCommand,
} from "@octant/contracts";

type DiscoveryCreateCandidate = Pick<
  DiscoveryCandidate,
  "driverKind" | "displayName" | "binaryPath"
>;
type DiscoveryCreateCommand = Extract<
  ProviderRegistryCommand,
  {
    kind:
      | "create-codex-provider"
      | "create-opencode-provider"
      | "create-kimi-code-provider"
      | "create-claude-provider"
      | "create-mistral-vibe-provider"
      | "create-grok-provider"
      | "create-goose-provider"
      | "create-glm-provider"
      | "create-gemini-provider"
      | "create-copilot-provider"
      | "create-cline-provider"
      | "create-qwen-provider"
      | "create-devin-provider"
      | "create-kilo-provider"
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
    case "kimi-code":
      return {
        instanceId,
        command: {
          kind: "create-kimi-code-provider",
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
    case "mistral-vibe":
      return {
        instanceId,
        command: {
          kind: "create-mistral-vibe-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "mistral-vibe-acp",
            binaryPath: candidate.binaryPath,
            authentication: "subscription",
          },
          enabled: options.enabled,
        },
      };
    case "grok":
      return {
        instanceId,
        command: {
          kind: "create-grok-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "grok-acp",
            binaryPath: candidate.binaryPath,
            authentication: "subscription",
          },
          enabled: options.enabled,
        },
      };
    case "goose":
      return {
        instanceId,
        command: {
          kind: "create-goose-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "goose-acp",
            binaryPath: candidate.binaryPath,
          },
          enabled: options.enabled,
        },
      };
    case "glm":
      return {
        instanceId,
        command: {
          kind: "create-glm-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "glm-acp",
            binaryPath: candidate.binaryPath,
            authentication: "api-key",
          },
          enabled: options.enabled,
        },
      };
    case "gemini":
      return {
        instanceId,
        command: {
          kind: "create-gemini-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "gemini-acp",
            binaryPath: candidate.binaryPath,
            authentication: "api-key",
          },
          enabled: options.enabled,
        },
      };
    case "copilot":
      return {
        instanceId,
        command: {
          kind: "create-copilot-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "copilot-acp",
            binaryPath: candidate.binaryPath,
          },
          enabled: options.enabled,
        },
      };
    case "cline":
      return {
        instanceId,
        command: {
          kind: "create-cline-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "cline-acp",
            binaryPath: candidate.binaryPath,
            authentication: "api-key",
          },
          enabled: options.enabled,
        },
      };
    case "qwen":
      return {
        instanceId,
        command: {
          kind: "create-qwen-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "qwen-acp",
            binaryPath: candidate.binaryPath,
            authentication: "api-key",
          },
          enabled: options.enabled,
        },
      };
    case "devin":
      return {
        instanceId,
        command: {
          kind: "create-devin-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "devin-acp",
            binaryPath: candidate.binaryPath,
            authentication: "subscription",
          },
          enabled: options.enabled,
        },
      };
    case "kilo":
      return {
        instanceId,
        command: {
          kind: "create-kilo-provider",
          instanceId,
          expectedVersion,
          displayName: candidate.displayName,
          configuration: {
            kind: "kilo-acp",
            binaryPath: candidate.binaryPath,
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
