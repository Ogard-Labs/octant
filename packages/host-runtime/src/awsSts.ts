import type { AwsCredentials } from "./awsProfileCredentials";
import { issuerRequestDeadline } from "./issuerRequest";
import { sha256Hex, sigV4Date, signSigV4 } from "./sigV4";

/**
 * The two Security Token Service calls an AWS profile that assumes a role
 * needs, made inside the credential broker with its own signer rather than a
 * cloud SDK. The source credentials sign `AssumeRole` and never leave the
 * broker; `AssumeRoleWithWebIdentity` is unsigned, the token itself being the
 * proof. Both speak the query protocol: a form-encoded `POST` and an XML
 * answer.
 */

export type AwsStsOutcome =
  | { readonly kind: "credentials"; readonly credentials: Required<AwsCredentials> }
  /** The service answered and refused: the role does not trust the caller, or the token is not accepted. */
  | { readonly kind: "refused" }
  /** No answer, a throttle, or a server error: worth trying again later. */
  | { readonly kind: "unavailable" };

export interface AwsAssumeRoleInput {
  /** The region whose regional endpoint is asked; absent, the global endpoint. */
  readonly region: string | undefined;
  readonly roleArn: string;
  readonly roleSessionName: string;
  readonly externalId?: string;
  readonly durationSeconds?: number;
}

const STS_VERSION = "2011-06-15";
const MAX_STS_RESPONSE_CHARS = 64 * 1_024;
const ACCESS_KEY_ID_PATTERN = /^[A-Z0-9]{16,128}$/;
const MAX_SECRET_CHARS = 8_192;

/**
 * The regional endpoint for a region, as AWS CLI version 2 uses by default,
 * or the global endpoint (signed for `us-east-1`) when the profile names none.
 */
function stsEndpoint(region: string | undefined): {
  readonly host: string;
  readonly signingRegion: string;
} {
  return region === undefined
    ? { host: "sts.amazonaws.com", signingRegion: "us-east-1" }
    : { host: `sts.${region}.amazonaws.com`, signingRegion: region };
}

export async function stsAssumeRole(
  fetchImpl: typeof fetch,
  now: number,
  input: AwsAssumeRoleInput & { readonly source: AwsCredentials },
): Promise<AwsStsOutcome> {
  const { host, signingRegion } = stsEndpoint(input.region);
  const body = new URLSearchParams({
    Action: "AssumeRole",
    Version: STS_VERSION,
    RoleArn: input.roleArn,
    RoleSessionName: input.roleSessionName,
    ...(input.durationSeconds === undefined
      ? {}
      : { DurationSeconds: String(input.durationSeconds) }),
    ...(input.externalId === undefined ? {} : { ExternalId: input.externalId }),
  }).toString();
  const contentType = "application/x-www-form-urlencoded; charset=utf-8";
  const signed = signSigV4({
    request: {
      method: "POST",
      host,
      path: "/",
      query: [],
      headers: { "content-type": contentType },
      payloadHash: sha256Hex(body),
    },
    credentials: {
      accessKeyId: input.source.accessKeyId,
      secretAccessKey: input.source.secretAccessKey,
      ...(input.source.sessionToken === undefined
        ? {}
        : { sessionToken: input.source.sessionToken }),
    },
    region: signingRegion,
    service: "sts",
    amzDate: sigV4Date(now),
  });
  return postSts(fetchImpl, host, body, { "content-type": contentType, ...signed.headers });
}

export async function stsAssumeRoleWithWebIdentity(
  fetchImpl: typeof fetch,
  input: AwsAssumeRoleInput & { readonly webIdentityToken: string },
): Promise<AwsStsOutcome> {
  const { host } = stsEndpoint(input.region);
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: STS_VERSION,
    RoleArn: input.roleArn,
    RoleSessionName: input.roleSessionName,
    WebIdentityToken: input.webIdentityToken,
    ...(input.durationSeconds === undefined
      ? {}
      : { DurationSeconds: String(input.durationSeconds) }),
  }).toString();
  return postSts(fetchImpl, host, body, {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
  });
}

/**
 * A 400 or 403 is the service refusing (access denied, a malformed or expired
 * token); a 429, a 5xx, or no answer is transient.
 */
async function postSts(
  fetchImpl: typeof fetch,
  host: string,
  body: string,
  headers: Readonly<Record<string, string>>,
): Promise<AwsStsOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`https://${host}/`, {
      method: "POST",
      redirect: "error",
      headers: { ...headers, accept: "text/xml" },
      body,
      signal: issuerRequestDeadline(),
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return response.status === 400 || response.status === 403
      ? { kind: "refused" }
      : { kind: "unavailable" };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "unavailable" };
  }
  if (text.length > MAX_STS_RESPONSE_CHARS) return { kind: "unavailable" };
  return readStsCredentials(text);
}

/** The `<Credentials>` element both answers carry. */
function readStsCredentials(xml: string): AwsStsOutcome {
  const block = /<Credentials>([\s\S]*?)<\/Credentials>/.exec(xml)?.[1];
  if (block === undefined) return { kind: "unavailable" };
  const field = (name: string) =>
    new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block)?.[1];
  const accessKeyId = field("AccessKeyId");
  const secretAccessKey = field("SecretAccessKey");
  const sessionToken = field("SessionToken");
  const expiration = field("Expiration");
  const expiresAt = expiration === undefined ? Number.NaN : Date.parse(expiration);
  if (
    accessKeyId === undefined ||
    !ACCESS_KEY_ID_PATTERN.test(accessKeyId) ||
    secretAccessKey === undefined ||
    !isBoundedSecret(secretAccessKey) ||
    sessionToken === undefined ||
    !isBoundedSecret(sessionToken) ||
    !Number.isFinite(expiresAt)
  )
    return { kind: "unavailable" };
  return {
    kind: "credentials",
    credentials: { accessKeyId, secretAccessKey, sessionToken, expiresAt },
  };
}

function isBoundedSecret(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SECRET_CHARS && /^[\x21-\x7e]+$/.test(value);
}
