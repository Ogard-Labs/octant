import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { sanitizeCodexEnvironment } from "./codexProcess";

/**
 * Whether the Codex runtime's active model provider can authenticate.
 *
 * `account/read` answers `requiresOpenaiAuth: false` for a provider that
 * takes its credential outside the OpenAI login, a `config.toml` provider
 * with its own `env_key`, without looking at whether that credential exists.
 * The probe cannot lean on that answer, so it names the variable the active
 * provider needs and checks whether the runtime's allowlist would carry it.
 * Only the name is read; the value never crosses, and a config that names a
 * host secret as its `env_key` is reported missing rather than admitted.
 * Amazon Bedrock is not answered here: `codexBedrockSignIn` traces it.
 */
export interface CodexProviderCredential {
  /** The environment variable the active provider authenticates with. */
  readonly envKey: string;
  /** Whether the variable would reach the runtime's environment. */
  readonly present: boolean;
}

/** Codex's two built-in Bedrock providers (Mantle and Runtime endpoints). */
const CODEX_BEDROCK_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "amazon-bedrock-runtime",
]);

/**
 * The credential the Codex runtime's active model provider needs, or
 * `undefined` when the config does not name one — the default OpenAI-login
 * path is answered by `account/read` instead.
 */
export function codexProviderCredential(
  environment: NodeJS.ProcessEnv = process.env,
  readConfig: (path: string) => string | undefined = readConfigFile,
): CodexProviderCredential | undefined {
  const provider = codexConfiguredModelProvider(environment, readConfig);
  if (provider?.envKey === undefined || CODEX_BEDROCK_PROVIDER_IDS.has(provider.id)) {
    return undefined;
  }
  // An empty exported value is missing: Codex treats it that way, and the
  // allowlist keeps empty strings.
  return {
    envKey: provider.envKey,
    present: nonempty(sanitizeCodexEnvironment(environment), provider.envKey),
  };
}

/**
 * Whether the account's `config.toml` selects a Bedrock provider. A runtime
 * older than the `amazonBedrock` account report answers `apiKey`, so this is
 * how its Bedrock configuration is recognised.
 */
export function codexConfiguresBedrock(
  environment: NodeJS.ProcessEnv = process.env,
  readConfig: (path: string) => string | undefined = readConfigFile,
): boolean {
  const provider = codexConfiguredModelProvider(environment, readConfig);
  return provider !== undefined && CODEX_BEDROCK_PROVIDER_IDS.has(provider.id);
}

/**
 * Where the Codex runtime's Bedrock sign-in comes from, in the order Codex
 * itself chooses (`auth_source` in codex-rs
 * `model-provider/src/amazon_bedrock/auth.rs`, rust-v0.162.1): a provider
 * `auth` command, then an `aws.credential_export` command, then an
 * `aws.profile`, then the key or access keys stored in the account's own Codex
 * home, then `AWS_BEARER_TOKEN_BEDROCK`, then exported IAM keys, and last the
 * AWS SDK's default chain.
 *
 * The runtime is not confined and its read-only sandbox reads the whole disk,
 * so whatever its sign-in reads, its commands can read too. A profile and the
 * default chain read the AWS shared config and SSO cache under `~/.aws`
 * through `HOME`, with or without a profile variable, and a credential export
 * hands the runtime general-purpose AWS keys: each is a reusable cloud
 * credential the person did not give this account, so each is refused.
 * Exported IAM keys never cross the allowlist, so that step falls through to
 * the default chain. What remains is what the person configured for this
 * account: a token command, a sign-in stored in its Codex home (Octant cannot
 * tell a stored Bedrock key from stored access keys without reading Codex's
 * credential store, which it never does), or a Bedrock bearer token.
 */
export type CodexBedrockSignIn =
  | {
      readonly status: "instance-scoped";
      readonly source: "auth-command" | "codex-managed" | "bearer-token";
    }
  | {
      readonly status: "refused";
      readonly source: "credential-export" | "aws-profile" | "aws-default-chain";
    };

export function codexBedrockSignIn(input: {
  /** The active provider's table from the effective config, as Codex reported it. */
  readonly providerConfig: unknown;
  readonly usesCodexManagedCredentials: boolean;
  /** The environment the runtime launches with, before the allowlist. */
  readonly environment: NodeJS.ProcessEnv;
}): CodexBedrockSignIn {
  const provider = isRecord(input.providerConfig) ? input.providerConfig : {};
  const aws = isRecord(provider.aws) ? provider.aws : {};
  if (isSet(provider.auth)) return { status: "instance-scoped", source: "auth-command" };
  if (isSet(aws.credential_export)) return { status: "refused", source: "credential-export" };
  if (isSet(aws.profile)) return { status: "refused", source: "aws-profile" };
  if (input.usesCodexManagedCredentials) {
    return { status: "instance-scoped", source: "codex-managed" };
  }
  if (nonempty(sanitizeCodexEnvironment(input.environment), "AWS_BEARER_TOKEN_BEDROCK")) {
    return { status: "instance-scoped", source: "bearer-token" };
  }
  return { status: "refused", source: "aws-default-chain" };
}

/**
 * The effective config's table for the provider it selects. Bedrock is the
 * only caller, so a config that names no provider is read as Bedrock's.
 */
export function codexSelectedProviderConfig(config: {
  readonly model_provider?: string | undefined;
  readonly model_providers?: Readonly<Record<string, unknown>> | undefined;
}): unknown {
  const providers = config.model_providers;
  const id = config.model_provider ?? "amazon-bedrock";
  return providers !== undefined && Object.hasOwn(providers, id) ? providers[id] : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function nonempty(environment: NodeJS.ProcessEnv, key: string): boolean {
  const value = environment[key];
  return typeof value === "string" && value.trim() !== "";
}

function codexConfiguredModelProvider(
  environment: NodeJS.ProcessEnv,
  readConfig: (path: string) => string | undefined,
): CodexActiveModelProvider | undefined {
  const home = environment.CODEX_HOME;
  const configHome = home !== undefined && isAbsolute(home) ? home : join(homedir(), ".codex");
  const text = readConfig(join(configHome, "config.toml"));
  return text === undefined ? undefined : codexActiveModelProvider(text);
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
