import { trackSandboxChild } from "../process/sandboxRuntimePolicy";
import type { SandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import { createHash } from "node:crypto";
import { stopWindowsProcessTree } from "../process/windowsProcessTree";
import { providerHostEnvironment } from "./providerHostEnvironment";
import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ProviderExecutionPolicy,
  ProviderFailure,
  ProviderToolDefinition,
} from "@octant/contracts";
import { Effect, type Scope } from "effect";
import { versionAtLeast } from "./acpProcess";
import { approvedHomeBinDirs } from "./discoveryService";
import { makePiRpcClient, type PiRpcClient } from "./piRpcClient";
import type { ProviderProcessStartedListener } from "./providerRuntimeRegistry";
import {
  makeProcessConfinementLive,
  ProcessConfinementError,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import {
  execVersionRead,
  prepareConfinedVersionProbe,
  type ConfinedVersionProbeLaunch,
} from "../process/confinedVersionProbe";
import {
  resolveWindowsProviderProgram,
  windowsUnconfinedLaunch,
} from "../process/windowsProviderProgram";
import { windowsProviderLaunch, type WindowsProviderLaunch } from "@octant/domain/guardrail-policy";
import {
  materializeOsNetworkEgress,
  resolveProviderRuntimeEgressPolicy,
} from "../process/threadEgressPolicy";
import type { PiManagedToolBridgeConfig } from "./piManagedTools";
import {
  acquireProviderRuntimeNetwork,
  type ProviderRuntimeNetworkPort,
  type ProviderRuntimeProxiedNetwork,
  acquireProviderServerAccess,
  serverAccessSeatbeltRules,
  withServerAccess,
  type ProviderServerAccess,
  type ProviderServerAccessPort,
} from "../network/providerRuntimeNetwork";

export type PiSessionMode = "chat" | "work" | "code";

export interface PiLaunchSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface PiConfinementPort {
  readonly prepare: (input: {
    /** The launch's own egress proxy below Full access; absent keeps open network. */
    readonly network?: ProviderRuntimeProxiedNetwork;
    /** The folder through which Pi's own `ssh` reaches the Project's registered servers. */
    readonly servers?: ProviderServerAccess;
    readonly binaryPath: string;
    readonly root: string;
    /** The Project's extra folders, granted what `root` is granted. */
    readonly extraFolders?: ReadonlyArray<string>;
    readonly piHome: string;
    readonly sessionDirectory: string;
    readonly sessionId: string;
    readonly resume?: boolean;
    readonly mode: PiSessionMode;
    readonly executionPolicy: ProviderExecutionPolicy;
    /**
     * A Full access thread that keeps the sandbox: approvals stay off as at
     * Full access, but the launch takes the wall, network and server access
     * Accept edits has. Absent, Full access launches unwrapped.
     */
    readonly fullAccessSandbox?: boolean;
    readonly sandboxPolicy?: SandboxPolicySelection;
    /** Whether the launch is Strict; absent is Strict. */
    readonly strict?: boolean;
    readonly environment: NodeJS.ProcessEnv;
    readonly tools?: ReadonlyArray<ProviderToolDefinition>;
    readonly toolBridge?: PiManagedToolBridgeConfig;
    /** The release read before launch; it decides how tools are selected. */
    readonly version?: string;
  }) => Effect.Effect<PiLaunchSpec, ProviderFailure>;
}

export interface PiRpcConnection {
  readonly version: string;
  readonly pid: number;
  readonly root: string;
  readonly rpc: PiRpcClient;
  readonly exited: Promise<void>;
}

export interface PiProcessPort {
  readonly start: (input: {
    readonly binaryPath: string;
    readonly root: string;
    /** The Project's extra folders, granted what `root` is granted. */
    readonly extraFolders?: ReadonlyArray<string>;
    readonly piHome: string;
    readonly sessionDirectory: string;
    readonly sessionId: string;
    readonly resume?: boolean;
    readonly mode: PiSessionMode;
    readonly executionPolicy: ProviderExecutionPolicy;
    /**
     * A Full access thread that keeps the sandbox: approvals stay off as at
     * Full access, but the launch takes the wall, network and server access
     * Accept edits has. Absent, Full access launches unwrapped.
     */
    readonly fullAccessSandbox?: boolean;
    readonly sandboxPolicy?: SandboxPolicySelection;
    /**
     * Whether the launch is Strict; absent is Strict. Off, the process gets the
     * host's environment less Octant's variables and other providers' keys,
     * and Pi's telemetry follows the person's own setting.
     */
    readonly strict?: boolean;
    /** The Pi provider the thread's model runs on; only its credentials reach the process. */
    readonly modelProvider?: string;
    readonly onProcessStarted?: ProviderProcessStartedListener;
    readonly tools?: ReadonlyArray<ProviderToolDefinition>;
    readonly toolBridge?: PiManagedToolBridgeConfig;
  }) => Effect.Effect<PiRpcConnection, ProviderFailure, Scope.Scope>;
}

export interface PiConfinementOptions {
  readonly platform?: NodeJS.Platform;
  readonly sandboxPath?: string;
  readonly temporaryDirectory?: string;
  readonly credentialPath?: string;
  readonly modelsPath?: string;
  /** The person's own Pi agent folder; defaults to `~/.pi/agent`. */
  readonly ownSetupPath?: string;
}

export interface PiProcessOptions {
  readonly confinement?: PiConfinementPort;
  /** Confinement for the version read, which the runtime's port does not cover. */
  readonly versionProbeConfinement?: ProcessConfinementPort;
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly shutdownTimeoutMs?: number;
  readonly versionTimeoutMs?: number;
  /** Routes the runtime through its own egress proxy below Full access. */
  readonly runtimeNetwork?: ProviderRuntimeNetworkPort;
  /** The Project's registered servers, for the runtime's own `ssh` below Full access. */
  readonly serverAccess?: ProviderServerAccessPort;
  /** The host's platform; defaults to the running one. */
  readonly platform?: NodeJS.Platform;
}

/** How one Pi launch runs on Windows, from that launch's own authority. */
function piWindowsLaunch(input: {
  readonly mode: PiSessionMode;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly fullAccessSandbox?: boolean;
  readonly strict?: boolean;
  readonly sandboxPolicy?: SandboxPolicySelection;
}): WindowsProviderLaunch {
  return windowsProviderLaunch({
    mode: input.mode,
    executionPolicy: input.executionPolicy,
    fullAccessSandbox: input.fullAccessSandbox,
    strict: input.sandboxPolicy === undefined ? input.strict : true,
  });
}

// The bridge asks for every tool but these known reads and Octant's own tools,
// which the host decides, so a tool an extension registers asks by the level.
const KNOWN_READ_TOOLS = ["read", "grep", "find", "ls"] as const;
const ALL_TOOLS = "bash,edit,write,read,grep,find,ls";
const BUILT_IN_TOOL_NAMES = new Set(ALL_TOOLS.split(","));
const READ_TOOLS = "read,grep,find,ls";
const SAFE_ENVIRONMENT = new Set([
  "COLORTERM",
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
]);
// Keyed by the Pi provider id, the part of a model ID before the "/". A Pi
// process reads a provider's key from the variables Pi names for that provider,
// so a thread is handed those and no other provider's: with every key passed, a
// model-generated command in an Anthropic thread could read `OPENAI_API_KEY`. A
// provider missing here (an OAuth login kept in `auth.json`, for one) gets no
// host variable and authenticates from its linked `auth.json`. That includes a
// custom `models.json` provider whose `apiKey` is `$SOME_VARIABLE`: Pi 0.85.1
// leaves such a provider's models out of the list when the variable is unset,
// so it needs a literal `apiKey` or a `/login` to be selectable. A Map, because
// the key is text from a model ID and must never resolve on the prototype.
const PROVIDER_CREDENTIALS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["airouter", ["AIROUTER_API_KEY"]],
  ["anthropic", ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]],
  // Pi 1.0.3 renamed this provider from `azure-openai-responses` to `azure`
  // and kept the variables, so each release finds its own name here.
  [
    "azure-openai-responses",
    ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME"],
  ],
  ["azure", ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME"]],
  ["deepseek", ["DEEPSEEK_API_KEY"]],
  ["google", ["GEMINI_API_KEY", "GOOGLE_API_KEY"]],
  ["groq", ["GROQ_API_KEY"]],
  ["mistral", ["MISTRAL_API_KEY"]],
  ["openai", ["OPENAI_API_KEY", "OPENAI_BASE_URL"]],
  ["openrouter", ["OPENROUTER_API_KEY"]],
  ["xai", ["XAI_API_KEY"]],
]);
const APPROVAL_BRIDGE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const knownReads = new Set(${JSON.stringify(KNOWN_READ_TOOLS)});

export default function octantApprovalBridge(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (knownReads.has(event.toolName)) return undefined;
    if (process.env.OCTANT_PI_APPROVALS === "disabled") return undefined;
    if (!ctx.hasUI || typeof event.toolCallId !== "string" || event.toolCallId.length === 0) {
      return { block: true, reason: "Octant approval unavailable" };
    }
    const approved = await ctx.ui.confirm(
      \`Octant approval:\${event.toolCallId}:\${event.toolName}\`,
      "Allow this side effect for the current session?",
    );
    return approved ? undefined : { block: true, reason: "Octant approval denied" };
  });
}
`;

function javascriptLiteral(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Pi extension data could not be serialized.");
  return serialized.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function piExtensionSource(tools: ReadonlyArray<ProviderToolDefinition>): string {
  if (tools.length === 0) return APPROVAL_BRIDGE;
  const catalogAttestation = piToolCatalogAttestation(tools);
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const definitions = ${javascriptLiteral(tools)};
const bridgeUrl = process.env.OCTANT_PI_TOOL_BRIDGE_URL;
const bridgeToken = process.env.OCTANT_PI_TOOL_BRIDGE_TOKEN;
const catalogAttestation = "${catalogAttestation}";
const knownReads = new Set(${javascriptLiteral(KNOWN_READ_TOOLS)});
const octantTools = new Set(definitions.map((definition) => definition.name));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function octantManagedTools(pi: ExtensionAPI) {
  if (bridgeUrl !== undefined && bridgeToken !== undefined) {
    pi.registerCommand("octant-tool-attestation", {
      description: \`Octant managed tool catalog \${catalogAttestation}\`,
      handler: async () => undefined,
    });
    for (const definition of definitions) {
      pi.registerTool({
        name: definition.name,
        label: \`Octant \${definition.name}\`,
        description: definition.description ?? \`Octant-managed \${definition.name}\`,
        parameters: definition.inputSchema,
        async execute(toolCallId, params, signal) {
          if (signal?.aborted) throw new Error("Octant tool interrupted.");
          const response = await fetch(bridgeUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-octant-pi-token": bridgeToken,
            },
            body: JSON.stringify({ toolCallId, name: definition.name, input: params }),
            signal,
          });
          if (!response.ok) throw new Error("Octant tool bridge rejected the request.");
          const result: unknown = await response.json();
          if (!isRecord(result) || typeof result.resultJson !== "string" || typeof result.isError !== "boolean") {
            throw new Error("Octant tool bridge returned an invalid result.");
          }
          if (result.isError) throw new Error(result.resultJson);
          const images = result.images === undefined ? [] : result.images;
          if (!Array.isArray(images) || images.length > 4 || images.some((image) => !isRecord(image) || !["image/png", "image/jpeg"].includes(String(image.mimeType)) || typeof image.data !== "string" || image.data.length > 2097152)) throw new Error("Octant tool images are invalid.");
          return { content: [{ type: "text", text: result.resultJson }, ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))], details: {} };
        },
      });
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    if (knownReads.has(event.toolName) || octantTools.has(event.toolName)) return undefined;
    if (process.env.OCTANT_PI_APPROVALS === "disabled") return undefined;
    if (!ctx.hasUI || typeof event.toolCallId !== "string" || event.toolCallId.length === 0) {
      return { block: true, reason: "Octant approval unavailable" };
    }
    const approved = await ctx.ui.confirm(
      \`Octant approval:\${event.toolCallId}:\${event.toolName}\`,
      "Allow this side effect for the current session?",
    );
    return approved ? undefined : { block: true, reason: "Octant approval denied" };
  });
}
`;
}

export function piToolCatalogAttestation(tools: ReadonlyArray<ProviderToolDefinition>): string {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 32);
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

/** Static switches every Pi launch under Strict sets; the version read keeps them too. */
const PI_GUARDS = { PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" } as const;

/**
 * What a launch outside Strict still sets: the release check stays off,
 * because Octant installs and updates provider CLIs itself. Pi's telemetry
 * follows the person's own setting (Architecture: "Octant adds no
 * restrictions of its own unless Strict is on").
 */
const OPEN_PI_GUARDS = { PI_SKIP_VERSION_CHECK: "1" } as const;

// `modelProvider` is the Pi provider a thread runs its model on. A discovery
// run has no thread, so it names none and holds no provider credential.
export function sanitizePiEnvironment(
  host: NodeJS.ProcessEnv,
  piHome: string,
  approvals: "enabled" | "disabled" = "enabled",
  modelProvider?: string,
  strict = true,
): NodeJS.ProcessEnv {
  const credentials = new Set(
    modelProvider === undefined ? [] : (PROVIDER_CREDENTIALS.get(modelProvider) ?? []),
  );
  if (!strict) {
    // The thread's own provider's variables are its own; Pi's account home
    // stays Octant's, so the account it signs in as stays the thread's.
    return {
      ...providerHostEnvironment(host, credentials),
      HOME: piHome,
      PI_CODING_AGENT_DIR: piHome,
      ...OPEN_PI_GUARDS,
      OCTANT_PI_APPROVALS: approvals,
      NO_COLOR: "1",
    };
  }
  return Object.fromEntries([
    ...Object.entries(host).filter(
      ([key, value]) =>
        value !== undefined &&
        (SAFE_ENVIRONMENT.has(key) || credentials.has(key) || key.startsWith("LC_")),
    ),
    ["HOME", piHome],
    ["PI_CODING_AGENT_DIR", piHome],
    ...Object.entries(PI_GUARDS),
    ["OCTANT_PI_APPROVALS", approvals],
    ["NO_COLOR", "1"],
  ]);
}

// The GUI PATH does not include user bin directories, so a `#!env node`-style
// shim resolves nothing. The binary's own directory is where its runtime
// siblings live, and the approved home bin directories are the same allowlist
// discovery already trusts — together they join PATH ahead of the inherited
// entries so a registered provider actually starts.
export function piProcessEnvironment(
  binaryPath: string,
  host: NodeJS.ProcessEnv,
  piHome: string,
  approvals: "enabled" | "disabled" = "enabled",
  modelProvider?: string,
  strict = true,
): NodeJS.ProcessEnv {
  const sanitized = sanitizePiEnvironment(host, piHome, approvals, modelProvider, strict);
  const binaryDirectory = dirname(binaryPath);
  const path = sanitized.PATH?.split(delimiter).filter(Boolean) ?? [];
  const searched = [binaryDirectory, ...approvedHomeBinDirs(host.HOME), ...path];
  return {
    ...sanitized,
    PATH: [...new Set(searched)].join(delimiter),
  };
}

/**
 * The posture Pi's wall is built for. A Full access thread that keeps the
 * sandbox is confined as Accept edits is (writes held to the Project, shell
 * allowed, guarded network); its approvals and tools stay Full access's.
 */
function piWallPolicy(input: {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly fullAccessSandbox?: boolean;
  readonly sandboxPolicy?: SandboxPolicySelection;
}): ProviderExecutionPolicy {
  return input.executionPolicy === "full-access" && input.fullAccessSandbox === true
    ? "auto-accept-edits"
    : input.executionPolicy;
}

/**
 * What of the person's own Pi setup a launch loads. Pi runs as it does on its
 * own (maintainer decision, 2026-11-14), so Work and Code load the person's
 * skills, prompt templates and context files at every level, and their
 * extensions outside Plan. Pi is not a key provider, so no account or thread
 * switch reaches this driver: the default is set here. Plan stays read-only:
 * an extension is code that runs in Pi's own process, so Plan loads none and
 * keeps read, grep, find and ls only. Chat has no tools and loads none of it.
 * The person's extension tools stay outside the `--tools` list, which names
 * Pi's built-ins and Octant's own tools, so the approval bridge still decides
 * every side effect below Full access.
 *
 * Pi's own discovery stays off (`--no-extensions`, `--no-skills`,
 * `--no-prompt-templates`) and the person's resources are named by path:
 * discovery would also start Pi's built-in extensions, its MCP client among
 * them, and a Project's own `.pi` resources are a Project's code, which Pi
 * is never trusted with here. Context files are Pi's own discovery, since a
 * Project's `AGENTS.md` is instruction text every runtime may read; the
 * person's global one is linked into the managed home where Pi looks for it.
 */
export function piOwnSetup(
  mode: PiSessionMode,
  executionPolicy: ProviderExecutionPolicy,
): { readonly resources: boolean; readonly extensions: boolean } {
  const resources = mode !== "chat";
  return { resources, extensions: resources && executionPolicy !== "plan" };
}

/** The person's own Pi resources found in their agent folder, by absolute path. */
export interface PiOwnResources {
  readonly skills?: string;
  readonly prompts?: string;
  /** Each top-level extension file or folder, as Pi's own discovery would find it. */
  readonly extensions: ReadonlyArray<string>;
}

const NO_OWN_RESOURCES: PiOwnResources = { extensions: [] };

/** Octant's approval and tool bridge, written into the managed home for each launch. */
export const PI_BRIDGE_FILE_NAME = "octant-approval-bridge.ts";

/**
 * What the person keeps in their Pi agent folder that a launch may load. Their
 * sessions, settings, credentials and installed packages are not read here.
 */
export function readPiOwnResources(ownSetupPath: string): PiOwnResources {
  const directory = (name: string): string | undefined => {
    const path = join(ownSetupPath, name);
    try {
      return statSync(path).isDirectory() ? path : undefined;
    } catch {
      return undefined;
    }
  };
  const extensionsDirectory = directory("extensions");
  let extensions: ReadonlyArray<string> = [];
  if (extensionsDirectory !== undefined) {
    try {
      extensions = readdirSync(extensionsDirectory, { withFileTypes: true })
        .filter(
          (entry) =>
            !entry.name.startsWith(".") &&
            (entry.isDirectory() || (entry.isFile() && /\.(?:ts|js)$/u.test(entry.name))),
        )
        .map((entry) => join(extensionsDirectory, entry.name))
        .sort();
    } catch {
      extensions = [];
    }
  }
  const skills = directory("skills");
  const prompts = directory("prompts");
  return {
    ...(skills === undefined ? {} : { skills }),
    ...(prompts === undefined ? {} : { prompts }),
    extensions,
  };
}

/** Pi's default tools (`DEFAULT_TOOL_NAMES`), which a `+name` list builds on. */
const PI_DEFAULT_TOOLS: ReadonlySet<string> = new Set(["read", "bash", "edit", "write"]);

/** Whether this Pi release reads `+name` entries in `--tools` (added in 1.1.0). */
export function piTakesToolModifiers(version: string | undefined): boolean {
  const match = version === undefined ? null : /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) return false;
  return versionAtLeast([Number(match[1]), Number(match[2]), Number(match[3])], [1, 1, 0]);
}

/** The selection as additions to Pi's own defaults. */
function piToolModifiers(selected: ReadonlyArray<string>): ReadonlyArray<string> {
  return [
    ...selected.filter((name) => !PI_DEFAULT_TOOLS.has(name)).map((name) => `+${name}`),
    ...[...PI_DEFAULT_TOOLS].filter((name) => !selected.includes(name)).map((name) => `-${name}`),
  ];
}

export function piArguments(
  bridgePath: string,
  sessionDirectory: string,
  sessionId: string,
  mode: PiSessionMode,
  executionPolicy: ProviderExecutionPolicy,
  appToolNames: ReadonlyArray<string> = [],
  resumePath?: string,
  ownResources: PiOwnResources = NO_OWN_RESOURCES,
  version?: string,
): ReadonlyArray<string> {
  // Work and Code share one capability set at the thread's level, so a Work
  // session starts with Pi's bash as a Code session does.
  const builtInTools =
    mode === "chat"
      ? []
      : executionPolicy === "plan"
        ? READ_TOOLS.split(",")
        : ALL_TOOLS.split(",");
  const selectedTools = [...builtInTools, ...appToolNames];
  const own = piOwnSetup(mode, executionPolicy);
  // A plain `--tools` list is an allowlist that also leaves every tool an
  // extension registers unregistered. Where the person's extensions load,
  // a release that takes `+name` entries (1.1.0 on) is given its default
  // tools plus these instead, with no allowlist, so their tools are offered
  // as in Pi itself; the bridge asks for each one by the thread's level. An
  // older or unknown release keeps the allowlist.
  const extensionTools =
    own.extensions && ownResources.extensions.length > 0 && piTakesToolModifiers(version);
  const tools =
    selectedTools.length === 0
      ? ["--no-tools"]
      : extensionTools
        ? ["--tools", piToolModifiers(selectedTools).join(",")]
        : ["--tools", selectedTools.join(",")];
  return [
    "--mode",
    "rpc",
    "--no-approve",
    "--no-extensions",
    "--extension",
    bridgePath,
    ...(own.extensions ? ownResources.extensions.flatMap((path) => ["--extension", path]) : []),
    "--no-skills",
    "--no-prompt-templates",
    ...(own.resources && ownResources.skills !== undefined ? ["--skill", ownResources.skills] : []),
    ...(own.resources && ownResources.prompts !== undefined
      ? ["--prompt-template", ownResources.prompts]
      : []),
    "--no-themes",
    ...(own.resources ? [] : ["--no-context-files"]),
    ...tools,
    "--session-dir",
    sessionDirectory,
    ...(resumePath === undefined ? ["--session-id", sessionId] : ["--session", resumePath]),
  ];
}

function existingPiHistory(directory: string, sessionId: string, root: string): string | undefined {
  const matches = readdirSync(directory).filter((name) => name.endsWith(`_${sessionId}.jsonl`));
  if (matches.length !== 1) return undefined;
  const name = matches[0];
  if (name === undefined) return undefined;
  const path = join(directory, name);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) return undefined;
    const buffer = Buffer.alloc(8192);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, length).toString("utf8").split("\n")[0];
    if (line === undefined) return undefined;
    const header: unknown = JSON.parse(line);
    if (
      typeof header !== "object" ||
      header === null ||
      !("type" in header) ||
      header.type !== "session" ||
      !("id" in header) ||
      header.id !== sessionId ||
      !("cwd" in header) ||
      header.cwd !== root
    )
      return undefined;
    return path;
  } finally {
    closeSync(descriptor);
  }
}

function validateBinary(binaryPath: string): ProviderFailure | undefined {
  if (!isAbsolute(binaryPath) || resolve(binaryPath) !== binaryPath) {
    return failure("invalid-configuration", "Pi binary path must be absolute and normalized.");
  }
  try {
    if (!statSync(binaryPath).isFile()) throw new Error();
    accessSync(binaryPath, constants.X_OK);
  } catch {
    return failure("invalid-configuration", "Pi binary path must reference an executable file.");
  }
  return undefined;
}

function managedDirectory(path: string, label: string): Effect.Effect<string, ProviderFailure> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return Effect.fail(
      failure("invalid-configuration", `${label} must be absolute and normalized.`),
    );
  }
  return Effect.try({
    try: () => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
      const canonical = realpathSync(path);
      if (canonical !== path || !statSync(canonical).isDirectory()) throw new Error();
      return canonical;
    },
    catch: () => failure("invalid-configuration", `${label} must be a canonical directory.`),
  });
}

function existingDirectory(path: string, label: string): Effect.Effect<string, ProviderFailure> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return Effect.fail(
      failure("invalid-configuration", `${label} must be absolute and normalized.`),
    );
  }
  return Effect.try({
    try: () => {
      const canonical = realpathSync(path);
      if (canonical !== path || !statSync(canonical).isDirectory()) throw new Error();
      return canonical;
    },
    catch: () => failure("invalid-configuration", `${label} must be a canonical directory.`),
  });
}

function temporaryDirectory(path: string): Effect.Effect<string, ProviderFailure> {
  if (!isAbsolute(path)) {
    return Effect.fail(
      failure("invalid-configuration", "Pi temporary directory must be absolute."),
    );
  }
  return Effect.try({
    try: () => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      const canonical = realpathSync(path);
      if (!statSync(canonical).isDirectory()) throw new Error();
      return canonical;
    },
    catch: () => failure("invalid-configuration", "Pi temporary directory must be a directory."),
  });
}

function loopbackBridgeRule(
  bridge: PiManagedToolBridgeConfig | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (bridge === undefined || platform !== "darwin") return undefined;
  let url: URL;
  try {
    url = new URL(bridge.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return `(allow network-outbound (remote ip "localhost:${port}"))`;
}

function prepareProviderOwnedLink(piHome: string, sourcePath: string, fileName: string): void {
  const target = join(piHome, fileName);
  if (!existsSync(sourcePath)) return;
  if (!existsSync(target) && !lstatExists(target)) {
    try {
      symlinkSync(sourcePath, target);
    } catch (error) {
      // Windows lets a standard account create a file symlink only in
      // Developer Mode (EPERM otherwise); a hard link to the same file needs no
      // privilege and reads and writes the same bytes.
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM")
        throw error;
      linkSync(sourcePath, target);
    }
    return;
  }
  if (process.platform === "win32" && !lstatSync(target).isSymbolicLink()) {
    if (!sameFile(target, sourcePath)) throw new Error();
    return;
  }
  if (
    !lstatSync(target).isSymbolicLink() ||
    resolve(dirname(target), readlinkSync(target)) !== sourcePath
  ) {
    throw new Error();
  }
}

function sameFile(left: string, right: string): boolean {
  const a = statSync(left);
  const b = statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function packageRootAbove(directory: string): string | undefined {
  let current = directory;
  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function makePiConfinementLive(options: PiConfinementOptions = {}): PiConfinementPort {
  const platform = options.platform ?? process.platform;
  const sandboxPath =
    options.sandboxPath ?? (platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap");
  const credentialPath = options.credentialPath ?? join(homedir(), ".pi/agent/auth.json");
  const modelsPath = options.modelsPath ?? join(homedir(), ".pi/agent/models.json");
  const ownSetupPath = options.ownSetupPath ?? join(homedir(), ".pi/agent");
  return {
    prepare: (input) =>
      Effect.gen(function* () {
        const invalid = validateBinary(input.binaryPath);
        if (invalid !== undefined) return yield* Effect.fail(invalid);
        if (!/^[A-Za-z0-9._-]+$/.test(input.sessionId)) {
          return yield* Effect.fail(
            failure("invalid-configuration", "Pi session identity is invalid."),
          );
        }
        const piHome = yield* managedDirectory(input.piHome, "Pi managed home");
        const sessionDirectory = yield* managedDirectory(
          input.sessionDirectory,
          "Pi session directory",
        );
        const root =
          input.root === piHome ? piHome : yield* existingDirectory(input.root, "Pi Project root");
        const resumePath =
          input.resume === true
            ? yield* Effect.try({
                try: () => existingPiHistory(sessionDirectory, input.sessionId, root),
                catch: () => failure("stale-resume", "Pi native history could not be verified."),
              })
            : undefined;
        if (input.resume === true && resumePath === undefined)
          return yield* Effect.fail(
            failure("stale-resume", "Pi native history is missing or belongs to another Project."),
          );
        const tools = input.tools ?? [];
        if (tools.length > 0 && input.toolBridge === undefined) {
          return yield* Effect.fail(
            failure("invalid-configuration", "Pi app-managed tool bridge is missing."),
          );
        }
        if (tools.some((tool) => !/^[A-Za-z0-9_-]+$/.test(tool.name))) {
          return yield* Effect.fail(
            failure("invalid-configuration", "Pi app-managed tool name is not CLI-safe."),
          );
        }
        const names = tools.map((tool) => tool.name);
        if (
          new Set(names).size !== names.length ||
          names.some((name) => BUILT_IN_TOOL_NAMES.has(name))
        ) {
          return yield* Effect.fail(
            failure("invalid-configuration", "Pi app-managed tool name collides with a built-in."),
          );
        }
        const bridgePath = join(piHome, PI_BRIDGE_FILE_NAME);
        yield* Effect.try({
          try: () => {
            writeFileSync(
              join(piHome, "settings.json"),
              `${JSON.stringify({ defaultProjectTrust: "never", enableInstallTelemetry: false }, null, 2)}\n`,
              { mode: 0o600 },
            );
            writeFileSync(bridgePath, piExtensionSource(tools), { mode: 0o600 });
            chmodSync(bridgePath, 0o600);
            prepareProviderOwnedLink(piHome, credentialPath, "auth.json");
            prepareProviderOwnedLink(piHome, modelsPath, "models.json");
            // Pi reads its global context file from its agent folder, which is
            // the managed home; `--no-context-files` keeps Chat from reading it.
            prepareProviderOwnedLink(piHome, join(ownSetupPath, "AGENTS.md"), "AGENTS.md");
          },
          catch: () =>
            failure("invalid-configuration", "Pi managed configuration could not be prepared."),
        });
        const approvals = input.executionPolicy === "full-access" ? "disabled" : "enabled";
        const environment = {
          ...input.environment,
          OCTANT_PI_APPROVALS: approvals,
          ...(input.toolBridge === undefined
            ? {}
            : {
                OCTANT_PI_TOOL_BRIDGE_URL: input.toolBridge.url,
                OCTANT_PI_TOOL_BRIDGE_TOKEN: input.toolBridge.token,
              }),
        };
        const bridgeRule = loopbackBridgeRule(input.toolBridge, platform);
        if (input.toolBridge !== undefined && platform === "darwin" && bridgeRule === undefined) {
          return yield* Effect.fail(
            failure("invalid-configuration", "Pi app-managed tool bridge must be loopback HTTP."),
          );
        }
        const own = piOwnSetup(input.mode, input.executionPolicy);
        const ownResources = own.resources ? readPiOwnResources(ownSetupPath) : NO_OWN_RESOURCES;
        const args = piArguments(
          bridgePath,
          sessionDirectory,
          input.sessionId,
          input.mode,
          input.executionPolicy,
          tools.map((tool) => tool.name),
          resumePath,
          ownResources,
          input.version,
        );
        const wall = piWallPolicy(input);
        if (platform === "win32") {
          // Windows has no Octant sandbox: Full access, or a level below it
          // outside Strict, where Pi's approval bridge still asks Octant for
          // every side effect and Plan keeps its read-only tools, starts
          // unconfined; anything else is refused by name.
          const form = piWindowsLaunch(input);
          if (form.status === "refused") {
            return yield* Effect.fail(failure("incompatible", form.reason));
          }
          const program = resolveWindowsProviderProgram({
            displayName: "Pi",
            executable: input.binaryPath,
            args,
            environment,
          });
          if (program.status === "refused") {
            return yield* Effect.fail(failure("invalid-configuration", program.message));
          }
          return { command: program.command, args: [...program.args], cwd: root, environment };
        }
        if (
          wall === "full-access" &&
          input.sandboxPolicy === undefined &&
          input.fullAccessSandbox !== true
        ) {
          return { command: input.binaryPath, args, cwd: root, environment };
        }
        const temporaryDirectoryPath = yield* temporaryDirectory(
          options.temporaryDirectory ?? input.environment.TMPDIR ?? "/tmp",
        );
        const resolvedBinaryPath = realpathSync(input.binaryPath);
        // The configured path can be a launcher link; the kernel needs
        // read-metadata on that link before it can resolve to the realpath.
        const configuredBinaryDirectory = dirname(input.binaryPath);
        const packageRoot = packageRootAbove(dirname(resolvedBinaryPath));
        const networkEgress =
          input.network === undefined
            ? materializeOsNetworkEgress(
                resolveProviderRuntimeEgressPolicy({
                  mode: input.mode,
                  executionPolicy: wall,
                }),
              )
            : ({ kind: "proxied", endpoint: input.network.endpoint } as const);
        // On Linux a proxied capsule reaches the bridge through the forwarder's
        // loopback relay; with no proxy there is nothing to carry it.
        const linuxBridgeRelay =
          input.toolBridge !== undefined &&
          platform === "linux" &&
          typeof networkEgress === "object"
            ? loopbackPortOf(input.toolBridge)
            : [];
        if (
          input.toolBridge !== undefined &&
          platform === "linux" &&
          networkEgress !== "allow" &&
          linuxBridgeRelay.length === 0
        ) {
          return yield* Effect.fail(
            failure(
              "incompatible",
              "Pi app-managed tools require a shared Linux network namespace.",
            ),
          );
        }
        const credentialPaths = [
          ...(existsSync(credentialPath) ? [credentialPath] : []),
          ...(existsSync(modelsPath) ? [modelsPath] : []),
        ];
        // The person's resources live in their home, which the wall otherwise
        // keeps private; only what this launch loads is opened, read-only.
        const globalContext = join(ownSetupPath, "AGENTS.md");
        const ownSetupPaths = own.resources
          ? [
              ...(ownResources.skills === undefined ? [] : [ownResources.skills]),
              ...(ownResources.prompts === undefined ? [] : [ownResources.prompts]),
              ...(own.extensions ? ownResources.extensions : []),
              ...(existsSync(globalContext) ? [globalContext] : []),
            ]
          : [];
        const confinement = makeProcessConfinementLive({
          platform,
          sandboxPath,
        });
        const launch = yield* Effect.try({
          try: () =>
            confinement.prepare({
              executable: input.binaryPath,
              args,
              boundRoot: root,
              sandboxProviderChannel: true,
              ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
              ...(input.mode === "chat" || input.extraFolders === undefined
                ? {}
                : { extraBoundRoots: input.extraFolders }),
              temporaryDirectory: temporaryDirectoryPath,
              networkEgress,
              writeBoundRoot: !(input.executionPolicy === "plan" || input.mode === "chat"),
              additionalWriteRoots: [piHome],
              allowFileReadStar: true,
              // Outside Strict Pi's own tools may use the protected files
              // inside its folders, other providers' sign-ins excepted.
              ...(input.strict === false &&
              input.fullAccessSandbox !== true &&
              input.sandboxPolicy === undefined
                ? { protectedFiles: "provider-sign-ins" as const }
                : {}),
              // Work declares shell "denied"; an in-process provider shell
              // emits no permission request, so the jail itself must refuse
              // to spawn it.
              allowProcessExec: !(input.executionPolicy === "plan" || input.mode === "chat"),
              allowProcessFork: !(input.executionPolicy === "plan" || input.mode === "chat"),
              ...(input.environment?.PATH === undefined
                ? {}
                : { interpreterSearchPath: input.environment.PATH }),
              readRoots: [
                root,
                piHome,
                ...(packageRoot === undefined ? [] : [packageRoot]),
                temporaryDirectoryPath,
                ...credentialPaths,
                ...ownSetupPaths,
                ...(input.servers === undefined ? [] : [input.servers.folder]),
              ],
              privateHomeAllowPaths: [
                root,
                piHome,
                resolvedBinaryPath,
                configuredBinaryDirectory,
                ...(packageRoot === undefined ? [] : [packageRoot]),
                ...credentialPaths,
                ...ownSetupPaths,
                ...(input.servers === undefined ? [] : [input.servers.folder]),
              ],
              ...(platform === "darwin" && (bridgeRule !== undefined || input.servers !== undefined)
                ? {
                    extraRules: [
                      ...(bridgeRule === undefined ? [] : [bridgeRule]),
                      ...serverAccessSeatbeltRules(input.servers),
                    ],
                  }
                : {}),
              ...(linuxBridgeRelay.length === 0 ? {} : { loopbackRelayPorts: linuxBridgeRelay }),
            }),
          catch: (error) =>
            failure(
              error instanceof ProcessConfinementError && error.reason === "invalid-configuration"
                ? "invalid-configuration"
                : "incompatible",
              error instanceof ProcessConfinementError
                ? error.message
                : "Pi private-path confinement could not be prepared.",
            ),
        });
        return {
          command: launch.command,
          args: launch.args,
          cwd: root,
          environment: withServerAccess(
            input.network === undefined
              ? environment
              : { ...environment, ...input.network.environment },
            input.servers,
          ),
        };
      }),
  };
}

/** The loopback port of the tool bridge URL, which the runtime's proxy lets through to its own launch. */
function loopbackPortOf(bridge: PiManagedToolBridgeConfig | undefined): ReadonlyArray<number> {
  if (bridge === undefined) return [];
  try {
    const url = new URL(bridge.url);
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 ? [port] : [];
  } catch {
    return [];
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupExists(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Windows has no process groups; the tree stop ends the runtime and every
    // program it started, where `child.kill` ended only the runtime.
    if (process.platform === "win32") void stopWindowsProcessTree(child.pid);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function terminate(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!processGroupExists(child)) return;
  signalGroup(child, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(child) && Date.now() < deadline) await wait(10);
  if (!processGroupExists(child)) return;
  signalGroup(child, "SIGKILL");
}

async function inspectVersion(
  launch: ConfinedVersionProbeLaunch,
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await execVersionRead(launch.command, launch.args, {
    cwd: launch.workingDirectory,
    env: launch.environment,
    timeout: timeoutMs,
    maxBuffer: 1024,
  });
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error();
  return version;
}

export function makePiProcessLive(options: PiProcessOptions = {}): PiProcessPort {
  const platform = options.platform ?? process.platform;
  const confinement = options.confinement ?? makePiConfinementLive({ platform });
  const versionProbeConfinement = options.versionProbeConfinement;
  const inherited = options.inheritedEnvironment ?? process.env;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
  const versionTimeoutMs = options.versionTimeoutMs ?? 5_000;
  return {
    start: (input) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const baseEnvironment = piProcessEnvironment(
            input.binaryPath,
            inherited,
            input.piHome,
            input.executionPolicy === "full-access" ? "disabled" : "enabled",
            input.modelProvider,
            input.strict !== false ||
              input.fullAccessSandbox === true ||
              input.sandboxPolicy !== undefined,
          );
          // On Windows the launch is decided from its own authority before
          // anything runs; an admitted one reads its version unconfined, as
          // it then runs, and takes no proxy or server folder, having no
          // Octant wall to hold them to.
          const windows = platform === "win32" ? piWindowsLaunch(input) : undefined;
          if (windows?.status === "refused") {
            return yield* Effect.fail(failure("incompatible", windows.reason));
          }
          const wall = piWallPolicy(input);
          const network =
            wall === "full-access" || windows !== undefined
              ? undefined
              : yield* acquireProviderRuntimeNetwork(options.runtimeNetwork, {
                  ...(input.sandboxPolicy === undefined
                    ? {}
                    : { sandboxPolicy: input.sandboxPolicy }),
                  runtime: "pi",
                  root: input.root,
                  executionPolicy: wall,
                  loopbackPorts: loopbackPortOf(input.toolBridge),
                  environment: baseEnvironment,
                });
          const servers =
            windows === undefined
              ? yield* acquireProviderServerAccess(
                  input.sandboxPolicy?.policy.hostServices === "blocked"
                    ? undefined
                    : options.serverAccess,
                  {
                    root: input.root,
                    executionPolicy: wall,
                  },
                )
              : undefined;
          const versionProbe = prepareConfinedVersionProbe({
            binaryPath: input.binaryPath,
            displayName: "Pi",
            // The base environment, not the launch's: that one carries the
            // per-thread tool-bridge URL and bearer token.
            environment: () => baseEnvironment,
            guards: PI_GUARDS,
            ...(windows === undefined
              ? versionProbeConfinement === undefined
                ? {}
                : { confinement: versionProbeConfinement }
              : {
                  confinement: windowsUnconfinedLaunch({
                    displayName: "Pi",
                    environment: baseEnvironment,
                  }),
                }),
          });
          if (versionProbe.status === "refused") {
            return yield* Effect.fail(failure(versionProbe.reason, versionProbe.message));
          }
          const version = yield* Effect.tryPromise({
            try: () => inspectVersion(versionProbe.launch, versionTimeoutMs),
            catch: () => failure("incompatible", "Pi version could not be verified."),
          }).pipe(Effect.ensuring(Effect.sync(() => versionProbe.launch.release())));
          // The release is read first: it decides how the launch selects tools.
          const launch = yield* confinement.prepare({
            ...input,
            environment: baseEnvironment,
            version,
            ...(network === undefined ? {} : { network }),
            ...(servers === undefined ? {} : { servers }),
          });
          const child = yield* Effect.try({
            try: () =>
              spawn(launch.command, [...launch.args], {
                cwd: launch.cwd,
                env: launch.environment,
                // Windows has no process groups to lead; its tree stop ends
                // what the runtime started.
                detached: platform !== "win32",
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
              }),
            catch: () => failure("unavailable", "Pi process could not be started."),
          });
          trackSandboxChild(input.sandboxPolicy, child);
          if (child.pid === undefined || child.stdin === null || child.stdout === null) {
            yield* Effect.promise(() => terminate(child, shutdownTimeoutMs));
            return yield* Effect.fail(failure("unavailable", "Pi process could not be started."));
          }
          const rpc = makePiRpcClient({ stdin: child.stdin, stdout: child.stdout });
          const exited = new Promise<void>((resolveExit, rejectExit) => {
            child.once("exit", (code, signal) => {
              if (code === 0 || code === 143 || signal === "SIGTERM") resolveExit();
              else rejectExit(new Error("Pi process exited unexpectedly."));
            });
            child.once("error", rejectExit);
          });
          void exited.catch(() => undefined);
          if (input.onProcessStarted !== undefined) {
            yield* Effect.tryPromise({
              try: () =>
                input.onProcessStarted!({
                  pid: child.pid!,
                  exited,
                }),
              catch: () => failure("provider-failed", "Pi process receipt is unavailable."),
            }).pipe(
              Effect.catchAll((error) =>
                Effect.promise(() =>
                  terminate(child, shutdownTimeoutMs).catch(() => undefined),
                ).pipe(Effect.zipRight(Effect.fail(error))),
              ),
            );
          }
          return { connection: { version, pid: child.pid, root: launch.cwd, rpc, exited }, child };
        }),
        ({ connection, child }) =>
          Effect.promise(async () => {
            await connection.rpc.close().catch(() => undefined);
            await terminate(child, shutdownTimeoutMs);
          }),
      ).pipe(Effect.map(({ connection }) => connection)),
  };
}
