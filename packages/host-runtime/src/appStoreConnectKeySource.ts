import { execFile } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { delimiter } from "node:path";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";

/**
 * A 1Password secret reference a person saves in place of the App Store
 * Connect private key: `op://<vault>/<item>/<field>`, optionally with a
 * section before the field. Names may hold spaces; no query (`?attribute=`),
 * fragment, or control character is accepted, so the reference names one
 * field and nothing else.
 */
export const ONE_PASSWORD_REFERENCE = /^op:\/\/[^/?#\p{Cc}]{1,128}(?:\/[^/?#\p{Cc}]{1,128}){2,3}$/u;

/** App Store Connect refuses a token that lives longer than twenty minutes. */
export const APP_STORE_CONNECT_TOKEN_LIFETIME_SECONDS = 15 * 60;

const ISSUER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Z0-9]{10}$/;
const ONE_PASSWORD_TIMEOUT_MS = 2 * 60_000;
const MAX_KEY_BYTES = 16 * 1_024;

/** What the person's `op read` gave: the field's value, or nothing usable. */
export type OnePasswordReadResult =
  | { readonly kind: "read"; readonly value: string }
  | { readonly kind: "unavailable" };

/**
 * Reads one 1Password field with the person's own `op` CLI. Injected so tests
 * never run `op`; the broker's default runs it.
 */
export type OnePasswordRead = (reference: string) => Promise<OnePasswordReadResult>;

export interface AppStoreConnectKey {
  readonly issuerId: string;
  readonly keyId: string;
  /** A PKCS #8 P-256 private key in PEM, held for one operation only. */
  readonly privateKey: string;
}

export type AppStoreConnectKeyRead =
  | { readonly kind: "key"; readonly key: AppStoreConnectKey }
  | { readonly kind: "invalid-stored-key" }
  | { readonly kind: "key-source-unavailable" };

/**
 * The key the stored entry names, from where the person chose to keep it: the
 * entry itself, or a 1Password field read now with `op`, for this one
 * operation. A missing or signed-out `op`, a declined approval, or a field
 * that is not an App Store Connect key all refuse as `key-source-unavailable`,
 * and nothing retries: a second `op` prompt the person did not ask for would
 * be a surprise.
 */
export async function readAppStoreConnectKey(
  stored: string,
  readOnePassword: OnePasswordRead,
): Promise<AppStoreConnectKeyRead> {
  const entry = storedEntry(stored);
  if (entry === undefined) return { kind: "invalid-stored-key" };
  if (entry.source === "stored") {
    return { kind: "key", key: entry.key };
  }
  let read: OnePasswordReadResult;
  try {
    read = await readOnePassword(entry.reference);
  } catch {
    return { kind: "key-source-unavailable" };
  }
  if (read.kind !== "read") return { kind: "key-source-unavailable" };
  const privateKey = read.value.trim();
  if (!isAppStoreConnectPrivateKey(privateKey)) return { kind: "key-source-unavailable" };
  return {
    kind: "key",
    key: { issuerId: entry.issuerId, keyId: entry.keyId, privateKey: `${privateKey}\n` },
  };
}

/**
 * An App Store Connect API token: an ES256 JSON Web Token naming the key in
 * its header and the issuer, audience, and a lifetime of at most twenty
 * minutes in its claims, signed with the platform's crypto.
 */
export function signAppStoreConnectToken(key: AppStoreConnectKey, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1_000);
  const header = { alg: "ES256", kid: key.keyId, typ: "JWT" };
  const claims = {
    iss: key.issuerId,
    iat: issuedAt,
    exp: issuedAt + APP_STORE_CONNECT_TOKEN_LIFETIME_SECONDS,
    aud: "appstoreconnect-v1",
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  // JOSE takes an ECDSA signature as the raw r || s pair, not DER.
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey({ key: key.privateKey, format: "pem" }),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * The broker's `sign-token` route: it reads the stored key from its source,
 * signs one token, and answers only that token. The request names the
 * credential reference and nothing else, so a caller cannot choose the
 * claims, the lifetime, or the key.
 */
export async function handleAppStoreConnectTokenRoute(
  request: Request,
  store: CredentialStore,
  readOnePassword: OnePasswordRead,
  now: () => number,
): Promise<Response> {
  const credentialRef = await readCredentialRef(request);
  if (credentialRef === undefined) return failure("invalid-request", 400);
  let stored: string;
  try {
    stored = await store.resolve(credentialRef);
  } catch (error) {
    if (error instanceof CredentialStoreFailure) {
      const status =
        error.category === "missing" ? 404 : error.category === "unavailable" ? 503 : 500;
      return failure(error.category, status);
    }
    return failure("failed", 503);
  }
  const read = await readAppStoreConnectKey(stored, readOnePassword);
  if (read.kind === "invalid-stored-key") return failure("invalid-stored-key", 500);
  if (read.kind === "key-source-unavailable") return failure("key-source-unavailable", 424);
  try {
    return Response.json({ token: signAppStoreConnectToken(read.key, now()) });
  } catch {
    return failure("invalid-stored-key", 500);
  }
}

/**
 * Runs the person's `op read` for one reference. `op` asks the person to
 * approve through the 1Password app when its desktop integration is on, and
 * fails when it is missing, signed out, or declined; each is the same
 * refusal to the caller.
 */
export const readOnePasswordWithCli: OnePasswordRead = async (reference) => {
  if (!ONE_PASSWORD_REFERENCE.test(reference)) return { kind: "unavailable" };
  return await new Promise((resolve) => {
    execFile(
      "op",
      ["read", "--no-newline", reference],
      {
        encoding: "utf8",
        env: onePasswordEnvironment(process.env),
        maxBuffer: MAX_KEY_BYTES,
        timeout: ONE_PASSWORD_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(error === null ? { kind: "read", value: stdout } : { kind: "unavailable" });
      },
    );
  });
};

/**
 * What `op` is given: where to find it and the person's own 1Password
 * settings, never the broker's or another credential's environment. A desktop
 * app started from the Dock has a short PATH, so the usual install folders are
 * added after it.
 */
export function onePasswordEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (name === "HOME" || name === "USER" || name === "LANG" || name.startsWith("OP_")) {
      kept[name] = value;
    }
  }
  kept.PATH = [environment.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter((entry): entry is string => entry !== undefined && entry !== "")
    .join(delimiter);
  return kept;
}

/** App Store Connect issues ES256 keys: a PKCS #8 P-256 private key in PEM. */
export function isAppStoreConnectPrivateKey(pem: string): boolean {
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")) return false;
  try {
    const key = createPrivateKey({ key: pem, format: "pem" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

type StoredEntry =
  | {
      readonly source: "stored";
      readonly key: AppStoreConnectKey;
    }
  | {
      readonly source: "1password";
      readonly issuerId: string;
      readonly keyId: string;
      readonly reference: string;
    };

function storedEntry(stored: string): StoredEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { version, issuerId, keyId, privateKey, onePasswordReference } = value as Record<
    string,
    unknown
  >;
  if (
    version !== 1 ||
    typeof issuerId !== "string" ||
    typeof keyId !== "string" ||
    !ISSUER_ID.test(issuerId) ||
    !KEY_ID.test(keyId)
  ) {
    return undefined;
  }
  if (typeof privateKey === "string" && onePasswordReference === undefined) {
    if (!privateKey.startsWith("-----BEGIN PRIVATE KEY-----")) return undefined;
    return { source: "stored", key: { issuerId, keyId, privateKey } };
  }
  if (
    typeof onePasswordReference === "string" &&
    privateKey === undefined &&
    ONE_PASSWORD_REFERENCE.test(onePasswordReference)
  ) {
    return { source: "1password", issuerId, keyId, reference: onePasswordReference };
  }
  return undefined;
}

async function readCredentialRef(request: Request): Promise<string | undefined> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 1_024) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).join(",") !== "credentialRef") return undefined;
  const credentialRef = record.credentialRef;
  return typeof credentialRef === "string" && ISSUER_ID.test(credentialRef)
    ? credentialRef
    : undefined;
}

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function failure(error: string, status: number): Response {
  return Response.json({ error }, { status });
}
