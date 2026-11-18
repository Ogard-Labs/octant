import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AwsAssumeRoleInput, AwsStsOutcome } from "./awsSts";

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
 * per-profile `sso_start_url`), and `credential_process`. A profile with a
 * `role_arn` assumes that role first, as the AWS CLI does: from the
 * credentials of its `source_profile` (itself possibly a role, up to
 * `MAX_ROLE_HOPS`), of the broker's environment for `credential_source =
 * Environment`, or with the token in its `web_identity_token_file`. A role that
 * asks for an MFA code is refused, since connecting a profile has no place to
 * type one.
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
  /** The role names an `mfa_serial`, and there is no place to type its code. */
  | "mfa-required"
  /** The token service refused to assume the role for these source credentials or token. */
  | "role-refused"
  | "unavailable";

export type AwsProfileResolution =
  | {
      readonly kind: "credentials";
      readonly credentials: AwsCredentials;
      readonly via: "static-keys" | "sso" | "credential-process" | "assume-role" | "web-identity";
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
  /** The token service's `AssumeRole`, signed with the source credentials. */
  readonly assumeRole: (
    input: AwsAssumeRoleInput & { readonly source: AwsCredentials },
  ) => Promise<AwsStsOutcome>;
  /** The token service's `AssumeRoleWithWebIdentity`, carrying the token file's text. */
  readonly assumeRoleWithWebIdentity: (
    input: AwsAssumeRoleInput & { readonly webIdentityToken: string },
  ) => Promise<AwsStsOutcome>;
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
export function nodeAwsProfilePorts(): Omit<
  AwsProfilePorts,
  "mintSsoRoleCredentials" | "assumeRole" | "assumeRoleWithWebIdentity" | "now"
> {
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
// The commercial partition only, as the signing scope is: a role elsewhere
// would need that partition's token service.
const ROLE_ARN_PATTERN = /^arn:aws:iam::[0-9]{12}:role\/[\w+=,.@/-]{1,512}$/;
const ROLE_SESSION_NAME_PATTERN = /^[\w+=,.@-]{2,64}$/;
const EXTERNAL_ID_PATTERN = /^[\w+=,.@:/-]{2,1224}$/;
const MAX_WEB_IDENTITY_TOKEN_CHARS = 20_000;
/**
 * How many roles one profile may assume in a row. The AWS CLI sets no bound
 * but refuses a cycle; a chain deeper than this is a misconfiguration rather
 * than a workflow, and each hop is one more token-service call per renewal.
 */
const MAX_ROLE_HOPS = 5;

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
  const files: ProfileFiles = {
    config: parseAwsIni((await ports.readFile(configPath)) ?? ""),
    shared: parseAwsIni((await ports.readFile(credentialsPath)) ?? ""),
  };
  return resolveNamedProfile(profileName, files, ports, []);
}

type AwsIni = ReadonlyMap<string, ReadonlyMap<string, string>>;

interface ProfileFiles {
  readonly config: AwsIni;
  readonly shared: AwsIni;
}

/**
 * One profile, in the AWS CLI's order: a role it assumes, then its own keys,
 * single sign-on and credential process. `assuming` lists the profiles whose
 * roles wait on this one, to bound the chain and refuse a cycle.
 */
async function resolveNamedProfile(
  profileName: string,
  files: ProfileFiles,
  ports: AwsProfilePorts,
  assuming: ReadonlyArray<string>,
): Promise<AwsProfileResolution> {
  if (!AWS_PROFILE_NAME_PATTERN.test(profileName)) return refused("profile-missing");
  const fromShared = files.shared.get(profileName);
  const fromConfig =
    files.config.get(`profile ${profileName}`) ??
    (profileName === "default" ? files.config.get("default") : undefined);
  if (fromShared === undefined && fromConfig === undefined) return refused("profile-missing");

  // The AWS CLI merges a profile's two sections, the credentials file winning.
  const setting = (key: string) => fromShared?.get(key) ?? fromConfig?.get(key);
  // A source profile that holds its own keys signs with them even when it
  // also names a role: the AWS CLI chains into a source's role only when the
  // source has no static keys.
  const sourceWithKeys = assuming.length > 0 && setting("aws_access_key_id") !== undefined;
  if (setting("role_arn") !== undefined && !sourceWithKeys) {
    return assumeProfileRole(profileName, setting, files, ports, assuming);
  }
  for (const section of [fromShared, fromConfig]) {
    const keys = section === undefined ? undefined : staticKeys(section);
    if (keys === "invalid") return refused("unavailable");
    if (keys !== undefined) return { kind: "credentials", credentials: keys, via: "static-keys" };
  }
  if (fromConfig === undefined) return refused("unsupported");
  if (fromConfig.has("sso_account_id") || fromConfig.has("sso_session")) {
    return resolveSso(fromConfig, files.config, ports);
  }
  const process = fromConfig.get("credential_process");
  if (process !== undefined && process.trim().length > 0) {
    return resolveCredentialProcess(process, ports);
  }
  return refused("unsupported");
}

async function assumeProfileRole(
  profileName: string,
  setting: (key: string) => string | undefined,
  files: ProfileFiles,
  ports: AwsProfilePorts,
  assuming: ReadonlyArray<string>,
): Promise<AwsProfileResolution> {
  if (assuming.includes(profileName) || assuming.length >= MAX_ROLE_HOPS) {
    return refused("unsupported");
  }
  const role = readRoleSettings(setting, ports.now());
  if (role === "invalid") return refused("unsupported");
  // The AWS CLI prompts for the code on its terminal; connecting a profile
  // here has no prompt, so the refusal names the cause instead of the token
  // service answering access denied.
  if (setting("mfa_serial") !== undefined) return refused("mfa-required");

  const sourceProfile = setting("source_profile");
  const credentialSource = setting("credential_source");
  const tokenFile = setting("web_identity_token_file");
  if (tokenFile !== undefined) {
    if (sourceProfile !== undefined || credentialSource !== undefined) {
      return refused("unsupported");
    }
    const tokenPath = tokenFile.startsWith("~/")
      ? join(ports.homeDirectory, tokenFile.slice(2))
      : tokenFile;
    const token = (await ports.readFile(tokenPath))?.trim();
    if (
      token === undefined ||
      token.length === 0 ||
      token.length > MAX_WEB_IDENTITY_TOKEN_CHARS ||
      !/^[\x21-\x7e]+$/.test(token)
    )
      return refused("unavailable");
    return fromSts(
      await ports.assumeRoleWithWebIdentity({ ...role, webIdentityToken: token }),
      "web-identity",
    );
  }

  let source: AwsCredentials;
  if (credentialSource !== undefined) {
    // The AWS CLI refuses a profile naming both sources.
    if (sourceProfile !== undefined) return refused("unsupported");
    // Instance and container metadata answer only on that machine's own
    // network; the broker does not read them.
    if (credentialSource !== "Environment") return refused("unsupported");
    const keys = environmentKeys(ports.env);
    if (keys === undefined) return refused("unavailable");
    source = keys;
  } else if (sourceProfile === undefined) {
    return refused("unsupported");
  } else if (sourceProfile === profileName) {
    // A profile that names itself as its source signs with its own keys.
    const keys = staticKeys(
      new Map(
        ["aws_access_key_id", "aws_secret_access_key", "aws_session_token"].flatMap((key) => {
          const value = setting(key);
          return value === undefined ? [] : [[key, value] as const];
        }),
      ),
    );
    if (keys === undefined || keys === "invalid") return refused("unavailable");
    source = keys;
  } else {
    const resolved = await resolveNamedProfile(sourceProfile, files, ports, [
      ...assuming,
      profileName,
    ]);
    if (resolved.kind === "refused") return resolved;
    source = resolved.credentials;
  }
  return fromSts(await ports.assumeRole({ ...role, source }), "assume-role");
}

function readRoleSettings(
  setting: (key: string) => string | undefined,
  now: number,
): AwsAssumeRoleInput | "invalid" {
  const roleArn = setting("role_arn");
  if (roleArn === undefined || !ROLE_ARN_PATTERN.test(roleArn)) return "invalid";
  // The AWS CLI names an unnamed session after itself and the moment.
  const roleSessionName =
    setting("role_session_name") ?? `octant-session-${Math.floor(now / 1_000)}`;
  if (!ROLE_SESSION_NAME_PATTERN.test(roleSessionName)) return "invalid";
  const externalId = setting("external_id");
  if (externalId !== undefined && !EXTERNAL_ID_PATTERN.test(externalId)) return "invalid";
  const duration = setting("duration_seconds");
  let durationSeconds: number | undefined;
  if (duration !== undefined) {
    // The token service's own range for a role session.
    if (!/^[0-9]{3,5}$/.test(duration)) return "invalid";
    durationSeconds = Number(duration);
    if (durationSeconds < 900 || durationSeconds > 43_200) return "invalid";
  }
  const region = setting("region");
  return {
    region: region !== undefined && REGION_PATTERN.test(region) ? region : undefined,
    roleArn,
    roleSessionName,
    ...(externalId === undefined ? {} : { externalId }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

function environmentKeys(
  env: Readonly<Record<string, string | undefined>>,
): AwsCredentials | undefined {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = env.AWS_SESSION_TOKEN;
  if (
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    !isAwsAccessKeyPair(accessKeyId, secretAccessKey) ||
    (sessionToken !== undefined && !isBoundedSecret(sessionToken))
  )
    return undefined;
  return { accessKeyId, secretAccessKey, ...(sessionToken === undefined ? {} : { sessionToken }) };
}

function fromSts(
  outcome: AwsStsOutcome,
  via: "assume-role" | "web-identity",
): AwsProfileResolution {
  if (outcome.kind === "credentials") {
    return { kind: "credentials", credentials: outcome.credentials, via };
  }
  return refused(outcome.kind === "refused" ? "role-refused" : "unavailable");
}

async function resolveSso(
  profile: ReadonlyMap<string, string>,
  config: AwsIni,
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
