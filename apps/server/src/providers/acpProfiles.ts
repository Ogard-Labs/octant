/**
 * Provider profiles for ACP-speaking coding agents that share one driver,
 * process, protocol, and event-mapper stack (`acpDriver.ts`, `acpProcess.ts`,
 * `acpProtocol.ts`, `acpEventMapper.ts`).
 *
 * A profile is data plus a few small pure functions describing where the four
 * agents genuinely differ: binary version contract, launch argv, environment
 * guards, managed-home layout, Seatbelt strategy, ACP mode mapping, and
 * capability quirks. Everything else is shared behavior.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderDriverKind, ProviderExecutionPolicy } from "@octant/contracts";

export type AcpProviderKind = Extract<
  ProviderDriverKind,
  "kilo" | "devin" | "mistral-vibe" | "kimi-code"
>;
export type AcpSessionMode = "chat" | "work" | "code";

export interface AcpManagedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Provider-owned authentication state that lives outside the managed home.
 * `directory` (Kilo) must already exist unless overridden and gets read+write
 * authority; `credential-file` (Devin) is symlinked into the managed home and
 * gets read authority when present.
 */
export type AcpHostAuthentication =
  | { readonly kind: "directory"; readonly defaultPath: string; readonly loginHint: string }
  | {
      readonly kind: "credential-file";
      readonly defaultPath: string;
      readonly managedRelativePath: string;
    };

export type AcpConfinementStrategy =
  /** Shared deny-default Seatbelt profile; explicit Full access runs unconfined. */
  | { readonly kind: "deny-default-seatbelt" }
  /**
   * Immutable managed profile (Kimi Code): the managed home is the agent's
   * config home, a synthetic `HOME` and private `TMPDIR` live under it, the
   * generated configuration is integrity-checked, extension entries are
   * forbidden, and even Full access keeps immutable deny rules.
   */
  | {
      readonly kind: "immutable-managed-profile";
      readonly homeVariable: string;
      readonly configurationFileName: string;
      readonly configuration: string;
      /** Managed-home entries that must not exist (executable extension surfaces). */
      readonly forbiddenEntries: ReadonlyArray<string>;
      /** Project-root entries the agent may neither read nor write. */
      readonly forbiddenRootEntries: ReadonlyArray<string>;
    };

export interface AcpProcessProfile {
  /** `agentInfo.name` the ACP `initialize` response must report. */
  readonly agentName: string;
  /** `--version` output contract; groups 1-3 are major, minor, patch. */
  readonly versionPattern: RegExp;
  readonly minimumVersion: readonly [number, number, number];
  readonly passthroughVariables: ReadonlyArray<string>;
  readonly guards: Readonly<Record<string, string>>;
  readonly environment: (input: {
    readonly managedHome: string;
    readonly executionPolicy: ProviderExecutionPolicy;
    readonly apiKey?: string;
  }) => Readonly<Record<string, string>>;
  readonly args: (input: {
    readonly root: string;
    readonly managedHome: string;
  }) => ReadonlyArray<string>;
  readonly managedFiles: (input: {
    readonly managedHome: string;
    readonly executionPolicy: ProviderExecutionPolicy;
  }) => ReadonlyArray<AcpManagedFile>;
  readonly hostAuthentication?: AcpHostAuthentication;
  readonly confinement: AcpConfinementStrategy;
}

export interface AcpProviderProfile {
  readonly kind: AcpProviderKind;
  readonly displayName: string;
  /** Session config option that toggles reasoning, when the agent exposes one. */
  readonly reasoningOptionId: "effort" | "thinking";
  /** ACP `mode` config value for a product mode and execution policy. */
  readonly sessionMode: (mode: AcpSessionMode, policy: ProviderExecutionPolicy) => string;
  /** Chat sessions run in the managed home unless the agent needs a real Project root. */
  readonly chatSessionRoot: "managed-home" | "project-root";
  readonly userQuestions: "supported" | "unsupported";
  /** ACP method used to reattach to a prior session. */
  readonly resumeMethod: "session/load" | "session/resume";
  /** Whether `session/close` is issued when a session ends. */
  readonly closesSessions: boolean;
  /** Whether the probe calls `authenticate` before opening a scratch session. */
  readonly authenticateOnProbe: boolean;
  /**
   * When present, the probe fails closed unless the agent advertises exactly
   * this embedded command inventory, and user prompts starting with `/` are
   * rejected before reaching the agent.
   */
  readonly reviewedCommands?: ReadonlyArray<string>;
  /** Delegated browser sign-in plus API-key launch injection (Mistral Vibe). */
  readonly authentication:
    | { readonly kind: "provider-owned" }
    | { readonly kind: "delegated-browser"; readonly apiKeyVariable: string };
  readonly unauthenticatedMessage: string;
  readonly process: AcpProcessProfile;
}

const HOST_PASSTHROUGH_VARIABLES: ReadonlyArray<string> = [
  "COLORTERM",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
];

function kiloConfiguration(executionPolicy: ProviderExecutionPolicy) {
  const permission =
    executionPolicy === "full-access" ? "allow" : executionPolicy === "plan" ? "deny" : "ask";
  return {
    permission,
    plugin: [],
    mcp: {},
    instructions: [],
    agent: {
      octant: {
        description: "Octant managed session",
        mode: "primary",
        permission,
      },
    },
  } as const;
}

const kiloProfile: AcpProviderProfile = {
  kind: "kilo",
  displayName: "Kilo",
  reasoningOptionId: "effort",
  sessionMode: () => "octant",
  chatSessionRoot: "managed-home",
  userQuestions: "supported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage: "Kilo is not authenticated. Sign in from Provider Settings, then retry.",
  process: {
    agentName: "Kilo",
    versionPattern:
      /^(?:kilo )?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?\r?\n?$/,
    minimumVersion: [1, 0, 0],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: {
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_DISABLE_AUTOCOMPACT: "1",
      KILO_DISABLE_CHANNEL_DB: "1",
      KILO_DISABLE_CODEBASE_INDEXING: "1",
      KILO_DISABLE_DEFAULT_PLUGINS: "1",
      KILO_DISABLE_EMBEDDED_WEB_UI: "1",
      KILO_DISABLE_EXTERNAL_SKILLS: "1",
      KILO_DISABLE_LSP_DOWNLOAD: "1",
      KILO_DISABLE_PRESENCE: "1",
      KILO_DISABLE_PROJECT_CONFIG: "1",
      KILO_DISABLE_SESSION_INGEST: "1",
      KILO_DISABLE_SHARE: "1",
      KILO_PURE: "1",
      KILO_TELEMETRY_LEVEL: "off",
      NO_COLOR: "1",
    },
    environment: ({ managedHome, executionPolicy }) => ({
      KILO_CONFIG_DIR: join(managedHome, "config"),
      KILO_CONFIG_CONTENT: JSON.stringify(kiloConfiguration(executionPolicy)),
    }),
    args: ({ root }) => ["acp", "--cwd", root],
    managedFiles: ({ managedHome, executionPolicy }) => [
      {
        path: join(managedHome, "config", "kilo.json"),
        content: `${JSON.stringify(kiloConfiguration(executionPolicy), null, 2)}\n`,
      },
    ],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".local/share/kilo"),
      loginHint: "Run kilo auth login, then retry.",
    },
    confinement: { kind: "deny-default-seatbelt" },
  },
};

const DEVIN_CONFIGURATION = {
  permissions: { allow: [], deny: [], ask: [] },
  mcpServers: {},
  hooks: {},
  read_config_from: {
    cursor: false,
    windsurf: false,
    claude: false,
    opencode: false,
    zed: false,
    agents_standard: false,
  },
  plugin_dirs: [],
  auto_update: false,
  notify: "never",
  attribution: false,
} as const;
const DEVIN_AGENT_CONFIGURATION = {
  system_instructions: "Operate only through Octant-provided context, tools, and authority.",
  allowed_tools: ["read", "edit", "grep", "glob", "exec"],
  permissions: { allow: [], deny: [], ask: [] },
  mcp_servers: [],
  extensions: [],
} as const;

function devinConfigPath(managedHome: string): string {
  return join(managedHome, ".config/devin/config.json");
}
function devinAgentConfigPath(managedHome: string): string {
  return join(managedHome, ".config/devin/octant-agent.json");
}

const devinProfile: AcpProviderProfile = {
  kind: "devin",
  displayName: "Devin",
  reasoningOptionId: "thinking",
  sessionMode: (mode, policy) => {
    if (mode === "chat") return "ask";
    if (policy === "plan") return "plan";
    if (policy === "full-access") return "bypass";
    return "ask";
  },
  chatSessionRoot: "managed-home",
  userQuestions: "supported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage: "Devin is not authenticated. Sign in from Provider Settings, then retry.",
  process: {
    agentName: "affogato",
    versionPattern: /^devin (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) \([0-9a-f]+\)\r?\n?$/,
    minimumVersion: [3000, 1, 27],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: { DEVIN_PERMISSION_MODE: "auto", NO_COLOR: "1" },
    environment: ({ managedHome }) => ({ HOME: managedHome }),
    args: ({ managedHome }) => [
      "--config",
      devinConfigPath(managedHome),
      "--agent-config",
      devinAgentConfigPath(managedHome),
      "--respect-workspace-trust",
      "true",
      "--permission-mode",
      "auto",
      "acp",
    ],
    managedFiles: ({ managedHome }) => [
      {
        path: devinConfigPath(managedHome),
        content: `${JSON.stringify(DEVIN_CONFIGURATION, null, 2)}\n`,
      },
      {
        path: devinAgentConfigPath(managedHome),
        content: `${JSON.stringify(DEVIN_AGENT_CONFIGURATION, null, 2)}\n`,
      },
    ],
    hostAuthentication: {
      kind: "credential-file",
      defaultPath: join(homedir(), ".local/share/devin/credentials.toml"),
      managedRelativePath: ".local/share/devin/credentials.toml",
    },
    confinement: { kind: "deny-default-seatbelt" },
  },
};

const vibeProfile: AcpProviderProfile = {
  kind: "mistral-vibe",
  displayName: "Mistral Vibe",
  reasoningOptionId: "thinking",
  sessionMode: (mode, policy) => {
    if (mode === "chat") return "chat";
    if (policy === "plan") return "plan";
    if (policy === "full-access") return "auto-approve";
    return "default";
  },
  chatSessionRoot: "managed-home",
  userQuestions: "unsupported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "delegated-browser", apiKeyVariable: "MISTRAL_API_KEY" },
  unauthenticatedMessage:
    "Mistral Vibe is not authenticated. Sign in from Provider Settings, then retry.",
  process: {
    agentName: "@mistralai/mistral-vibe",
    versionPattern:
      /^vibe-acp (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\r?\n?$/,
    minimumVersion: [2, 19, 0],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: {
      VIBE_ENABLE_TELEMETRY: "false",
      VIBE_ENABLE_UPDATE_CHECKS: "false",
      VIBE_ENABLE_NOTIFICATIONS: "false",
      VIBE_ENABLE_CONNECTORS: "false",
      VIBE_INCLUDE_PROJECT_CONTEXT: "false",
      VIBE_ENABLE_EXPERIMENTAL_HOOKS: "false",
      VIBE_EXPERIMENTAL_ENABLE_REGISTRY_SKILLS: "false",
      VIBE_VIBE_CODE_ENABLED: "false",
      VIBE_VOICE_MODE_ENABLED: "false",
      VIBE_NARRATOR_ENABLED: "false",
      VIBE_MCP_SERVERS: "[]",
      VIBE_TOOL_PATHS: "[]",
      VIBE_AGENT_PATHS: "[]",
      VIBE_SKILL_PATHS: "[]",
      VIBE_INSTALLED_AGENTS: "[]",
      VIBE_DISABLED_AGENTS: '["*"]',
      VIBE_DISABLED_SKILLS: '["*"]',
    },
    environment: ({ managedHome, apiKey }) => ({
      HOME: managedHome,
      VIBE_HOME: managedHome,
      ...(apiKey === undefined ? {} : { MISTRAL_API_KEY: apiKey }),
    }),
    args: () => [],
    managedFiles: () => [],
    confinement: { kind: "deny-default-seatbelt" },
  },
};

const KIMI_REVIEWED_COMMANDS = [
  "compact",
  "status",
  "usage",
  "mcp",
  "tasks",
  "help",
  "mcp-config",
  "import-from-cc-codex",
  "update-config",
  "custom-theme",
  "write-goal",
  "check-kimi-code-docs",
  "sub-skill",
  "sub-skill.review",
  "sub-skill.consolidate",
] as const;
const KIMI_DENIED_TOOLS = [
  "Skill",
  "Agent",
  "AgentSwarm",
  "CreateGoal",
  "GetGoal",
  "SetGoalBudget",
  "UpdateGoal",
  "TaskList",
  "TaskOutput",
  "TaskStop",
] as const;
const KIMI_CONFIGURATION = `${[
  'default_permission_mode = "manual"',
  "default_plan_mode = false",
  "merge_all_available_skills = false",
  "telemetry = false",
  "",
  "[background]",
  "keep_alive_on_exit = false",
  ...KIMI_DENIED_TOOLS.flatMap((tool) => [
    "",
    "[[permission.rules]]",
    'decision = "deny"',
    `pattern = "${tool}"`,
  ]),
].join("\n")}\n`;

const kimiProfile: AcpProviderProfile = {
  kind: "kimi-code",
  displayName: "Kimi Code",
  reasoningOptionId: "thinking",
  sessionMode: (_mode, policy) => {
    if (policy === "plan") return "plan";
    if (policy === "full-access") return "yolo";
    return "default";
  },
  chatSessionRoot: "project-root",
  userQuestions: "supported",
  resumeMethod: "session/resume",
  closesSessions: false,
  authenticateOnProbe: true,
  reviewedCommands: KIMI_REVIEWED_COMMANDS,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage:
    "Kimi Code is not authenticated. Run kimi login for its Octant-managed profile, then retry.",
  process: {
    agentName: "Kimi Code CLI",
    versionPattern:
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\r?\n?$/,
    minimumVersion: [0, 26, 0],
    passthroughVariables: [
      ...HOST_PASSTHROUGH_VARIABLES.filter((name) => name !== "HOME"),
      "FORCE_COLOR",
    ],
    guards: {
      KIMI_DISABLE_TELEMETRY: "1",
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_DISABLE_CRON: "1",
      KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: "0",
    },
    environment: () => ({}),
    args: () => ["acp"],
    managedFiles: () => [],
    confinement: {
      kind: "immutable-managed-profile",
      homeVariable: "KIMI_CODE_HOME",
      configurationFileName: "config.toml",
      configuration: KIMI_CONFIGURATION,
      forbiddenEntries: ["AGENTS.md", "mcp.json", "skills", "plugins", "hooks"],
      forbiddenRootEntries: [".kimi-code", ".agents"],
    },
  },
};

export const acpProviderProfiles: Readonly<Record<AcpProviderKind, AcpProviderProfile>> = {
  kilo: kiloProfile,
  devin: devinProfile,
  "mistral-vibe": vibeProfile,
  "kimi-code": kimiProfile,
};

export function isAcpProviderKind(kind: ProviderDriverKind): kind is AcpProviderKind {
  return kind in acpProviderProfiles;
}
