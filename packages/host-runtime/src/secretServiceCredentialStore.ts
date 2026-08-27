import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { isExecutable } from "./executableCheck";

const execFileAsync = promisify(execFile);
export const SECRET_TOOL_PATH = "/usr/bin/secret-tool";
export const SECRET_SERVICE_BUSCTL_PATH = "/usr/bin/busctl";
export const SECRET_SERVICE_ATTRIBUTE = "octant";
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 16 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SecretToolCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

export interface SecretToolCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SecretToolCommandLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export type SecretToolCommandExecutor = (
  spec: SecretToolCommandSpec,
  limits: SecretToolCommandLimits,
) => Promise<SecretToolCommandResult>;

export interface SecretServiceProbeRunner {
  run(
    command: string,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export interface SecretServiceAvailability {
  readonly available: boolean;
  readonly service: "available" | "unavailable";
  readonly tool: "available" | "unavailable";
}

export async function probeSecretService(
  runner: SecretServiceProbeRunner = defaultProbeRunner,
  executable: (path: string) => Promise<boolean> = isExecutable,
): Promise<SecretServiceAvailability> {
  const service = await probeCommand(runner, SECRET_SERVICE_BUSCTL_PATH, [
    "--user",
    "--no-pager",
    "status",
    "org.freedesktop.secrets",
  ]);
  const tool = await executable(SECRET_TOOL_PATH);
  return {
    available: service && tool,
    service: service ? "available" : "unavailable",
    tool: tool ? "available" : "unavailable",
  };
}

export interface MakeSecretServiceCredentialStoreOptions {
  readonly execute?: SecretToolCommandExecutor;
  readonly timeoutMs?: number;
}

export function makeSecretServiceCredentialStore(
  options: MakeSecretServiceCredentialStoreOptions = {},
): CredentialStore {
  const execute = options.execute ?? executeSecretTool;
  const limits = {
    maxBytes: MAX_OUTPUT_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (!isAbsolute(SECRET_TOOL_PATH) || limits.timeoutMs <= 0) {
    throw new CredentialStoreFailure("invalid");
  }

  const invoke = async (
    operation: "set" | "has" | "resolve" | "delete",
    providerInstanceId: string,
    credential?: string,
  ): Promise<SecretToolCommandResult> => {
    const normalizedId = normalizeProviderInstanceId(providerInstanceId);
    let spec: SecretToolCommandSpec;
    if (operation === "set") {
      if (credential === undefined || credential.length === 0) {
        throw new CredentialStoreFailure("invalid");
      }
      spec = {
        command: SECRET_TOOL_PATH,
        args: [
          "store",
          "--label=Octant provider credential",
          "service",
          SECRET_SERVICE_ATTRIBUTE,
          "account",
          normalizedId,
        ],
        // secret-tool store reads until EOF; a trailing newline would be stored.
        stdin: credential,
      };
    } else {
      spec = {
        command: SECRET_TOOL_PATH,
        args: [
          operation === "delete" ? "clear" : "lookup",
          "service",
          SECRET_SERVICE_ATTRIBUTE,
          "account",
          normalizedId,
        ],
      };
    }
    try {
      return await execute(spec, limits);
    } catch {
      throw new CredentialStoreFailure("unavailable");
    }
  };

  return {
    set: async (providerInstanceId, credential) => {
      const result = await invoke("set", providerInstanceId, credential);
      if (result.exitCode !== 0 || result.stdout !== "" || result.stderr !== "") {
        throw commandFailure(result);
      }
    },
    has: async (providerInstanceId) => {
      const result = await invoke("has", providerInstanceId);
      if (result.exitCode !== 0) {
        if (result.stderr === "" || isMissingSecret(result.stderr)) return false;
        throw commandFailure(result);
      }
      if (result.stderr !== "" || result.stdout.trim() === "") {
        throw new CredentialStoreFailure("failed");
      }
      return true;
    },
    resolve: async (providerInstanceId) => {
      const result = await invoke("resolve", providerInstanceId);
      if (result.exitCode !== 0) {
        if (result.stderr === "" || isMissingSecret(result.stderr)) {
          throw new CredentialStoreFailure("missing");
        }
        throw commandFailure(result);
      }
      if (result.stderr !== "") throw new CredentialStoreFailure("failed");
      // secret-tool lookup prints the secret plus a newline; stored bytes do not include it.
      const credential = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
      if (credential.length === 0) throw new CredentialStoreFailure("failed");
      return credential;
    },
    delete: async (providerInstanceId) => {
      const result = await invoke("delete", providerInstanceId);
      if (result.exitCode !== 0 && !isMissingSecret(result.stderr)) {
        throw commandFailure(result);
      }
      if (result.stdout !== "" || (result.stderr !== "" && !isMissingSecret(result.stderr))) {
        throw new CredentialStoreFailure("failed");
      }
    },
  };
}

function normalizeProviderInstanceId(providerInstanceId: string): string {
  const normalized = providerInstanceId.toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new CredentialStoreFailure("invalid");
  return normalized;
}

async function probeCommand(
  runner: SecretServiceProbeRunner,
  command: string,
  args: readonly string[],
): Promise<boolean> {
  try {
    const result = await runner.run(command, args);
    return result.stdout.trim() !== "" && result.stderr.trim() === "";
  } catch {
    return false;
  }
}

function commandFailure(result: SecretToolCommandResult): CredentialStoreFailure {
  if (isSecretStoreUnavailable(result.stderr)) {
    return new CredentialStoreFailure("unavailable");
  }
  return new CredentialStoreFailure("failed");
}

function isMissingSecret(stderr: string): boolean {
  return /no (?:such|matching) secret|not found/i.test(stderr);
}

function isSecretStoreUnavailable(stderr: string): boolean {
  return /service|collection|keyring|locked|unlock|dbus|session bus/i.test(stderr);
}

const defaultProbeRunner: SecretServiceProbeRunner = {
  run: async (command, args) =>
    execFileAsync(command, [...args], {
      shell: false,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, LC_ALL: "C" },
    }),
};

const executeSecretTool: SecretToolCommandExecutor = (spec, limits) =>
  new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      shell: false,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: SecretToolCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("secret-tool timed out"));
    }, limits.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > limits.maxBytes) {
        child.kill("SIGKILL");
        fail(new Error("secret-tool output exceeded the bound"));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > limits.maxBytes) {
        child.kill("SIGKILL");
        fail(new Error("secret-tool diagnostics exceeded the bound"));
      }
    });
    child.once("error", (error) => fail(error));
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      finish({ exitCode, stdout, stderr });
    });
    if (spec.stdin === undefined) {
      child.stdin?.end();
    } else {
      child.stdin?.end(spec.stdin);
    }
  });
