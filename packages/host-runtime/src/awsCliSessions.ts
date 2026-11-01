import { sha256Hex, signSigV4, sigV4Date } from "./sigV4";
import {
  isLinkedSecretStoreKind,
  type AwsCliPointer,
  type LinkedSecretRead,
  type LinkedSecretStores,
} from "./linkedSecretStores";

/**
 * Short-lived AWS command-line credentials from a linked secret store
 * (docs/architecture.md, Secret guard).
 *
 * The person points the AWS command line at the two items that hold their
 * access key pair. When Octant's own shell runs a command, the broker reads
 * both items, asks AWS STS for a session (`GetSessionToken`, one hour), and
 * hands out that session alone. The long-lived pair is read at use, never
 * kept, and never leaves the broker, so a command can use AWS without
 * `~/.aws/credentials`, which the secret guard keeps out of reach.
 */

export type AwsCliSession = {
  readonly status: "issued";
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** When AWS ends the session, as AWS wrote it (ISO 8601). */
  readonly expiration: string;
};

export type AwsCliSessionResult =
  | AwsCliSession
  | { readonly status: "none" }
  | Exclude<LinkedSecretRead, { readonly status: "read" }>
  /** AWS refused the key pair, or an item does not hold one. */
  | { readonly status: "refused" };

export interface AwsCliSessions {
  readonly session: () => Promise<AwsCliSessionResult>;
  /** Drops a session issued for an earlier pointer. */
  readonly forget: () => void;
}

/** How long a session lasts. One hour covers a long command; AWS's shortest is 15 minutes. */
export const AWS_CLI_SESSION_SECONDS = 3_600;
/** A session is handed out again only while this much of it is left. */
const REUSE_REMAINING_MS = 15 * 60_000;
/**
 * How long a failed attempt answers for itself before the store and AWS are
 * asked again, so a busy turn with a locked store or a rotated key does not
 * read both items, and sign a refused request, for every command.
 */
const FAILURE_PAUSE_MS = 30_000;
const STS_HOST = "sts.amazonaws.com";
const STS_REGION = "us-east-1";
const MAX_STS_RESPONSE_BYTES = 64 * 1_024;
const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/;
const SECRET_ACCESS_KEY = /^[A-Za-z0-9/+=]{16,256}$/;

export function createAwsCliSessions(options: {
  readonly linked: LinkedSecretStores;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): AwsCliSessions {
  const fetchPort = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let held:
    | { readonly key: string; readonly session: AwsCliSession; readonly endsAt: number }
    | undefined;
  let pending: { readonly key: string; readonly result: Promise<AwsCliSessionResult> } | undefined;
  let failed:
    | { readonly key: string; readonly result: AwsCliSessionResult; readonly until: number }
    | undefined;
  // Bumped by `forget`, so an attempt that started before a change cannot
  // leave its session behind after it.
  let generation = 0;

  const issue = async (pointer: AwsCliPointer, key: string): Promise<AwsCliSessionResult> => {
    const started = generation;
    const result = await attempt(pointer);
    if (started !== generation) return result;
    if (result.status === "issued") {
      const endsAt = Date.parse(result.expiration);
      if (Number.isFinite(endsAt)) held = { key, session: result, endsAt };
    } else {
      failed = { key, result, until: now() + FAILURE_PAUSE_MS };
    }
    return result;
  };

  const attempt = async (pointer: AwsCliPointer): Promise<AwsCliSessionResult> => {
    const accessKeyId = await options.linked.read(pointer.store, pointer.accessKeyIdReference);
    if (accessKeyId.status !== "read") return accessKeyId;
    const secretAccessKey = await options.linked.read(
      pointer.store,
      pointer.secretAccessKeyReference,
    );
    if (secretAccessKey.status !== "read") return secretAccessKey;
    const pair = {
      accessKeyId: accessKeyId.value.trim(),
      secretAccessKey: secretAccessKey.value.trim(),
    };
    if (!ACCESS_KEY_ID.test(pair.accessKeyId) || !SECRET_ACCESS_KEY.test(pair.secretAccessKey)) {
      return { status: "refused" };
    }
    return requestSession(pair, fetchPort, now(), timeoutMs);
  };

  return {
    session: async () => {
      const pointer = await options.linked.awsCliPointer();
      if (pointer === undefined) {
        held = undefined;
        return { status: "none" };
      }
      const key = JSON.stringify(pointer);
      // A store unlinked since the session was issued takes the session with it.
      if (!(await options.linked.isLinked(pointer.store))) return { status: "not-linked" };
      if (held !== undefined && held.key === key && held.endsAt - now() > REUSE_REMAINING_MS) {
        return held.session;
      }
      if (failed !== undefined && failed.key === key && now() < failed.until) {
        return failed.result;
      }
      if (pending?.key === key) return pending.result;
      const result = issue(pointer, key);
      pending = { key, result };
      try {
        return await result;
      } finally {
        if (pending?.result === result) pending = undefined;
      }
    },
    forget: () => {
      generation += 1;
      held = undefined;
      pending = undefined;
      failed = undefined;
    },
  };
}

async function requestSession(
  pair: { readonly accessKeyId: string; readonly secretAccessKey: string },
  fetchPort: typeof fetch,
  epochMs: number,
  timeoutMs: number,
): Promise<AwsCliSessionResult> {
  const body = `Action=GetSessionToken&DurationSeconds=${AWS_CLI_SESSION_SECONDS}&Version=2011-06-15`;
  const contentType = "application/x-www-form-urlencoded; charset=utf-8";
  const signature = signSigV4({
    request: {
      method: "POST",
      host: STS_HOST,
      path: "/",
      query: [],
      headers: { "content-type": contentType },
      payloadHash: sha256Hex(body),
    },
    credentials: pair,
    region: STS_REGION,
    service: "sts",
    amzDate: sigV4Date(epochMs),
  });
  let response: Response;
  try {
    response = await fetchPort(`https://${STS_HOST}/`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": contentType, ...signature.headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: "unavailable" };
  }
  // AWS answers a key it does not accept with 403 (InvalidClientTokenId,
  // SignatureDoesNotMatch); anything else is AWS being unreachable or down.
  if (response.status === 403) return { status: "refused" };
  if (!response.ok) return { status: "unavailable" };
  const text = await boundedText(response);
  if (text === undefined) return { status: "unavailable" };
  const field = (name: string, pattern: string) =>
    new RegExp(`<${name}>(${pattern})</${name}>`).exec(text)?.[1];
  const accessKeyId = field("AccessKeyId", "[A-Z0-9]{16,128}");
  const secretAccessKey = field("SecretAccessKey", "[A-Za-z0-9/+=]{16,256}");
  const sessionToken = field("SessionToken", "[A-Za-z0-9/+=]{16,8192}");
  const expiration = field("Expiration", "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,15}Z");
  if (
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    sessionToken === undefined ||
    expiration === undefined
  ) {
    return { status: "unavailable" };
  }
  return { status: "issued", accessKeyId, secretAccessKey, sessionToken, expiration };
}

async function boundedText(response: Response): Promise<string | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_STS_RESPONSE_BYTES) {
    return undefined;
  }
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_STS_RESPONSE_BYTES) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The AWS command-line routes under `/v1/cloud-cli/aws/`. Like the linked-store
 * routes they answer expected outcomes as `{ status }` with HTTP 200, and a
 * malformed request is a 400. `reference` and `clear` return the pointer (a
 * store and two item references), never what the items hold; `session` returns
 * the short-lived session and nothing of the long-lived pair.
 */
export async function handleAwsCliBrokerRoute(
  operation: string,
  body: Readonly<Record<string, unknown>>,
  linked: LinkedSecretStores,
  sessions: AwsCliSessions,
): Promise<Response> {
  const keys = Object.keys(body).sort().join(",");
  if (operation === "session") {
    if (keys !== "") return invalid();
    return Response.json(await sessions.session());
  }
  if (operation === "reference" || operation === "clear") {
    if (keys !== "") return invalid();
    const pointer = await linked.awsCliPointer();
    if (pointer === undefined) return Response.json({ status: "none" });
    if (operation === "clear") {
      await linked.setAwsCliPointer(undefined);
      sessions.forget();
    }
    return Response.json({ status: operation === "clear" ? "cleared" : "linked", ...pointer });
  }
  if (operation !== "point" && operation !== "restore") return invalid();
  const { store, accessKeyIdReference, secretAccessKeyReference } = body;
  if (
    keys !== "accessKeyIdReference,secretAccessKeyReference,store" ||
    !isLinkedSecretStoreKind(store) ||
    typeof accessKeyIdReference !== "string" ||
    typeof secretAccessKeyReference !== "string"
  ) {
    return invalid();
  }
  const pointer: AwsCliPointer = { store, accessKeyIdReference, secretAccessKeyReference };
  if (operation === "point") {
    // Both items must resolve now, so a pointer never names an item that is
    // not there. Neither value is returned.
    for (const reference of [accessKeyIdReference, secretAccessKeyReference]) {
      const checked = await linked.check(store, reference);
      if (checked.status !== "found") return Response.json({ status: checked.status });
    }
  } else {
    // Puts back a pointer that was just replaced, without reading its items,
    // which may be gone or locked by now.
    if (
      !linked.isValidReference(store, accessKeyIdReference) ||
      !linked.isValidReference(store, secretAccessKeyReference)
    ) {
      return Response.json({ status: "invalid-reference" });
    }
    if (!(await linked.isLinked(store))) return Response.json({ status: "not-linked" });
  }
  await linked.setAwsCliPointer(pointer);
  sessions.forget();
  return Response.json({ status: "pointed" });
}

function invalid(): Response {
  return Response.json({ error: "invalid-request" }, { status: 400 });
}
