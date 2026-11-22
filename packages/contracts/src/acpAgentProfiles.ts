import { Schema } from "effect";

/**
 * How an ACP agent instance signs in. `subscription` and `provider-owned` both
 * reuse the agent's own login; `api-key` reads a key the host credential
 * broker holds for the instance; `agent-platform` signs in to the Google Cloud
 * project and location the instance names with the host's Application Default
 * Credentials.
 */
export const AcpAgentAuthentication = Schema.Literal(
  "subscription",
  "provider-owned",
  "api-key",
  "agent-platform",
);
export type AcpAgentAuthentication = typeof AcpAgentAuthentication.Type;

/**
 * The postures in which Octant itself passes the agent its credential (a key
 * from the host broker, or the Cloud project to use), so Octant knows which
 * sign-in a run uses without taking the agent's word for it. Every other
 * posture is the agent's own login.
 */
const OCTANT_PASSED_POSTURES: ReadonlySet<AcpAgentAuthentication> = new Set([
  "api-key",
  "agent-platform",
]);

/**
 * What an agent's own personal sign-in does not cover, as its vendor draws
 * that line. Each field is the sentence a refused run shows, so the server
 * refuses by what the profile declares, never by the profile's id.
 */
export interface AcpPersonalSignInRefusals {
  /**
   * A turn no person sent: a routine run, and every turn the host starts as
   * itself (a wake, Auto-fix, a goal round, a usage-limit or restart
   * continuation, a child's result, a benchmark) or another thread sends.
   */
  readonly refusesUnattendedRuns: string;
  /** A helper run on the agent, and a helper run a thread on it starts. */
  readonly refusesHelperRuns: string;
  /** A turn an outside agent sends under an agent grant. */
  readonly refusesOutsideAgents: string;
}

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
   * that carries no posture at all. A profile that declares `personalSignIn`
   * also decodes a configuration with no posture, which is that personal
   * sign-in: instances saved before it offered a choice carry none.
   */
  readonly authentication: ReadonlyArray<AcpAgentAuthentication>;
  /** Postures Settings offers, when that is narrower than what still decodes. */
  readonly offeredAuthentication?: ReadonlyArray<AcpAgentAuthentication>;
  /** The key's name wherever the `api-key` posture is offered. */
  readonly apiKeyLabel?: string;
  /** What Settings calls a posture, where the generic name would mislead. */
  readonly postureLabels?: Partial<Readonly<Record<AcpAgentAuthentication, string>>>;
  /** A sentence Settings shows beside the authentication choice. */
  readonly authenticationNote?: string;
  /** How the person signs in with the agent's own login. */
  readonly signInGuidance: string;
  /**
   * Runs the agent's own personal sign-in does not cover. They bind every
   * instance of the profile except one whose posture Octant passes itself (a
   * Gemini API key, an Agent Platform project): `personalSignInRefusals`.
   */
  readonly personalSignIn?: AcpPersonalSignInRefusals;
  /** The agent's documented self-update arguments, when it has them. */
  readonly cliUpdateArgs?: ReadonlyArray<string>;
  /**
   * The arguments that start the agent's own interactive command-line
   * interface, which a person-operated provider terminal opens. Set only for
   * an agent whose program is documented to open one this way; absent, no
   * provider terminal is offered for it.
   */
  readonly interactiveArgs?: ReadonlyArray<string>;
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
    // `gemini` with no arguments is the CLI's own interactive session, the
    // one its sign-in guidance sends the person to.
    interactiveArgs: [],
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
  antigravity: {
    name: "Google Antigravity",
    executable: "agy",
    versionProbeArgs: ["--version"],
    // The default is the person's own Google sign-in, which the official CLI
    // keeps itself; Octant runs the unmodified binary and never reads, copies
    // or replaces it. A Gemini API key from the host broker, or an Agent
    // Platform project with the host's Application Default Credentials, are
    // the sign-ins Google's API and Cloud terms cover (maintainer decision,
    // 2026-11-22).
    authentication: ["provider-owned", "api-key", "agent-platform"],
    apiKeyLabel: "Gemini API key",
    postureLabels: {
      "provider-owned": "Personal Google sign-in",
      "agent-platform": "Agent Platform (Google Cloud project)",
    },
    authenticationNote:
      "A personal Google sign-in covers only turns you send yourself. Routines, helper runs and other agents need a Gemini API key or Agent Platform.",
    signInGuidance:
      "Run agy (or agy acp --login) in your terminal and sign in with your Google account, then check the connection again.",
    // `agy` with no arguments is Google's own interactive CLI, where the
    // person signs in.
    interactiveArgs: [],
    // Google supports the CLI on a personal plan for one person at their own
    // computer driving it themselves; unattended runs, use as a sub-agent of
    // another agent loop, and other callers belong on a Gemini API key or
    // Agent Platform, which an instance may choose instead.
    personalSignIn: {
      refusesUnattendedRuns:
        "Google doesn't support unattended runs of Google Antigravity on a personal Google sign-in, so Octant did not start this run. Switch this provider to a Gemini API key or Agent Platform in Settings, or choose another provider.",
      refusesHelperRuns:
        "Google doesn't support Google Antigravity as a helper agent, or starting helpers from it, on a personal Google sign-in. Switch this provider to a Gemini API key or Agent Platform in Settings, or use another provider for helper work.",
      refusesOutsideAgents:
        "Google doesn't support another agent driving Google Antigravity on a personal Google sign-in. Continue this thread yourself in Octant, or switch this provider to a Gemini API key or Agent Platform in Settings.",
    },
    // 0x1b is taken: copilot's 0x11 seed normalizes to the `1b` digest.
    bundledPluginSerial: 0x1c,
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

/** What the personal sign-in check reads of any provider instance. */
export interface ProviderSignInFacts {
  readonly driverKind: string;
  /** The instance's configuration; only its `authentication` field is read. */
  readonly configuration?: object;
}

/**
 * The runs a provider instance's own personal sign-in does not cover;
 * undefined when its kind declares none or the instance signs in with a
 * credential Octant passes the agent itself. The check reads the sign-in the
 * instance is configured with, which is what Octant passes at launch, never
 * what the agent reports: Octant cannot verify which login an agent's own
 * cached sign-in uses, so that one keeps every limit.
 */
export function personalSignInRefusals(
  instance: ProviderSignInFacts | undefined,
): AcpPersonalSignInRefusals | undefined {
  if (instance === undefined || !isAcpAgentKind(instance.driverKind)) return undefined;
  const refusals = acpAgentProfile(instance.driverKind).personalSignIn;
  if (refusals === undefined) return undefined;
  const configuration = instance.configuration;
  const posture =
    configuration !== undefined && "authentication" in configuration
      ? configuration.authentication
      : undefined;
  return AcpAgentAuthentication.literals.some(
    (literal) => literal === posture && OCTANT_PASSED_POSTURES.has(literal),
  )
    ? undefined
    : refusals;
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
