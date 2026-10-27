import { createHash, createHmac } from "node:crypto";

/**
 * Signature Version 4, implemented from the cloud's published algorithm with
 * the platform's crypto rather than a cloud SDK. The broker alone calls it:
 * the secret key never leaves the broker, and the request it signs is built
 * here from its fields, never from a digest a caller supplies.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present for temporary credentials; sent and signed as `x-amz-security-token`. */
  readonly sessionToken?: string;
}

/** One request, as its fields: the canonical request is built from these alone. */
export interface SigV4Request {
  readonly method: string;
  readonly host: string;
  /** The request path exactly as it is sent, already percent-encoded once. */
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
  /** Headers to sign besides `host` and the date, with lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The hex SHA-256 of the body the request sends. */
  readonly payloadHash: string;
}

export interface SigV4Signature {
  /** The headers the request carries besides its own: authorization, date, token. */
  readonly headers: Readonly<Record<string, string>>;
  readonly signedHeaders: string;
  readonly signature: string;
}

/** `YYYYMMDDTHHMMSSZ` for a moment, as the signature's date. */
export function sigV4Date(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * RFC 3986 percent-encoding as the algorithm defines it: every byte that is
 * not unreserved, uppercase hex. Applied to a path that is already encoded,
 * it encodes the `%` again, which is the double encoding every service but
 * object storage expects.
 */
export function sigV4UriEncode(value: string): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    encoded += UNRESERVED.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/** The canonical request and the sorted header list it signs. */
export function sigV4CanonicalRequest(
  request: SigV4Request,
  dateHeaders: Readonly<Record<string, string>>,
): { readonly canonical: string; readonly signedHeaders: string } {
  const headers = new Map<string, string>();
  headers.set("host", request.host);
  for (const [name, value] of Object.entries({ ...request.headers, ...dateHeaders })) {
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }
  const names = [...headers.keys()].sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers.get(name) ?? ""}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalUri =
    request.path === "" ? "/" : request.path.split("/").map(sigV4UriEncode).join("/");
  const canonicalQuery = request.query
    .map(([key, value]) => [sigV4UriEncode(key), sigV4UriEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? compare(leftValue, rightValue) : compare(leftKey, rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return {
    canonical: [
      request.method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      request.payloadHash,
    ].join("\n"),
    signedHeaders,
  };
}

/** The key one day's signatures in one region and service are made with. */
export function sigV4SigningKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

/** Sign one request at `amzDate` for a region and service. */
export function signSigV4(input: {
  readonly request: SigV4Request;
  readonly credentials: SigV4Credentials;
  readonly region: string;
  readonly service: string;
  readonly amzDate: string;
}): SigV4Signature {
  const { request, credentials, region, service, amzDate } = input;
  const dateHeaders: Record<string, string> = { "x-amz-date": amzDate };
  if (credentials.sessionToken !== undefined) {
    dateHeaders["x-amz-security-token"] = credentials.sessionToken;
  }
  const { canonical, signedHeaders } = sigV4CanonicalRequest(request, dateHeaders);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac(
    "sha256",
    sigV4SigningKey(credentials.secretAccessKey, date, region, service),
  )
    .update(stringToSign, "utf8")
    .digest("hex");
  return {
    headers: {
      authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...dateHeaders,
    },
    signedHeaders,
    signature,
  };
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** Byte order, which the algorithm sorts by; `localeCompare` would not. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
