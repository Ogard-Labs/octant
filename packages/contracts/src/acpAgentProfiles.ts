import { Schema } from "effect";

/**
 * How an ACP agent instance signs in. `subscription` and `provider-owned` both
 * reuse the agent's own login; `api-key` reads a key the host credential
 * broker holds for the instance.
 */
export const AcpAgentAuthentication = Schema.Literal("subscription", "provider-owned", "api-key");
export type AcpAgentAuthentication = typeof AcpAgentAuthentication.Type;

/**
 * What the rest of Octant knows about one ACP agent before it runs. Its runtime
 * behavior (launch argv, environment, confinement, mode mapping) is the other
 * half of the profile and lives beside the shared ACP stack in the server.
 */
export interface AcpAgentProfileDescriptor {
  /** Product name, as Settings, the plugin catalog, and discovery show it. */
  readonly name: string;
  /** Executable discovery searches for; Settings names the binary after it. */
  readonly executable: string;
  /**
   * Non-mutating version probe. Empty when the agent has no version flag; the
   * host then cannot check a binary the person picks, so it offers no picker.
   */
  readonly versionProbeArgs: ReadonlyArray<string>;
  /**
   * Postures a configuration may name, in order; the first is the one
   * discovery registers. Empty means the agent's own login and a configuration
   * that carries no posture at all.
   */
  readonly authentication: ReadonlyArray<AcpAgentAuthentication>;
  /** Postures Settings offers, when that is narrower than what still decodes. */
  readonly offeredAuthentication?: ReadonlyArray<AcpAgentAuthentication>;
  /** The key's name wherever the `api-key` posture is offered. */
  readonly apiKeyLabel?: string;
  /** A sentence Settings shows beside the authentication choice. */
  readonly authenticationNote?: string;
  /** How the person signs in with the agent's own login. */
  readonly signInGuidance: string;
  /** The agent's documented self-update arguments, when it has them. */
  readonly cliUpdateArgs?: ReadonlyArray<string>;
  /**
   * Seeds the bundled provider-driver plugin's extension id and digest. Each
   * profile keeps its serial for good: activation state is stored against the
   * id it derives, so a changed or reused serial would move another plugin's
   * state onto this one.
   */
  readonly bundledPluginSerial: number;
}

/**
 * Every coding agent Octant runs on its shared ACP stack. A row here, its
 * runtime profile in `apps/server/src/providers/acpProfiles.ts`, a logo, and
 * conformance evidence are the whole registration: the driver-kind vocabulary,
 * instance and command schemas, capability placement, bundled plugin,
 * discovery descriptor, Settings forms, and labels are derived from this table.
 *
 * OpenCode also speaks ACP on 2.x but keeps its own native driver, so it is not
 * a row here.
 */
export const ACP_AGENT_PROFILES = {
  kilo: {
    name: "Kilo",
    executable: "kilo",
    versionProbeArgs: ["--version"],
    authentication: [],
    signInGuidance: "Run kilo auth login in your terminal, then check the connection again.",
    bundledPluginSerial: 0x3,
  },
  devin: {
    name: "Devin",
    executable: "devin",
    versionProbeArgs: ["--version"],
    authentication: ["subscription"],
    signInGuidance: "Run devin auth login in your terminal, then check the connection again.",
    cliUpdateArgs: ["update"],
    bundledPluginSerial: 0x6,
  },
  "mistral-vibe": {
    name: "Mistral Vibe",
    executable: "vibe-acp",
    versionProbeArgs: ["--version"],
    authentication: ["subscription", "api-key"],
    // Discovery still registers the subscription posture, but the confined
    // launch cannot read the key Vibe keeps in the macOS Keychain, so Settings
    // offers only a key the host broker holds.
    offeredAuthentication: ["api-key"],
    apiKeyLabel: "Mistral API key",
    authenticationNote:
      "Mistral Vibe uses a Mistral API key. Octant's confined launch cannot read the key Vibe stores in the macOS Keychain.",
    signInGuidance: "Run `vibe --setup` in your terminal, then check the connection again.",
    cliUpdateArgs: ["update"],
    bundledPluginSerial: 0x7,
  },
  "kimi-code": {
    name: "Kimi Code",
    executable: "kimi",
    versionProbeArgs: ["--version"],
    authentication: [],
    signInGuidance:
      "Run kimi login in your terminal, then check the connection again. Octant reuses the same provider profile.",
    cliUpdateArgs: ["upgrade"],
    bundledPluginSerial: 0x9,
  },
  grok: {
    name: "Grok Build",
    executable: "grok",
    versionProbeArgs: ["--version"],
    authentication: ["subscription", "api-key"],
    apiKeyLabel: "xAI API key",
    signInGuidance:
      "Run grok login (or grok login --device-auth on a headless host), then check the connection again.",
    cliUpdateArgs: ["update"],
    bundledPluginSerial: 0xa,
  },
  goose: {
    name: "Goose",
    executable: "goose",
    versionProbeArgs: ["--version"],
    authentication: [],
    signInGuidance: "Run `goose configure`, then check the connection again.",
    bundledPluginSerial: 0xe,
  },
  glm: {
    name: "GLM Agent",
    executable: "glm-acp-agent",
    // Run bare, the agent starts and waits on stdin: it has no version flag.
    versionProbeArgs: [],
    authentication: ["provider-owned", "api-key"],
    apiKeyLabel: "Z.AI API key",
    signInGuidance:
      "Run the provider-owned GLM Agent CLI login in your terminal, then check the connection again.",
    bundledPluginSerial: 0xf,
  },
  gemini: {
    name: "Gemini CLI",
    executable: "gemini",
    versionProbeArgs: ["--version"],
    authentication: ["provider-owned", "api-key"],
    apiKeyLabel: "Gemini API key",
    signInGuidance:
      "Run Gemini CLI in your terminal and complete its provider-owned login, then check the connection again.",
    bundledPluginSerial: 0x10,
  },
  copilot: {
    name: "GitHub Copilot",
    executable: "copilot",
    versionProbeArgs: ["--version"],
    authentication: [],
    signInGuidance: "Run `copilot login`, then check the connection again.",
    cliUpdateArgs: ["update"],
    bundledPluginSerial: 0x11,
  },
  cline: {
    name: "Cline",
    executable: "cline",
    versionProbeArgs: ["--version"],
    authentication: ["provider-owned", "api-key"],
    apiKeyLabel: "Cline API key",
    signInGuidance: "Run `cline auth` in your terminal, then check the connection again.",
    cliUpdateArgs: ["update"],
    bundledPluginSerial: 0x12,
  },
  qwen: {
    name: "Qwen Code",
    executable: "qwen",
    versionProbeArgs: ["--version"],
    authentication: ["provider-owned", "api-key"],
    apiKeyLabel: "OpenAI-compatible API key",
    signInGuidance:
      "Run the provider-owned Qwen CLI login in your terminal, then check the connection again.",
    bundledPluginSerial: 0x13,
  },
  fx: {
    name: "fx",
    executable: "fx",
    versionProbeArgs: ["--version"],
    // fx keeps its profile under `$HOME/.fx` and exposes no profile-path
    // variable, so it runs in an isolated managed home and the interactive
    // `~/.fx` login stays outside the confined process: a brokered Vercel AI
    // Gateway key is its only posture.
    authentication: ["api-key"],
    apiKeyLabel: "Vercel AI Gateway API key",
    signInGuidance: "Add a Vercel AI Gateway API key for fx, then check the connection again.",
    bundledPluginSerial: 0x14,
  },
} as const satisfies Readonly<Record<string, AcpAgentProfileDescriptor>>;

export type AcpAgentKind = keyof typeof ACP_AGENT_PROFILES;

/** The table's kinds; `Object.keys` cannot type them, so they are named here. */
export const ACP_AGENT_KINDS = Object.keys(ACP_AGENT_PROFILES) as ReadonlyArray<AcpAgentKind>;

const acpAgentKinds: ReadonlySet<string> = new Set(ACP_AGENT_KINDS);

export function isAcpAgentKind(kind: string): kind is AcpAgentKind {
  return acpAgentKinds.has(kind);
}

export function acpAgentProfile(kind: AcpAgentKind): AcpAgentProfileDescriptor {
  return ACP_AGENT_PROFILES[kind];
}

/** Every ACP agent configuration names its kind as `<driver kind>-acp`. */
export type AcpAgentConfigurationKind = `${AcpAgentKind}-acp`;

export function acpAgentConfigurationKind(kind: AcpAgentKind): AcpAgentConfigurationKind {
  return `${kind}-acp`;
}

const acpAgentKindsByConfigurationKind: ReadonlyMap<string, AcpAgentKind> = new Map(
  ACP_AGENT_KINDS.map((kind) => [acpAgentConfigurationKind(kind), kind]),
);

export function acpAgentKindOfConfiguration(kind: AcpAgentConfigurationKind): AcpAgentKind {
  const agentKind = acpAgentKindsByConfigurationKind.get(kind);
  if (agentKind === undefined) throw new Error(`Unknown ACP agent configuration kind: ${kind}`);
  return agentKind;
}
