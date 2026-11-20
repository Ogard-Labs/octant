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
 * Environment`, of EC2 IMDSv2 for `credential_source = Ec2InstanceMetadata`,
 * of ECS container metadata for `credential_source = EcsContainer`, or with
 * the token in its `web_identity_token_file`. A role that names `mfa_serial`
 * requires a one-time 6-digit MFA code at connect time; its assumed temporary
 * credentials must be kept in memory only and never persisted.
 */

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Epoch milliseconds; absent for long-lived keys. */
  readonly expiresAt?: number;
}

/** Exact user-facing refusal when EC2/ECS metadata cannot be reached on this computer. */
export const AWS_METADATA_UNREACHABLE_MESSAGE =
  "This profile reads credentials from EC2/ECS metadata, which this computer can't reach.";

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
  /** The role names an `mfa_serial` and no MFA code was supplied yet. */
  | "mfa-required"
  /** The supplied MFA code is not a valid 6-digit code. */
  | "mfa-invalid"
  /** The token service rejected the supplied MFA code or refused to assume the role. */
  | "mfa-refused"
  /** EC2 IMDSv2 or ECS container metadata could not be reached or timed out. */
  | "metadata-unreachable"
  /** The token service refused to assume the role for these source credentials or token. */
  | "role-refused"
  | "unavailable";

export type AwsProfileResolution =
  | {
      readonly kind: "credentials";
      readonly credentials: AwsCredentials;
      readonly via: "static-keys" | "sso" | "credential-process" | "assume-role" | "web-identity";
      /**
       * True when any hop in the profile chain assumed a role using `mfa_serial`.
       * Callers must keep these temporary session credentials in memory only and
       * never persist them to a credential store or journal.
       */
      readonly mfaSession?: true;
    }
  | {
      readonly kind: "refused";
      readonly reason: AwsProfileRefusal;
      readonly message?: string;
    };

export interface ResolveAwsProfileOptions {
  /** One-time 6-digit MFA code for a role profile declaring `mfa_serial`. */
  readonly mfaCode?: string;
}

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
  /** Fetch implementation for EC2 IMDSv2 and ECS container metadata requests. */
  readonly fetchMetadata?: typeof fetch;
  /** Test overrides for local fake HTTP servers standing in for IMDSv2 / ECS metadata hosts. */
  readonly metadataEndpoints?: {
    readonly imdsBaseUrl?: string;
    readonly ecsRelativeBaseUrl?: string;
  };
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
export const AWS_MFA_TOKEN_CODE_PATTERN = /^[0-9]{6}$/;
const ACCESS_KEY_ID_PATTERN = /^[A-Z0-9]{16,128}$/;
const REGION_PATTERN = /^(?!cn-)[a-z]{2}-[a-z]{4,9}-[1-9]$/;
const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/;
const ROLE_NAME_PATTERN = /^[A-Za-z0-9+=,.@_-]{1,64}$/;
const IMDS_ROLE_NAME_PATTERN = /^[A-Za-z0-9+=,.@_-]{1,128}$/;
const MFA_SERIAL_PATTERN = /^[\w+=/:,.@-]{9,256}$/;
const MAX_SECRET_CHARS = 8_192;
const MAX_PROCESS_OUTPUT_CHARS = 64 * 1_024;
const MAX_METADATA_RESPONSE_CHARS = 64 * 1_024;
// 1 s bound per metadata request so a computer off EC2/ECS fails fast.
const METADATA_TIMEOUT_MS = 1_000;
const IMDS_DEFAULT_BASE_URL = "http://169.254.169.254";
const IMDS_TOKEN_TTL_SECONDS = "21600";
const ECS_DEFAULT_RELATIVE_BASE_URL = "http://169.254.170.2";
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

/** Whether a supplied MFA code has the 6-digit shape STS `AssumeRole` takes. */
export function isValidAwsMfaCode(code: string): boolean {
  return AWS_MFA_TOKEN_CODE_PATTERN.test(code);
}

export async function resolveAwsProfileCredentials(
  profileName: string,
  ports: AwsProfilePorts,
  options?: ResolveAwsProfileOptions,
): Promise<AwsProfileResolution> {
  if (!AWS_PROFILE_NAME_PATTERN.test(profileName)) return refused("profile-missing");
  const configPath = ports.env.AWS_CONFIG_FILE ?? join(ports.homeDirectory, ".aws", "config");
  const credentialsPath =
    ports.env.AWS_SHARED_CREDENTIALS_FILE ?? join(ports.homeDirectory, ".aws", "credentials");
  const files: ProfileFiles = {
    config: parseAwsIni((await ports.readFile(configPath)) ?? ""),
    shared: parseAwsIni((await ports.readFile(credentialsPath)) ?? ""),
  };
  const mfa: MfaContext = { code: options?.mfaCode, used: false };
  return resolveNamedProfile(profileName, files, ports, [], mfa);
}

interface MfaContext {
  readonly code: string | undefined;
  used: boolean;
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
  mfa: MfaContext,
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
    return assumeProfileRole(profileName, setting, files, ports, assuming, mfa);
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
  mfa: MfaContext,
): Promise<AwsProfileResolution> {
  if (assuming.includes(profileName) || assuming.length >= MAX_ROLE_HOPS) {
    return refused("unsupported");
  }
  const role = readRoleSettings(setting, ports.now());
  if (role === "invalid") return refused("unsupported");
  const mfaSerial = setting("mfa_serial");
  if (mfaSerial !== undefined) {
    if (!MFA_SERIAL_PATTERN.test(mfaSerial)) return refused("unsupported");
    if (setting("web_identity_token_file") !== undefined) return refused("unsupported");
    if (mfa.code === undefined) return refused("mfa-required");
    if (!isValidAwsMfaCode(mfa.code)) return refused("mfa-invalid");
  }

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
  let sourceMfaSession = false;
  if (credentialSource !== undefined) {
    // The AWS CLI refuses a profile naming both sources.
    if (sourceProfile !== undefined) return refused("unsupported");
    if (credentialSource === "Environment") {
      const keys = environmentKeys(ports.env);
      if (keys === undefined) return refused("unavailable");
      source = keys;
    } else if (credentialSource === "Ec2InstanceMetadata") {
      const metadata = await resolveEc2ImdsV2Credentials(ports);
      if (metadata === undefined) return refused("metadata-unreachable");
      source = metadata;
    } else if (credentialSource === "EcsContainer") {
      const metadata = await resolveEcsContainerCredentials(ports);
      if (metadata === undefined) return refused("metadata-unreachable");
      source = metadata;
    } else {
      return refused("unsupported");
    }
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
    const resolved = await resolveNamedProfile(
      sourceProfile,
      files,
      ports,
      [...assuming, profileName],
      mfa,
    );
    if (resolved.kind === "refused") return resolved;
    source = resolved.credentials;
    sourceMfaSession = resolved.mfaSession === true;
  }

  if (mfaSerial !== undefined) {
    // One 6-digit TOTP code cannot be replayed across two MFA-gated hops.
    if (mfa.used || mfa.code === undefined) return refused("mfa-required");
    mfa.used = true;
    const outcome = await ports.assumeRole({
      ...role,
      serialNumber: mfaSerial,
      tokenCode: mfa.code,
      source,
    });
    if (outcome.kind === "credentials") {
      return {
        kind: "credentials",
        credentials: outcome.credentials,
        via: "assume-role",
        mfaSession: true,
      };
    }
    return refused(outcome.kind === "refused" ? "mfa-refused" : "unavailable");
  }

  return fromSts(await ports.assumeRole({ ...role, source }), "assume-role", sourceMfaSession);
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
  mfaSession = false,
): AwsProfileResolution {
  if (outcome.kind === "credentials") {
    return {
      kind: "credentials",
      credentials: outcome.credentials,
      via,
      ...(mfaSession ? { mfaSession: true as const } : {}),
    };
  }
  return refused(outcome.kind === "refused" ? "role-refused" : "unavailable");
}

/**
 * EC2 IMDSv2: request a session token with `PUT /latest/api/token`, list the
 * instance profile role name, and fetch that role's temporary credentials. Each
 * metadata HTTP call has a strict 1 s timeout and refuses redirects.
 */
async function resolveEc2ImdsV2Credentials(
  ports: AwsProfilePorts,
): Promise<AwsCredentials | undefined> {
  if (ports.env.AWS_EC2_METADATA_DISABLED?.trim().toLowerCase() === "true") return undefined;
  const baseUrl = resolveImdsBaseUrl(ports);
  if (baseUrl === undefined) return undefined;
  const fetchImpl = ports.fetchMetadata ?? globalThis.fetch;

  const tokenText = await fetchMetadataText(fetchImpl, `${baseUrl}/latest/api/token`, {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": IMDS_TOKEN_TTL_SECONDS },
  });
  if (tokenText === undefined) return undefined;
  const token = tokenText.trim();
  if (token.length === 0 || token.length > 4_096 || !/^[\x21-\x7e]+$/.test(token)) {
    return undefined;
  }

  const roleListText = await fetchMetadataText(
    fetchImpl,
    `${baseUrl}/latest/meta-data/iam/security-credentials/`,
    {
      method: "GET",
      headers: { "x-aws-ec2-metadata-token": token },
    },
  );
  if (roleListText === undefined) return undefined;
  const roleName = roleListText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (roleName === undefined || !IMDS_ROLE_NAME_PATTERN.test(roleName)) return undefined;

  const credentialsText = await fetchMetadataText(
    fetchImpl,
    `${baseUrl}/latest/meta-data/iam/security-credentials/${encodeURIComponent(roleName)}`,
    {
      method: "GET",
      headers: { "x-aws-ec2-metadata-token": token },
    },
  );
  return credentialsText === undefined ? undefined : parseMetadataCredentialsJson(credentialsText);
}

/**
 * ECS / EKS container credentials: reads `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
 * against `169.254.170.2` or a validated `AWS_CONTAINER_CREDENTIALS_FULL_URI`
 * (HTTPS, or HTTP only on loopback or AWS link-local container endpoints),
 * attaching `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` (preferred) or
 * `AWS_CONTAINER_AUTHORIZATION_TOKEN`. Bounded by a 1 s timeout.
 */
async function resolveEcsContainerCredentials(
  ports: AwsProfilePorts,
): Promise<AwsCredentials | undefined> {
  const targetUrl = resolveEcsCredentialsUrl(ports);
  if (targetUrl === undefined) return undefined;
  const authHeader = await resolveEcsAuthorizationHeader(ports);
  if (authHeader === "invalid") return undefined;
  const fetchImpl = ports.fetchMetadata ?? globalThis.fetch;
  const text = await fetchMetadataText(fetchImpl, targetUrl, {
    method: "GET",
    headers: authHeader === undefined ? {} : { authorization: authHeader },
  });
  return text === undefined ? undefined : parseMetadataCredentialsJson(text);
}

function resolveImdsBaseUrl(ports: AwsProfilePorts): string | undefined {
  const override = ports.metadataEndpoints?.imdsBaseUrl;
  if (override !== undefined) return stripTrailingSlashes(override);
  const configured = ports.env.AWS_EC2_METADATA_SERVICE_ENDPOINT?.trim();
  if (configured === undefined || configured.length === 0) return IMDS_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (!isLoopbackHostname(host) && host !== "169.254.169.254" && host !== "[fd00:ec2::254]") {
    return undefined;
  }
  return url.origin;
}

function resolveEcsCredentialsUrl(ports: AwsProfilePorts): string | undefined {
  const relative = ports.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
  if (relative !== undefined && relative.length > 0) {
    if (!relative.startsWith("/") || !/^\/[\x21-\x7e]{0,2048}$/.test(relative)) return undefined;
    if (relative.split(/[/?#]/).some((segment) => segment === "..")) return undefined;
    const base = stripTrailingSlashes(
      ports.metadataEndpoints?.ecsRelativeBaseUrl ?? ECS_DEFAULT_RELATIVE_BASE_URL,
    );
    return `${base}${relative}`;
  }
  const full = ports.env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim();
  if (full === undefined || full.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(full);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.protocol === "https:") return url.toString();
  if (url.protocol !== "http:") return undefined;
  const host = url.hostname.toLowerCase();
  // AWS SDK container credential safety rules: plain HTTP is allowed only for
  // loopback or the ECS (169.254.170.2) / EKS Pod Identity (169.254.170.23,
  // [fd00:ec2::254]) link-local metadata endpoints.
  if (
    isLoopbackHostname(host) ||
    host === "169.254.170.2" ||
    host === "169.254.170.23" ||
    host === "[fd00:ec2::254]"
  ) {
    return url.toString();
  }
  return undefined;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

function isLoopbackHostname(host: string): boolean {
  if (host === "localhost" || host === "[::1]") return true;
  return /^127\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(
    host,
  );
}

async function resolveEcsAuthorizationHeader(
  ports: AwsProfilePorts,
): Promise<string | "invalid" | undefined> {
  const tokenFile = ports.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE?.trim();
  if (tokenFile !== undefined && tokenFile.length > 0) {
    const raw = (await ports.readFile(tokenFile))?.trim();
    if (raw === undefined || !isSafeHeaderToken(raw)) return "invalid";
    return raw;
  }
  const inline = ports.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  if (inline !== undefined && inline.length > 0) {
    if (!isSafeHeaderToken(inline)) return "invalid";
    return inline;
  }
  return undefined;
}

function isSafeHeaderToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SECRET_CHARS && /^[\x20-\x7e]+$/.test(value);
}

async function fetchMetadataText(
  fetchImpl: typeof fetch,
  url: string,
  init: { readonly method: "GET" | "PUT"; readonly headers: Readonly<Record<string, string>> },
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const text = await response.text();
    return text.length > MAX_METADATA_RESPONSE_CHARS ? undefined : text;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function parseMetadataCredentialsJson(text: string): AwsCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.Code !== undefined && parsed.Code !== "Success") return undefined;
  const { AccessKeyId, SecretAccessKey, Token, Expiration } = parsed;
  if (
    typeof AccessKeyId !== "string" ||
    typeof SecretAccessKey !== "string" ||
    !isAwsAccessKeyPair(AccessKeyId, SecretAccessKey) ||
    (Token !== undefined && (typeof Token !== "string" || !isBoundedSecret(Token))) ||
    (Expiration !== undefined && typeof Expiration !== "string")
  ) {
    return undefined;
  }
  const expiresAt = Expiration === undefined ? undefined : Date.parse(Expiration);
  if (expiresAt !== undefined && !Number.isFinite(expiresAt)) return undefined;
  return {
    accessKeyId: AccessKeyId,
    secretAccessKey: SecretAccessKey,
    ...(Token === undefined ? {} : { sessionToken: Token }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
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
  return reason === "metadata-unreachable"
    ? { kind: "refused", reason, message: AWS_METADATA_UNREACHABLE_MESSAGE }
    : { kind: "refused", reason };
}

function isBoundedSecret(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SECRET_CHARS && /^[\x21-\x7e]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
