import type { ProviderDriverKind } from "@octant/contracts";

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
    executableNames: ["opencode2", "opencode"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance: "Authenticate with OpenCode, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "kimi-code",
    displayName: "Kimi Code CLI",
    executableNames: ["kimi"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance:
      "Run kimi login in your terminal, then check the connection again. Octant reuses the same provider profile.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "devin",
    displayName: "Devin ACP",
    executableNames: ["devin"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance: "Run devin auth login in your terminal, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "kilo",
    displayName: "Kilo ACP",
    executableNames: ["kilo"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance: "Run kilo auth login in your terminal, then check the connection again.",
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
    driverKind: "mistral-vibe",
    displayName: "Mistral Vibe ACP",
    executableNames: ["vibe-acp"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance: "Run `vibe --setup` in your terminal, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "grok",
    displayName: "Grok Build",
    executableNames: ["grok"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance:
      "Run grok login (or grok login --device-auth on a headless host), then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "goose",
    displayName: "Goose",
    executableNames: ["goose"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance: "Run `goose configure`, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "glm",
    displayName: "GLM Agent",
    executableNames: ["glm-acp-agent"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: [],
    onboardingGuidance:
      "Run the provider-owned GLM Agent CLI login in your terminal, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "gemini",
    displayName: "Gemini CLI",
    executableNames: ["gemini"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance:
      "Run Gemini CLI in your terminal and complete its provider-owned login, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "copilot",
    displayName: "GitHub Copilot",
    executableNames: ["copilot"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance: "Run `copilot login`, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "cline",
    displayName: "Cline",
    executableNames: ["cline"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance: "Run `cline auth` in your terminal, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "qwen",
    displayName: "Qwen Code",
    executableNames: ["qwen"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance:
      "Run the provider-owned Qwen CLI login in your terminal, then check the connection again.",
    isDirectEndpoint: false,
  },
  {
    driverKind: "fx",
    displayName: "fx",
    executableNames: ["fx"],
    approvedLocations: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"],
    versionProbeArgs: ["--version"],
    onboardingGuidance: "Add a Vercel AI Gateway API key for fx, then check the connection again.",
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
