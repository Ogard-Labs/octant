import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
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
import { approvedHomeBinDirs } from "./discoveryService";
import { makePiRpcClient, type PiRpcClient } from "./piRpcClient";
import type { ProviderProcessStartedListener } from "./providerRuntimeRegistry";
import { makeSeatbeltConfinementLive, SeatbeltConfinementError } from "../process/seatbeltProfile";
import {
  materializeOsNetworkEgress,
  resolveDefaultThreadEgressPolicy,
} from "../process/threadEgressPolicy";
import type { PiManagedToolBridgeConfig } from "./piManagedTools";

export type PiSessionMode = "chat" | "work" | "code";

export interface PiLaunchSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface PiConfinementPort {
  readonly prepare: (input: {
    readonly binaryPath: string;
    readonly root: string;
    readonly piHome: string;
    readonly sessionDirectory: string;
    readonly sessionId: string;
    readonly mode: PiSessionMode;
    readonly executionPolicy: ProviderExecutionPolicy;
    readonly environment: NodeJS.ProcessEnv;
    readonly tools?: ReadonlyArray<ProviderToolDefinition>;
    readonly toolBridge?: PiManagedToolBridgeConfig;
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
    readonly piHome: string;
    readonly sessionDirectory: string;
    readonly sessionId: string;
    readonly mode: PiSessionMode;
    readonly executionPolicy: ProviderExecutionPolicy;
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
}

export interface PiProcessOptions {
  readonly confinement?: PiConfinementPort;
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly shutdownTimeoutMs?: number;
  readonly versionTimeoutMs?: number;
}

const SIDE_EFFECT_TOOLS = ["bash", "edit", "write"] as const;
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
const PROVIDER_CREDENTIALS = new Set([
  "AIROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
]);
const APPROVAL_BRIDGE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sideEffects = new Set(${JSON.stringify(SIDE_EFFECT_TOOLS)});

export default function octantApprovalBridge(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!sideEffects.has(event.toolName)) return undefined;
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
const sideEffects = new Set(${javascriptLiteral(SIDE_EFFECT_TOOLS)});

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
    if (!sideEffects.has(event.toolName)) return undefined;
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

export function sanitizePiEnvironment(
  host: NodeJS.ProcessEnv,
  piHome: string,
  approvals: "enabled" | "disabled" = "enabled",
): NodeJS.ProcessEnv {
  return Object.fromEntries([
    ...Object.entries(host).filter(
      ([key, value]) =>
        value !== undefined &&
        (SAFE_ENVIRONMENT.has(key) || PROVIDER_CREDENTIALS.has(key) || key.startsWith("LC_")),
    ),
    ["HOME", piHome],
    ["PI_CODING_AGENT_DIR", piHome],
    ["PI_TELEMETRY", "0"],
    ["PI_SKIP_VERSION_CHECK", "1"],
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
): NodeJS.ProcessEnv {
  const sanitized = sanitizePiEnvironment(host, piHome, approvals);
  const binaryDirectory = dirname(binaryPath);
  const path = sanitized.PATH?.split(delimiter).filter(Boolean) ?? [];
  const searched = [binaryDirectory, ...approvedHomeBinDirs(host.HOME), ...path];
  return {
    ...sanitized,
    PATH: [...new Set(searched)].join(delimiter),
  };
}

export function piArguments(
  bridgePath: string,
  sessionDirectory: string,
  sessionId: string,
  mode: PiSessionMode,
  executionPolicy: ProviderExecutionPolicy,
  appToolNames: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const builtInTools =
    mode === "chat"
      ? []
      : executionPolicy === "plan"
        ? READ_TOOLS.split(",")
        : ALL_TOOLS.split(",");
  const selectedTools = [...builtInTools, ...appToolNames];
  const tools = selectedTools.length === 0 ? ["--no-tools"] : ["--tools", selectedTools.join(",")];
  return [
    "--mode",
    "rpc",
    "--no-approve",
    "--no-extensions",
    "--extension",
    bridgePath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    ...tools,
    "--session-dir",
    sessionDirectory,
    "--session-id",
    sessionId,
  ];
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
    symlinkSync(sourcePath, target);
    return;
  }
  if (
    !lstatSync(target).isSymbolicLink() ||
    resolve(dirname(target), readlinkSync(target)) !== sourcePath
  ) {
    throw new Error();
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function makePiConfinementLive(options: PiConfinementOptions = {}): PiConfinementPort {
  const platform = options.platform ?? process.platform;
  const sandboxPath =
    options.sandboxPath ?? (platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap");
  const credentialPath = options.credentialPath ?? join(homedir(), ".pi/agent/auth.json");
  const modelsPath = options.modelsPath ?? join(homedir(), ".pi/agent/models.json");
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
        const bridgePath = join(piHome, "octant-approval-bridge.ts");
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
        const args = piArguments(
          bridgePath,
          sessionDirectory,
          input.sessionId,
          input.mode,
          input.executionPolicy,
          tools.map((tool) => tool.name),
        );
        if (input.executionPolicy === "full-access") {
          return { command: input.binaryPath, args, cwd: root, environment };
        }
        const temporaryDirectoryPath = yield* temporaryDirectory(
          options.temporaryDirectory ?? input.environment.TMPDIR ?? "/tmp",
        );
        const binaryDirectory = dirname(realpathSync(input.binaryPath));
        const runtimeDirectory = dirname(binaryDirectory);
        const packageRoot = dirname(runtimeDirectory);
        const networkEgress = materializeOsNetworkEgress(
          resolveDefaultThreadEgressPolicy({
            mode: input.mode,
            executionPolicy: input.executionPolicy,
          }),
        );
        if (input.toolBridge !== undefined && platform === "linux" && networkEgress !== "allow") {
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
        const confinement = makeSeatbeltConfinementLive({
          platform,
          sandboxPath,
        });
        const launch = yield* Effect.try({
          try: () =>
            confinement.prepare({
              executable: input.binaryPath,
              args,
              boundRoot: root,
              temporaryDirectory: temporaryDirectoryPath,
              networkEgress,
              writeBoundRoot: !(input.executionPolicy === "plan" || input.mode === "chat"),
              additionalWriteRoots: [piHome],
              allowFileReadStar: true,
              allowProcessExec: !(input.executionPolicy === "plan" || input.mode === "chat"),
              allowProcessFork: !(input.executionPolicy === "plan" || input.mode === "chat"),
              ...(input.environment?.PATH === undefined
                ? {}
                : { interpreterSearchPath: input.environment.PATH }),
              readRoots: [
                root,
                piHome,
                binaryDirectory,
                runtimeDirectory,
                packageRoot,
                temporaryDirectoryPath,
                ...credentialPaths,
              ],
              privateHomeAllowPaths: [
                root,
                piHome,
                binaryDirectory,
                runtimeDirectory,
                packageRoot,
                ...credentialPaths,
              ],
              ...(bridgeRule === undefined ? {} : { extraRules: [bridgeRule] }),
            }),
          catch: (error) =>
            failure(
              error instanceof SeatbeltConfinementError && error.reason === "invalid-configuration"
                ? "invalid-configuration"
                : "incompatible",
              error instanceof SeatbeltConfinementError
                ? error.message
                : "Pi private-path confinement could not be prepared.",
            ),
        });
        return {
          command: launch.command,
          args: launch.args,
          cwd: root,
          environment,
        };
      }),
  };
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
    if (process.platform === "win32") child.kill(signal);
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

function inspectVersion(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolveVersion, reject) => {
    execFile(
      binaryPath,
      ["--version"],
      { env: environment, timeout: timeoutMs, maxBuffer: 1024 },
      (error, stdout) => {
        const version = stdout.trim();
        if (error !== null || !/^\d+\.\d+\.\d+$/.test(version)) reject(new Error());
        else resolveVersion(version);
      },
    );
  });
}

export function makePiProcessLive(options: PiProcessOptions = {}): PiProcessPort {
  const confinement = options.confinement ?? makePiConfinementLive();
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
          );
          const launch = yield* confinement.prepare({ ...input, environment: baseEnvironment });
          const version = yield* Effect.tryPromise({
            try: () => inspectVersion(input.binaryPath, launch.environment, versionTimeoutMs),
            catch: () => failure("incompatible", "Pi version could not be verified."),
          });
          const child = yield* Effect.try({
            try: () =>
              spawn(launch.command, [...launch.args], {
                cwd: launch.cwd,
                env: launch.environment,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
              }),
            catch: () => failure("unavailable", "Pi process could not be started."),
          });
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
