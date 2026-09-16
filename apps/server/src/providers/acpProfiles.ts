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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderDriverKind, ProviderExecutionPolicy } from "@octant/contracts";
import type { AcpInitializeResult } from "./acpProtocol";

export type AcpProviderKind = Extract<
  ProviderDriverKind,
  | "kilo"
  | "opencode"
  | "devin"
  | "mistral-vibe"
  | "kimi-code"
  | "grok"
  | "goose"
  | "glm"
  | "gemini"
  | "copilot"
  | "cline"
  | "qwen"
>;
export type AcpSessionMode = "chat" | "work" | "code";

export interface AcpManagedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Provider-owned authentication state that lives outside the managed home.
 * A directory gets read+write authority only for the provider's documented
 * profile root; a credential file (Devin) is symlinked into the managed home
 * and gets read authority when present.
 */
export type AcpHostAuthentication =
  | {
      readonly kind: "directory";
      readonly defaultPath: string;
      readonly loginHint: string;
      /** Environment variables that point the real CLI at this host profile. */
      readonly environment?: (path: string) => Readonly<Record<string, string>>;
      /** Provider-owned entries that must remain outside the ACP process authority. */
      readonly forbiddenEntries?: ReadonlyArray<string>;
    }
  | {
      readonly kind: "credential-file";
      readonly defaultPath: string;
      readonly managedRelativePath: string;
    };

export type AcpConfinementStrategy =
  /** Shared deny-default Seatbelt profile; explicit Full access runs unconfined. */
  { readonly kind: "deny-default-seatbelt" };

export interface AcpProcessProfile {
  /** `agentInfo.name` the ACP `initialize` response must report. */
  readonly agentName: string;
  /** Overrides the default `agentInfo.name` equality check when the agent's `initialize` response identifies itself differently (e.g. via `_meta`). */
  readonly verifyAgentInfo?: (initialized: AcpInitializeResult) => boolean;
  /** `--version` output contract; groups 1-3 are major, minor, patch. */
  readonly versionPattern: RegExp;
  readonly minimumVersion: readonly [number, number, number];
  /** When set, version is read from the matching npm `package.json` instead of `--version`. */
  readonly npmPackageName?: string;
  readonly passthroughVariables: ReadonlyArray<string>;
  readonly guards: Readonly<Record<string, string>>;
  /** User-owned configuration files the provider needs to read, never write. */
  readonly hostReadPaths?: ReadonlyArray<string>;
  /** The CLI starts a same-binary stdio server before serving ACP messages. */
  readonly requiresChildServer?: boolean;
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
  /**
   * Host-profile entries the process may neither read nor write. Used for
   * executable extension surfaces that a reused native profile would otherwise
   * load (MCP, skills, plugins, hooks).
   */
  readonly hostDeniedEntries?: ReadonlyArray<string>;
  /** Project-root entries the agent may neither read nor write. */
  readonly forbiddenRootEntries?: ReadonlyArray<string>;
  readonly confinement: AcpConfinementStrategy;
}

/**
 * A reasoning control the agent publishes and takes outside a session config
 * option.
 *
 * Grok Build is the known case: session/new returns no configOptions at all,
 * each model states its own levels in its own session-metadata entry
 * (availableModels[]._meta.reasoningEfforts), and the level is applied by
 * sending _meta.reasoningEffort with session/new or session/load. The agent's
 * own model call resets a level it did not set, so a level declared here
 * travels with the session that selects the model.
 */
export interface AcpSessionMetaReasoning {
  /** Levels this model advertises for itself, in the agent's own order. */
  readonly levelsOf: (modelMeta: Readonly<Record<string, unknown>>) => ReadonlyArray<string>;
  /** Session metadata that carries a thread's model and chosen level. */
  readonly meta: (input: {
    readonly modelId: string;
    readonly level: string | undefined;
  }) => Readonly<Record<string, unknown>>;
}

export interface AcpProviderProfile {
  readonly kind: AcpProviderKind;
  readonly displayName: string;
  /** Session config option that toggles reasoning, when the agent exposes one. */
  readonly reasoningOptionId: "effort" | "thinking";
  /** Reasoning the agent publishes and takes in the session metadata instead. */
  readonly sessionMetaReasoning?: AcpSessionMetaReasoning;
  /** ACP `mode` config value for a product mode and execution policy. */
  readonly sessionMode: (mode: AcpSessionMode, policy: ProviderExecutionPolicy) => string;
  /** Overrides the default `session/set_config_option` call for setting the model. */
  readonly setModelCall?: (
    sessionId: string,
    modelId: string,
  ) => { readonly method: string; readonly params: Readonly<Record<string, unknown>> };
  /** Overrides the default `session/set_config_option` call for setting the session mode. */
  readonly setModeCall?: (
    sessionId: string,
    mode: string,
  ) => { readonly method: string; readonly params: Readonly<Record<string, unknown>> };
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
  /** Provider-owned CLI login, with delegated browser auth reserved for legacy profiles. */
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

function opencodeConfiguration(executionPolicy: ProviderExecutionPolicy) {
  const sideEffects = executionPolicy === "full-access" ? "allow" : "ask";
  return {
    permissions: [
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: sideEffects },
      { action: "shell", resource: "*", effect: sideEffects },
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "skill", resource: "*", effect: "deny" },
      { action: "question", resource: "*", effect: "deny" },
    ],
  } as const;
}

const opencodeGlobalConfigPaths = [
  join(homedir(), ".config/opencode/opencode.jsonc"),
  join(homedir(), ".config/opencode/opencode.json"),
] as const;

function opencodeGlobalConfigPath(): string {
  return opencodeGlobalConfigPaths.find((path) => existsSync(path)) ?? opencodeGlobalConfigPaths[0];
}

const opencodeProfile: AcpProviderProfile = {
  kind: "opencode",
  displayName: "OpenCode 2",
  reasoningOptionId: "effort",
  sessionMode: (_mode, policy) => (policy === "plan" ? "plan" : "build"),
  chatSessionRoot: "project-root",
  userQuestions: "unsupported",
  resumeMethod: "session/resume",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage: "OpenCode 2 is not authenticated. Run opencode2 auth login, then retry.",
  process: {
    agentName: "OpenCode",
    versionPattern:
      /^opencode2 v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\r?\n?$/,
    minimumVersion: [0, 0, 0],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    requiresChildServer: true,
    hostReadPaths: opencodeGlobalConfigPaths,
    guards: {
      NO_COLOR: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_TERMINAL_TITLE: "1",
      OPENCODE_PURE: "1",
    },
    environment: ({ executionPolicy, managedHome }) => ({
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfiguration(executionPolicy)),
      OPENCODE_CONFIG: opencodeGlobalConfigPath(),
      OPENCODE_CONFIG_DIR: join(managedHome, "config"),
      XDG_CACHE_HOME: join(managedHome, "cache"),
      XDG_CONFIG_HOME: join(managedHome, "config"),
      XDG_STATE_HOME: join(managedHome, "state"),
      TMPDIR: join(managedHome, "tmp"),
    }),
    args: () => ["acp"],
    managedFiles: () => [],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".local/share/opencode"),
      loginHint: "Run opencode2 auth login, then retry.",
      environment: (path) => ({ OPENCODE_DATA_DIR: path }),
    },
    confinement: { kind: "deny-default-seatbelt" },
  },
};

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
  unauthenticatedMessage: "Kilo is not authenticated. Run kilo auth login, then retry.",
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
      environment: (path) => ({ KILO_CONFIG_DIR: path }),
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
  // Devin enables native subagents by default. Octant owns delegation and
  // exposes its own bounded AgentRun surface, so the provider's run_subagent
  // and read_subagent tools must be absent from every managed session.
  subagents_enabled: false,
  auto_update: false,
  notify: "never",
  attribution: false,
} as const;

function devinConfigPath(managedHome: string): string {
  return join(managedHome, ".config/devin/config.json");
}
function devinMcpConfigPath(managedHome: string): string {
  return join(managedHome, ".config/devin/mcp_config.json");
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
  // Devin 3000.10.27 accepts session/new but refuses the optional
  // session/close RPC. Process-scope cleanup still tears down the scratch
  // session without making an otherwise healthy probe fail.
  closesSessions: false,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage:
    "Devin is not authenticated. Run the provider-owned Devin login, then retry.",
  process: {
    agentName: "affogato",
    versionPattern: /^devin (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) \([0-9a-f]+\)\r?\n?$/,
    minimumVersion: [3000, 1, 27],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: { DEVIN_PERMISSION_MODE: "auto", NO_COLOR: "1" },
    environment: ({ managedHome }) => ({ HOME: managedHome }),
    // Devin 3000.4.x removed the standalone --agent-config flag. Passing it
    // makes the CLI exit with usage status before writing an ACP response.
    args: ({ managedHome }) => [
      "--config",
      devinConfigPath(managedHome),
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
        // Devin 3000.3 moved MCP configuration out of config.json. Keep the
        // dedicated managed file empty alongside the ACP session's empty
        // client-provided server list.
        path: devinMcpConfigPath(managedHome),
        content: "{}\n",
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
  // Vibe's ACP mode ids are its agent profile names, and those names moved:
  // `chat` was removed in 2.23.3 and `default` became `ask` in 2.24.1, so the
  // names below and the version floor have to agree. `accept-edits` is never
  // selected: it auto-approves edits inside the agent, which would bypass
  // Octant's approval bridge.
  sessionMode: (mode, policy) => {
    if (mode === "chat") return "ask";
    if (policy === "plan") return "plan";
    if (policy === "full-access") return "auto-approve";
    return "ask";
  },
  chatSessionRoot: "managed-home",
  userQuestions: "unsupported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage:
    "Mistral Vibe is not authenticated. Run the provider-owned Vibe CLI login, then retry.",
  process: {
    agentName: "@mistralai/mistral-vibe",
    versionPattern:
      /^vibe-acp (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\r?\n?$/,
    minimumVersion: [2, 24, 1],
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
      // An allowlist, not `disabled_agents: ["*"]`: Vibe resolves `default_agent`
      // against the disable list before a session exists, so disabling every
      // agent makes `session/new` fail outright (-31002). `enabled_agents` takes
      // precedence over `disabled_agents` and still excludes every discovered
      // third-party agent, and pinning the default to the approval-gated agent
      // keeps a session from opening on an edit-approving one.
      VIBE_ENABLED_AGENTS: '["ask","plan","auto-approve"]',
      VIBE_DEFAULT_AGENT: "ask",
      // Skills have no `default_skill` to resolve, so the deny-all form is safe here.
      VIBE_DISABLED_SKILLS: '["*"]',
    },
    environment: ({ managedHome, apiKey }) => ({
      HOME: managedHome,
      VIBE_HOME: managedHome,
      ...(apiKey === undefined ? {} : { MISTRAL_API_KEY: apiKey }),
    }),
    args: () => [],
    managedFiles: () => [],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".vibe"),
      loginHint: "Run the provider-owned Vibe CLI login, then retry.",
      environment: (path) => ({ VIBE_HOME: path }),
    },
    confinement: { kind: "deny-default-seatbelt" },
  },
};

/**
 * Allowlisted `GROK_CONFIG` overlay. `grok inspect --json` on 1.0.30 accepts a
 * `features` section and ignores `cli` / `session` overlays. Auto-update is
 * suppressed with `GROK_DISABLE_AUTOUPDATER` instead of writing `config.toml`.
 */
const GROK_FEATURE_OVERLAY = {
  features: {
    telemetry: false,
    feedback: false,
    codebase_indexing: false,
    remote_fetch: false,
  },
} as const;

/**
 * Grok Build publishes each model's reasoning levels in the session metadata
 * and takes the chosen one back as _meta.reasoningEffort when a session is
 * created or loaded. Measured on grok 1.0.5 and 1.0.30: session/new reports no
 * configOptions, the reply's model state confirms the level, session/set_mode
 * leaves it alone, and session/set_model resets it to the new model's default.
 */
const grokSessionMetaReasoning: AcpSessionMetaReasoning = {
  levelsOf: (modelMeta) => {
    if (modelMeta["supportsReasoningEffort"] !== true) return [];
    const levels = modelMeta["reasoningEfforts"];
    if (!Array.isArray(levels)) return [];
    return levels.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Readonly<Record<string, unknown>>;
      const value = record["value"] ?? record["id"];
      return typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [];
    });
  },
  meta: ({ modelId, level }) => ({
    modelId,
    ...(level === undefined ? {} : { reasoningEffort: level }),
  }),
};

const grokProfile: AcpProviderProfile = {
  kind: "grok",
  displayName: "Grok Build",
  reasoningOptionId: "thinking",
  sessionMetaReasoning: grokSessionMetaReasoning,
  sessionMode: (mode, policy) => {
    if (mode === "chat") return "default";
    if (policy === "plan") return "plan";
    if (policy === "full-access") return "bypassPermissions";
    return "default";
  },
  chatSessionRoot: "managed-home",
  userQuestions: "supported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  setModelCall: (sessionId, modelId) => ({
    method: "session/set_model",
    params: { sessionId, modelId },
  }),
  setModeCall: (sessionId, mode) => ({
    method: "session/set_mode",
    params: { sessionId, modeId: mode },
  }),
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage:
    "Grok Build is not authenticated. Run grok login (or grok login --device-auth on a headless host), then retry.",
  process: {
    // display-only now; identity is verified via verifyAgentInfo below (real
    // initialize responses have no agentInfo field)
    agentName: "Grok Build",
    verifyAgentInfo: (initialized) =>
      (initialized._meta as Readonly<Record<string, unknown>> | undefined)?.grokShell === true,
    versionPattern:
      /^grok (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)? \([0-9a-f]+\)(?: \[[a-zA-Z]+\])?\r?\n?$/,
    minimumVersion: [1, 0, 0],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: {
      GROK_TELEMETRY_ENABLED: "0",
      GROK_TELEMETRY_TRACE_UPLOAD: "0",
      GROK_TELEMETRY_MIXPANEL_ENABLED: "0",
      GROK_FEEDBACK_ENABLED: "0",
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_MEMORY: "0",
      GROK_SUBAGENTS: "0",
      GROK_WORKFLOWS: "0",
      GROK_SANDBOX: "off",
      NO_COLOR: "1",
    },
    // GROK_HOME is the native profile via hostAuthentication. A managed
    // config.toml is not read once GROK_HOME points at ~/.grok.
    environment: ({ apiKey }) => ({
      GROK_CONFIG: JSON.stringify(GROK_FEATURE_OVERLAY),
      ...(apiKey === undefined ? {} : { XAI_API_KEY: apiKey }),
    }),
    args: () => ["agent", "stdio"],
    managedFiles: () => [],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".grok"),
      loginHint: "Run `grok login` (or `grok login --device-auth` on a headless host), then retry.",
      environment: (path) => ({ GROK_HOME: path }),
    },
    confinement: { kind: "deny-default-seatbelt" },
  },
};

const gooseProfile: AcpProviderProfile = {
  kind: "goose",
  displayName: "Goose",
  reasoningOptionId: "thinking",
  sessionMode: (mode, policy) => {
    if (mode === "chat") return "smart_approve";
    if (policy === "plan") return "approve";
    if (policy === "full-access") return "auto";
    return "smart_approve";
  },
  setModeCall: (sessionId, mode) => ({
    method: "session/set_mode",
    params: { sessionId, modeId: mode },
  }),
  chatSessionRoot: "managed-home",
  userQuestions: "supported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage:
    "Goose is not authenticated. Run `goose configure` in your terminal, then retry.",
  process: {
    agentName: "goose",
    versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\r?\n?$/,
    minimumVersion: [1, 48, 0],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: { NO_COLOR: "1" },
    environment: ({ managedHome }) => ({
      HOME: managedHome,
      XDG_CONFIG_HOME: join(managedHome, ".config"),
      XDG_CACHE_HOME: join(managedHome, ".cache"),
      XDG_DATA_HOME: join(managedHome, ".local/share"),
      XDG_STATE_HOME: join(managedHome, ".local/state"),
    }),
    args: () => ["acp"],
    managedFiles: () => [],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".config/goose"),
      loginHint: "Run `goose configure`, then retry.",
      environment: (path) => ({ XDG_CONFIG_HOME: dirname(path) }),
    },
    confinement: { kind: "deny-default-seatbelt" },
  },
};

const glmProfile: AcpProviderProfile = {
  kind: "glm",
  displayName: "GLM Agent",
  reasoningOptionId: "thinking",
  // `accept_edits` auto-approves edits inside the agent and would bypass Octant's
  // approval bridge, so it is never selected.
  sessionMode: (_mode, policy) => {
    if (policy === "full-access") return "bypass_permissions";
    return "default";
  },
  setModelCall: (sessionId, modelId) => ({
    method: "session/set_model",
    params: { sessionId, modelId },
  }),
  setModeCall: (sessionId, mode) => ({
    method: "session/set_mode",
    params: { sessionId, modeId: mode },
  }),
  chatSessionRoot: "managed-home",
  userQuestions: "supported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage:
    "GLM Agent is not authenticated. Run the provider-owned GLM Agent CLI login, then retry.",
  process: {
    agentName: "glm-acp-agent",
    npmPackageName: "glm-acp-agent",
    versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?\r?\n?$/,
    minimumVersion: [1, 8, 0],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: {
      ACP_GLM_DEBUG: "false",
      NO_COLOR: "1",
    },
    environment: ({ managedHome, apiKey }) => ({
      HOME: managedHome,
      XDG_CONFIG_HOME: join(managedHome, ".config"),
      XDG_CACHE_HOME: join(managedHome, ".cache"),
      XDG_STATE_HOME: join(managedHome, ".local/state"),
      ACP_GLM_SESSION_DIR: join(managedHome, ".local/state/glm-acp-agent/sessions"),
      ...(apiKey === undefined ? {} : { Z_AI_API_KEY: apiKey }),
    }),
    args: () => [],
    managedFiles: () => [],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".config/glm-acp-agent"),
      loginHint: "Run the provider-owned GLM Agent CLI login, then retry.",
      environment: (path) => ({ XDG_CONFIG_HOME: dirname(path) }),
    },
    confinement: { kind: "deny-default-seatbelt" },
  },
};

const geminiProfile: AcpProviderProfile = {
  kind: "gemini",
  displayName: "Gemini CLI",
  reasoningOptionId: "thinking",
  // `autoEdit` auto-approves edits inside the agent and would bypass Octant's
  // approval bridge, so it is never selected.
  sessionMode: (mode, policy) => {
    if (mode === "chat") return "default";
    if (policy === "plan") return "plan";
    if (policy === "full-access") return "yolo";
    return "default";
  },
  setModeCall: (sessionId, mode) => ({
    method: "session/set_mode",
    params: { sessionId, modeId: mode },
  }),
  chatSessionRoot: "managed-home",
  userQuestions: "supported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage:
    "Gemini CLI is not authenticated. Run gemini and complete its provider-owned CLI login, then retry.",
  process: {
    agentName: "gemini-cli",
    versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\r?\n?$/,
    minimumVersion: [0, 58, 0],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: { NO_COLOR: "1" },
    environment: ({ managedHome, apiKey }) => ({
      HOME: managedHome,
      XDG_CONFIG_HOME: join(managedHome, ".config"),
      XDG_DATA_HOME: join(managedHome, ".local/share"),
      XDG_STATE_HOME: join(managedHome, ".local/state"),
      ...(apiKey === undefined ? {} : { GEMINI_API_KEY: apiKey }),
    }),
    args: () => ["--acp"],
    managedFiles: () => [],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".gemini"),
      loginHint: "Run `gemini` and complete its provider-owned CLI login, then retry.",
      // Official Gemini CLI treats GEMINI_CLI_HOME as os.homedir() and creates
      // `.gemini` inside it, so dirname(~/.gemini) is the native login root.
      environment: (path) => ({ GEMINI_CLI_HOME: dirname(path) }),
    },
    confinement: { kind: "deny-default-seatbelt" },
  },
};

const copilotProfile: AcpProviderProfile = {
  kind: "copilot",
  displayName: "GitHub Copilot",
  reasoningOptionId: "thinking",
  sessionMode: () => "default",
  chatSessionRoot: "managed-home",
  userQuestions: "supported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage: "GitHub Copilot is not authenticated. Run `copilot login`, then retry.",
  process: {
    agentName: "Copilot",
    versionPattern: /^GitHub Copilot CLI (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.?\r?\n?$/,
    minimumVersion: [1, 0, 82],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: { NO_COLOR: "1" },
    environment: ({ managedHome }) => ({
      HOME: managedHome,
      XDG_CONFIG_HOME: join(managedHome, ".config"),
    }),
    args: () => ["--acp"],
    managedFiles: () => [],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".copilot"),
      loginHint: "Run `copilot login`, then retry.",
      environment: (path) => ({ COPILOT_HOME: path }),
    },
    confinement: { kind: "deny-default-seatbelt" },
  },
};

const clineProfile: AcpProviderProfile = {
  kind: "cline",
  displayName: "Cline",
  reasoningOptionId: "thinking",
  sessionMode: (_mode, policy) => {
    if (policy === "full-access") return "act";
    return "plan";
  },
  setModeCall: (sessionId, mode) => ({
    method: "session/set_mode",
    params: { sessionId, modeId: mode },
  }),
  chatSessionRoot: "managed-home",
  userQuestions: "supported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage: "Cline is not authenticated. Run cline auth, then retry.",
  process: {
    agentName: "cline",
    versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\r?\n?$/,
    minimumVersion: [3, 0, 61],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: { NO_COLOR: "1" },
    environment: ({ managedHome, apiKey }) => ({
      HOME: managedHome,
      XDG_CONFIG_HOME: join(managedHome, ".config"),
      ...(apiKey === undefined ? {} : { CLINE_API_KEY: apiKey }),
    }),
    args: () => ["--acp"],
    managedFiles: () => [],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".cline", "data"),
      loginHint: "Run `cline auth`, then retry.",
      environment: (path) => ({ CLINE_DATA_DIR: path }),
    },
    confinement: { kind: "deny-default-seatbelt" },
  },
};

const qwenProfile: AcpProviderProfile = {
  kind: "qwen",
  displayName: "Qwen Code",
  reasoningOptionId: "thinking",
  // `auto-edit` and `auto` auto-approve edits inside the agent and would bypass
  // Octant's approval bridge, so they are never selected.
  sessionMode: (mode, policy) => {
    if (mode === "chat") return "default";
    if (policy === "plan") return "plan";
    if (policy === "full-access") return "yolo";
    return "default";
  },
  setModeCall: (sessionId, mode) => ({
    method: "session/set_mode",
    params: { sessionId, modeId: mode },
  }),
  chatSessionRoot: "managed-home",
  userQuestions: "supported",
  resumeMethod: "session/load",
  closesSessions: true,
  authenticateOnProbe: false,
  authentication: { kind: "provider-owned" },
  unauthenticatedMessage:
    "Qwen Code is not authenticated. Run the provider-owned Qwen CLI login, then retry.",
  process: {
    agentName: "qwen-code",
    versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\r?\n?$/,
    minimumVersion: [0, 23, 0],
    passthroughVariables: HOST_PASSTHROUGH_VARIABLES,
    guards: { NO_COLOR: "1" },
    environment: ({ managedHome, apiKey }) => ({
      HOME: managedHome,
      XDG_CONFIG_HOME: join(managedHome, ".config"),
      ...(apiKey === undefined ? {} : { OPENAI_API_KEY: apiKey }),
    }),
    args: () => ["--acp"],
    managedFiles: () => [],
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".qwen"),
      loginHint: "Run the provider-owned Qwen CLI login, then retry.",
      environment: (path) => ({ QWEN_HOME: path }),
    },
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
  unauthenticatedMessage: "Kimi Code is not authenticated. Run kimi login, then retry.",
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
    hostAuthentication: {
      kind: "directory",
      defaultPath: join(homedir(), ".kimi-code"),
      loginHint: "Run `kimi login` in your terminal, then retry.",
      environment: (path) => ({ KIMI_CODE_HOME: path }),
      forbiddenEntries: ["AGENTS.md", "mcp.json", "skills", "plugins", "hooks"],
    },
    // Native KIMI_CODE_HOME loads mcp.json, skills, plugins, hooks, and
    // AGENTS.md. Deny those surfaces in the OS profile so reused login cannot
    // start extra executables; config.toml and credentials stay readable.
    hostDeniedEntries: ["AGENTS.md", "mcp.json", "skills", "plugins", "hooks"],
    forbiddenRootEntries: [".kimi-code", ".agents"],
    // Authentication lives in the provider-owned Kimi data root. The process
    // still runs inside Octant's project/managed-home Seatbelt boundary and
    // the reviewed command inventory remains the authority for ACP commands.
    confinement: { kind: "deny-default-seatbelt" },
  },
};

export const acpProviderProfiles: Readonly<Record<AcpProviderKind, AcpProviderProfile>> = {
  opencode: opencodeProfile,
  kilo: kiloProfile,
  devin: devinProfile,
  "mistral-vibe": vibeProfile,
  "kimi-code": kimiProfile,
  grok: grokProfile,
  goose: gooseProfile,
  glm: glmProfile,
  gemini: geminiProfile,
  copilot: copilotProfile,
  cline: clineProfile,
  qwen: qwenProfile,
};

export function isAcpProviderKind(kind: ProviderDriverKind): kind is AcpProviderKind {
  return kind in acpProviderProfiles;
}
