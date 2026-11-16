import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The person's own AWS profile, read the way the AWS CLI reads it, inside the
 * credential broker. What a profile yields (keys, a session token, an SSO
 * access token) is reusable identity material, so it never leaves the broker:
 * the caller gets credentials to sign one request with, and nothing here is
 * returned over a route.
 *
 * Supported, in the AWS CLI's order: static keys in the shared credentials
 * file, static keys in the config file, single sign-on through the token the
 * AWS CLI cached at `aws sso login` (an `sso-session` section or the older
 * per-profile `sso_start_url`), and `credential_process`. A profile that only
 * assumes a role (`role_arn` with `source_profile`, web identity) is refused
 * as unsupported rather than resolved partly.
 */

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Epoch milliseconds; absent for long-lived keys. */
  readonly expiresAt?: number;
}

export type AwsProfileRefusal =
  /** No section by that name in either file. */
  | "profile-missing"
  /** The SSO token cache holds no current token: run `aws sso login` for the profile. */
  | "sso-sign-in-needed"
  /** The portal does not give this person the account and role. */
  | "not-authorized"
  /** `credential_process` failed or printed something other than credentials. */
  | "process-failed"
  /** The profile names a source this broker does not resolve. */
  | "unsupported"
  | "unavailable";

export type AwsProfileResolution =
  | {
      readonly kind: "credentials";
      readonly credentials: AwsCredentials;
      readonly via: "static-keys" | "sso" | "credential-process";
    }
  | { readonly kind: "refused"; readonly reason: AwsProfileRefusal };

export type AwsSsoMintOutcome =
  | { readonly kind: "credentials"; readonly credentials: Required<AwsCredentials> }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not-authorized" }
  | { readonly kind: "unavailable" };

export interface AwsProfilePorts {
  /** The file's text, or undefined when it does not exist or cannot be read. */
  readonly readFile: (path: string) => Promise<string | undefined>;
  /** Runs the profile's own `credential_process` line through the shell, bounded. */
  readonly runCredentialProcess: (
    command: string,
  ) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
  /** The portal's role credentials for a cached SSO access token. */
  readonly mintSsoRoleCredentials: (input: {
    readonly ssoRegion: string;
    readonly accountId: string;
    readonly roleName: string;
    readonly accessToken: string;
  }) => Promise<AwsSsoMintOutcome>;
  readonly homeDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
}

// The AWS CLI gives a credential process a minute; a broker renewal should
// not wait longer than a signature is worth.
const CREDENTIAL_PROCESS_TIMEOUT_MS = 30_000;

/**
 * The broker's own reads: the shared files under the person's home (or where
 * `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` point), and
 * `credential_process` run through the platform shell as the AWS CLI runs it.
 */
export function nodeAwsProfilePorts(): Omit<AwsProfilePorts, "mintSsoRoleCredentials" | "now"> {
  return {
    readFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    runCredentialProcess: (command) =>
      new Promise((resolve) => {
        exec(
          command,
          {
            timeout: CREDENTIAL_PROCESS_TIMEOUT_MS,
            maxBuffer: MAX_PROCESS_OUTPUT_CHARS,
            windowsHide: true,
          },
          (error, stdout) => {
            resolve({
              exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
              stdout: String(stdout),
            });
          },
        );
      }),
    homeDirectory: homedir(),
    env: process.env,
  };
}

export const AWS_PROFILE_NAME_PATTERN = /^[A-Za-z0-9_.+@-]{1,64}$/;
const ACCESS_KEY_ID_PATTERN = /^[A-Z0-9]{16,128}$/;
const REGION_PATTERN = /^(?!cn-)[a-z]{2}-[a-z]{4,9}-[1-9]$/;
const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/;
const ROLE_NAME_PATTERN = /^[A-Za-z0-9+=,.@_-]{1,64}$/;
const MAX_SECRET_CHARS = 8_192;
const MAX_PROCESS_OUTPUT_CHARS = 64 * 1_024;

/** Whether a long-lived key pair has the shape AWS issues. */
export function isAwsAccessKeyPair(accessKeyId: string, secretAccessKey: string): boolean {
  return ACCESS_KEY_ID_PATTERN.test(accessKeyId) && isBoundedSecret(secretAccessKey);
}

export async function resolveAwsProfileCredentials(
  profileName: string,
  ports: AwsProfilePorts,
): Promise<AwsProfileResolution> {
  if (!AWS_PROFILE_NAME_PATTERN.test(profileName)) return refused("profile-missing");
  const configPath = ports.env.AWS_CONFIG_FILE ?? join(ports.homeDirectory, ".aws", "config");
  const credentialsPath =
    ports.env.AWS_SHARED_CREDENTIALS_FILE ?? join(ports.homeDirectory, ".aws", "credentials");
  const config = parseAwsIni((await ports.readFile(configPath)) ?? "");
  const shared = parseAwsIni((await ports.readFile(credentialsPath)) ?? "");
  const fromShared = shared.get(profileName);
  const fromConfig =
    config.get(`profile ${profileName}`) ??
    (profileName === "default" ? config.get("default") : undefined);
  if (fromShared === undefined && fromConfig === undefined) return refused("profile-missing");

  for (const section of [fromShared, fromConfig]) {
    const keys = section === undefined ? undefined : staticKeys(section);
    if (keys === "invalid") return refused("unavailable");
    if (keys !== undefined) return { kind: "credentials", credentials: keys, via: "static-keys" };
  }
  if (fromConfig === undefined) return refused("unsupported");
  if (fromConfig.has("sso_account_id") || fromConfig.has("sso_session")) {
    return resolveSso(fromConfig, config, ports);
  }
  const process = fromConfig.get("credential_process");
  if (process !== undefined && process.trim().length > 0) {
    return resolveCredentialProcess(process, ports);
  }
  return refused("unsupported");
}

async function resolveSso(
  profile: ReadonlyMap<string, string>,
  config: ReadonlyMap<string, ReadonlyMap<string, string>>,
  ports: AwsProfilePorts,
): Promise<AwsProfileResolution> {
  const sessionName = profile.get("sso_session");
  const session = sessionName === undefined ? undefined : config.get(`sso-session ${sessionName}`);
  if (sessionName !== undefined && session === undefined) return refused("unsupported");
  const startUrl = session?.get("sso_start_url") ?? profile.get("sso_start_url");
  const ssoRegion = session?.get("sso_region") ?? profile.get("sso_region");
  const accountId = profile.get("sso_account_id");
  const roleName = profile.get("sso_role_name");
  if (
    startUrl === undefined ||
    ssoRegion === undefined ||
    !REGION_PATTERN.test(ssoRegion) ||
    accountId === undefined ||
    !ACCOUNT_ID_PATTERN.test(accountId) ||
    roleName === undefined ||
    !ROLE_NAME_PATTERN.test(roleName)
  )
    return refused("unsupported");
  // The AWS CLI names its token cache file by the SHA-1 of the session's name,
  // or of the start URL for a profile written before sso-session sections.
  const cacheKey = createHash("sha1")
    .update(sessionName ?? startUrl)
    .digest("hex");
  const cached = await ports.readFile(
    join(ports.homeDirectory, ".aws", "sso", "cache", `${cacheKey}.json`),
  );
  const token = cached === undefined ? undefined : readSsoToken(cached);
  if (token === undefined || token.expiresAt <= ports.now()) return refused("sso-sign-in-needed");
  const minted = await ports.mintSsoRoleCredentials({
    ssoRegion,
    accountId,
    roleName,
    accessToken: token.accessToken,
  });
  if (minted.kind === "credentials") {
    return { kind: "credentials", credentials: minted.credentials, via: "sso" };
  }
  if (minted.kind === "unauthorized") return refused("sso-sign-in-needed");
  return refused(minted.kind);
}

async function resolveCredentialProcess(
  command: string,
  ports: AwsProfilePorts,
): Promise<AwsProfileResolution> {
  let ran: { readonly exitCode: number; readonly stdout: string };
  try {
    ran = await ports.runCredentialProcess(command);
  } catch {
    return refused("process-failed");
  }
  if (ran.exitCode !== 0 || ran.stdout.length > MAX_PROCESS_OUTPUT_CHARS) {
    return refused("process-failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ran.stdout);
  } catch {
    return refused("process-failed");
  }
  if (!isRecord(parsed) || parsed.Version !== 1) return refused("process-failed");
  const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = parsed;
  if (
    typeof AccessKeyId !== "string" ||
    typeof SecretAccessKey !== "string" ||
    !isAwsAccessKeyPair(AccessKeyId, SecretAccessKey) ||
    (SessionToken !== undefined &&
      (typeof SessionToken !== "string" || !isBoundedSecret(SessionToken))) ||
    (Expiration !== undefined && typeof Expiration !== "string")
  )
    return refused("process-failed");
  const expiresAt = Expiration === undefined ? undefined : Date.parse(Expiration);
  if (expiresAt !== undefined && !Number.isFinite(expiresAt)) return refused("process-failed");
  return {
    kind: "credentials",
    credentials: {
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretAccessKey,
      ...(SessionToken === undefined ? {} : { sessionToken: SessionToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
    via: "credential-process",
  };
}

function staticKeys(section: ReadonlyMap<string, string>): AwsCredentials | "invalid" | undefined {
  const accessKeyId = section.get("aws_access_key_id");
  const secretAccessKey = section.get("aws_secret_access_key");
  if (accessKeyId === undefined && secretAccessKey === undefined) return undefined;
  if (
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    !isAwsAccessKeyPair(accessKeyId, secretAccessKey)
  )
    return "invalid";
  const sessionToken = section.get("aws_session_token");
  if (sessionToken !== undefined && !isBoundedSecret(sessionToken)) return "invalid";
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

function readSsoToken(
  text: string,
): { readonly accessToken: string; readonly expiresAt: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { accessToken, expiresAt } = parsed;
  if (typeof accessToken !== "string" || !isBoundedSecret(accessToken)) return undefined;
  if (typeof expiresAt !== "string") return undefined;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) ? { accessToken, expiresAt: at } : undefined;
}

/**
 * The AWS shared-file INI dialect: `[section]` headers, `key = value` lines,
 * `#` and `;` comments. Indented continuation lines (nested `s3 =` blocks) are
 * skipped, since no key read here is nested.
 */
export function parseAwsIni(text: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s/.test(raw) && current !== undefined && raw.trim().length > 0) continue;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header !== null) {
      const name = (header[1] ?? "").replace(/\s+/g, " ");
      current = sections.get(name) ?? new Map<string, string>();
      sections.set(name, current);
      continue;
    }
    const separator = line.indexOf("=");
    if (current === undefined || separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!current.has(key)) current.set(key, value);
  }
  return sections;
}

function refused(reason: AwsProfileRefusal): AwsProfileResolution {
  return { kind: "refused", reason };
}

function isBoundedSecret(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SECRET_CHARS && /^[\x21-\x7e]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
