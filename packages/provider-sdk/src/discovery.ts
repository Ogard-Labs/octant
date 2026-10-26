import { ACP_AGENT_KINDS, acpAgentProfile, type ProviderDriverKind } from "@octant/contracts";

/**
 * Declarative discovery descriptor contributed by each provider driver.
 * The authoritative host uses these descriptors to scan for installed
 * runtimes without shell evaluation, installing, authenticating, or
 * enabling anything automatically.
 */
export interface ProviderDiscoveryDescriptor {
  readonly driverKind: ProviderDriverKind;
  /** Human-readable provider name for display. */
  readonly displayName: string;
  /** Optional executable-specific display name for runtimes in one family. */
  readonly displayNameForExecutable?: (executableName: string) => string;
  /** Executable names to search for (e.g. ["codex", "codex-cli"]). */
  readonly executableNames: ReadonlyArray<string>;
  /**
   * Platform-approved absolute directories to search beyond PATH.
   * These are safe, well-known installation locations.
   */
  readonly approvedLocations: ReadonlyArray<string>;
  /**
   * Non-mutating version probe arguments (e.g. ["--version"]).
   * Must not prompt, mutate state, or require authentication.
   */
  readonly versionProbeArgs: ReadonlyArray<string>;
  /**
   * Optional non-mutating authentication-readiness probe.
   * Must be prompt-free and safe to run without side effects.
   * If undefined, readiness is reported as "unknown" with guidance.
   */
  readonly authProbeArgs?: ReadonlyArray<string>;
  /**
   * Onboarding guidance shown when authentication is required or unknown.
   */
  readonly onboardingGuidance: string;
  /**
   * Whether this provider is a direct HTTP endpoint rather than a CLI.
   * Direct endpoints are not auto-detected; they use a guided flow.
   */
  readonly isDirectEndpoint: boolean;
}

/**
 * The complete catalog of discovery descriptors for all supported drivers.
 * Only CLI/SDK providers are discoverable; direct HTTP endpoints are excluded
 * from automatic detection.
 */
export const DISCOVERY_DESCRIPTORS: ReadonlyArray<ProviderDiscoveryDescriptor> = [
  {
    driverKind: "codex",
    displayName: "Codex CLI",
    executableNames: ["codex"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    authProbeArgs: ["login", "status"],
    onboardingGuidance:
      "Run codex login in your terminal to authenticate, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "claude",
    displayName: "Claude Code",
    executableNames: ["claude"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance:
      "Authenticate with the official Claude Code app or CLI, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "opencode",
    displayName: "OpenCode CLI",
    displayNameForExecutable: (executableName) =>
      executableName === "opencode2" ? "OpenCode 2 preview" : "OpenCode CLI",
    // Released OpenCode 2 installs `opencode`; `opencode2` is the earlier beta
    // name kept as a fallback when only a beta binary is present.
    executableNames: ["opencode", "opencode2"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance: "Authenticate with OpenCode, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "pi",
    displayName: "Pi RPC",
    executableNames: ["pi"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance: "Authenticate with the official Pi CLI, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "oh-my-pi",
    displayName: "Oh My Pi",
    executableNames: ["omp"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance:
      "Install Oh My Pi (`omp`) and authenticate its providers, then check the connection again. Octant treats Oh My Pi as distinct from Pi.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "ollama",
    displayName: "Ollama",
    executableNames: ["ollama"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance:
      "Start the user-managed Ollama service and verify the loopback API base URL, then retry.",
    isDirectEndpoint: false,
  },
  ...ACP_AGENT_KINDS.map((kind): ProviderDiscoveryDescriptor => {
    const profile = acpAgentProfile(kind);
    return {
      driverKind: kind,
      displayName: profile.name,
      executableNames: [profile.executable],
      approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
      versionProbeArgs: profile.versionProbeArgs,
      onboardingGuidance: profile.signInGuidance,
      isDirectEndpoint: false,
    };
  }),
  // Direct HTTP endpoint providers are NOT auto-detected.
  // They are listed here for completeness but excluded from scanning.
  {
    driverKind: "openai-compatible",
    displayName: "OpenAI-compatible HTTP",
    executableNames: [],
    approvedLocations: [],
    versionProbeArgs: [],
    onboardingGuidance: "Enter the API base URL and credentials in the guided endpoint flow.",
    isDirectEndpoint: true,
  },
  {
    driverKind: "anthropic-compatible",
    displayName: "Anthropic-compatible HTTP",
    executableNames: [],
    approvedLocations: [],
    versionProbeArgs: [],
    onboardingGuidance: "Enter the API base URL and credentials in the guided endpoint flow.",
    isDirectEndpoint: true,
  },
  {
    driverKind: "azure-foundry",
    displayName: "Azure AI Foundry",
    executableNames: [],
    approvedLocations: [],
    versionProbeArgs: [],
    onboardingGuidance:
      "Enter the Foundry OpenAI v1 base URL and API key in the guided endpoint flow.",
    isDirectEndpoint: true,
  },
];

/** Returns only the discoverable (non-direct-endpoint) descriptors. */
export function discoverableDescriptors(): ReadonlyArray<ProviderDiscoveryDescriptor> {
  return DISCOVERY_DESCRIPTORS.filter((descriptor) => !descriptor.isDirectEndpoint);
}
