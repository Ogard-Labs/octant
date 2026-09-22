import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { sanitizeCodexEnvironment } from "./codexProcess";

/**
 * Whether the Codex runtime's active model provider can authenticate.
 *
 * `account/read` answers `requiresOpenaiAuth: false` for a provider that
 * takes its credential outside the OpenAI login — a built-in like Bedrock, or
 * a `config.toml` provider with its own `env_key` — without looking at
 * whether that credential exists. The probe cannot lean on that answer, so it
 * names the variable the active provider needs and checks whether the
 * runtime's allowlist would carry it. Only the name is read; the value never
 * crosses, and a config that names a host secret as its `env_key` is
 * reported missing rather than admitted.
 */
export interface CodexProviderCredential {
  /** The environment variable the active provider authenticates with. */
  readonly envKey: string;
  /** Whether the variable would reach the runtime's environment. */
  readonly present: boolean;
}

// The built-in provider that authenticates outside the OpenAI login and the
// variable the CLI names for it when no `env_key` is declared.
const BUILTIN_PROVIDER_ENV_KEYS: Readonly<Record<string, string>> = {
  "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
};

/**
 * The credential the Codex runtime's active model provider needs, or
 * `undefined` when the config does not name one — the default OpenAI-login
 * path is answered by `account/read` instead.
 */
export function codexProviderCredential(
  environment: NodeJS.ProcessEnv = process.env,
  readConfig: (path: string) => string | undefined = readConfigFile,
): CodexProviderCredential | undefined {
  const home = environment.CODEX_HOME;
  const configHome = home !== undefined && isAbsolute(home) ? home : join(homedir(), ".codex");
  const text = readConfig(join(configHome, "config.toml"));
  if (text === undefined) return undefined;
  const provider = codexActiveModelProvider(text);
  if (provider === undefined) return undefined;
  const envKey = provider.envKey ?? BUILTIN_PROVIDER_ENV_KEYS[provider.id];
  if (envKey === undefined) return undefined;
  const allowed = sanitizeCodexEnvironment(environment);
  // An empty exported value is missing: Codex treats it that way, and the
  // allowlist keeps empty strings. Bedrock also authenticates through the AWS
  // profile and shared-credential files the runtime already forwards; the
  // bearer token is not the only source.
  const present =
    nonempty(allowed, envKey) ||
    (provider.id === "amazon-bedrock" &&
      (nonempty(allowed, "AWS_PROFILE") ||
        nonempty(allowed, "AWS_CONFIG_FILE") ||
        nonempty(allowed, "AWS_SHARED_CREDENTIALS_FILE")));
  return { envKey, present };
}

function nonempty(environment: NodeJS.ProcessEnv, key: string): boolean {
  const value = environment[key];
  return typeof value === "string" && value.trim() !== "";
}

interface CodexActiveModelProvider {
  readonly id: string;
  readonly envKey?: string;
}

/**
 * The `model_provider` a `config.toml` selects and the `env_key` its
 * `[model_providers.<id>]` table declares, when it declares one. This is a
 * field read, not a TOML parser: it answers the two settings the probe needs
 * and treats anything it cannot read plainly as absent.
 */
export function codexActiveModelProvider(text: string): CodexActiveModelProvider | undefined {
  let id: string | undefined;
  let table: string | undefined;
  const envKeys = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") continue;
    const header = /^\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
    if (header !== null) {
      table = parseProviderTableName(header[1] ?? "");
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (assignment === null) continue;
    const key = assignment[1];
    const value = parseTomlString(assignment[2] ?? "");
    if (value === undefined) continue;
    if (table === undefined && key === "model_provider") {
      id = value;
      continue;
    }
    if (table !== undefined && key === "env_key") {
      envKeys.set(table, value);
    }
  }
  if (id === undefined) return undefined;
  const envKey = envKeys.get(id);
  return envKey === undefined ? { id } : { id, envKey };
}

/** `model_providers.<id>`, with the quoted form `model_providers."a.b"` unwrapped. */
function parseProviderTableName(header: string): string | undefined {
  const match = /^model_providers\.(.+)$/.exec(header);
  if (match === null) return undefined;
  const name = match[1]?.trim() ?? "";
  return parseTomlString(name) ?? (name === "" ? undefined : name);
}

function parseTomlString(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : undefined;
}

function stripTomlComment(line: string): string {
  let quoted: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted === undefined && (char === '"' || char === "'")) {
      quoted = char;
      continue;
    }
    if (quoted === '"' && char === "\\") {
      index += 1;
      continue;
    }
    if (quoted !== undefined && char === quoted) {
      quoted = undefined;
      continue;
    }
    if (quoted === undefined && char === "#") return line.slice(0, index);
  }
  return line;
}

function readConfigFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
