// The device's side of opening a dev server that runs on another paired
// computer: its proxy session, its grants, and the one signing door the
// desktop's forwarder may knock on.
//
// It runs where the device key lives (an Octant window's renderer), because
// that key is non-extractable. The forwarder in the desktop's main process
// holds no key: for each request a page sends, it asks this client to sign,
// and this client signs only a request for the proxy route of a grant it was
// given, so the channel can never sign a product request.

import {
  decodeHostAnswer,
  RemoteServerGrantResult,
  type RemoteServerGrant,
  type RemoteServerGrantRefusalReason,
  type RemoteServerGrantSource,
} from "@octant/contracts";
import { canonicalizeRemotePathQuery } from "@octant/domain";
import { bindFetchPort } from "./bindFetchPort";
import {
  RemoteConnectionError,
  signRemoteRequest,
  type RemoteSessionFacts,
} from "./remoteConnection";

const PROXY_SESSION_COOKIE = "__Secure-octant-server-proxy-session";
const PROXY_ROUTE_PREFIX = "/api/server-proxy/";
const GRANTS_PATH = "/api/server-proxy/grants";
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const METHOD_PATTERN = /^[A-Z][A-Z0-9-]{0,15}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface RemoteServerProxyClientOptions {
  /** The paired host's private listener origin, exactly as its pairing record holds it. */
  readonly origin: string;
  /** The host's name, for the words a refusal shows. */
  readonly hostName: string;
  readonly fetch: typeof globalThis.fetch;
  /** Mints a proxy session with this device's key; `RemoteConnection.issueServerProxySession`. */
  readonly issueSession: () => Promise<RemoteSessionFacts>;
  /** Signs with this device's non-extractable key. */
  readonly sign: (payload: string) => Promise<string>;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

/**
 * Why a grant was not opened. The host's own refusals pass through with its
 * words; the rest are this device's standing or the network:
 *
 * - `device-revoked`: the host no longer accepts this device's key.
 * - `host-unreachable`: the host did not answer, or answered something else.
 * - `host-busy`: the host's proxy budget for this device is full for now.
 */
export type RemoteServerProxyRefusalReason =
  | RemoteServerGrantRefusalReason
  | "device-revoked"
  | "host-unreachable"
  | "host-busy";

export type RemoteServerProxyOpening =
  | { readonly status: "opened"; readonly grant: RemoteServerGrant }
  | {
      readonly status: "refused";
      readonly reason: RemoteServerProxyRefusalReason;
      readonly message: string;
    };

/** One request a page sent, as the forwarder asks for its proof. The body stays with the forwarder. */
export interface RemoteServerRelayRequest {
  readonly grantId: string;
  readonly method: string;
  /** The full path on the host: `/api/server-proxy/<grant id>` and the page's path and query. */
  readonly pathQuery: string;
  /** SHA-256 of the body bytes the forwarder will send, lowercase hex. */
  readonly bodyDigest: string;
}

export type RemoteServerRelaySigning =
  | {
      readonly status: "signed";
      /** Octant's headers for the request: session cookie, proof, CSRF, origin. */
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly status: "refused";
      /**
       * - `grant-not-held`: this client was never given the grant, or its session ended.
       * - `outside-grant`: the path is not under that grant's proxy route.
       * - `invalid-request`: the method or body digest is malformed.
       */
      readonly reason: "grant-not-held" | "outside-grant" | "invalid-request";
    };

export interface RemoteServerProxyClient {
  /** Asks the host for a grant to one listed server, minting a proxy session first when needed. */
  readonly openGrant: (
    source: RemoteServerGrantSource,
    signal?: AbortSignal,
  ) => Promise<RemoteServerProxyOpening>;
  /** Signs one relayed request for a grant this client holds, and nothing else. */
  readonly signRelayRequest: (
    request: RemoteServerRelayRequest,
  ) => Promise<RemoteServerRelaySigning>;
  /** Drops the proxy session and every grant under it, as when the host is removed. */
  readonly forget: () => void;
}

export function createRemoteServerProxyClient(
  options: RemoteServerProxyClientOptions,
): RemoteServerProxyClient {
  const fetch = bindFetchPort(options.fetch);
  const now = options.now ?? (() => Date.now());
  const randomUuid = options.randomUuid ?? (() => globalThis.crypto.randomUUID());
  // A grant is bound on the host to the proxy session it was minted under, so
  // the grants this client holds are the session's and go with it.
  let session: { readonly facts: RemoteSessionFacts; readonly grants: Set<string> } | undefined;
  let issuing: Promise<RemoteSessionFacts> | undefined;

  const refused = (
    reason: RemoteServerProxyRefusalReason,
    message: string,
  ): RemoteServerProxyOpening => ({ status: "refused", reason, message });
  const revoked = () =>
    refused(
      "device-revoked",
      `This computer no longer has access to ${options.hostName}. Pair it again to open servers there.`,
    );
  const unreachable = () =>
    refused(
      "host-unreachable",
      `Can't reach ${options.hostName}. Check that it's on and on the same network.`,
    );
  const busy = () =>
    refused(
      "host-busy",
      `${options.hostName} is busy with other requests from this computer. Try again in a moment.`,
    );

  const ensureSession = async () => {
    if (session !== undefined) return session;
    issuing ??= options.issueSession().finally(() => {
      issuing = undefined;
    });
    const facts = await issuing;
    session ??= { facts, grants: new Set() };
    return session;
  };

  const signedHeaders = async (
    facts: RemoteSessionFacts,
    method: string,
    canonicalPathQuery: string,
    bodyDigest: string,
  ): Promise<Record<string, string>> => {
    const { proofHeader } = await signRemoteRequest({
      session: facts,
      method,
      canonicalPathQuery,
      bodyDigest,
      sign: options.sign,
      now: now(),
    });
    const headers: Record<string, string> = {
      origin: options.origin,
      "sec-fetch-site": "same-origin",
      cookie: `${PROXY_SESSION_COOKIE}=${facts.sessionId}`,
      "x-octant-device-proof": proofHeader,
    };
    if (!SAFE_METHODS.has(method)) {
      headers["x-octant-csrf"] = facts.csrfToken;
      headers["x-octant-command-id"] = randomUuid();
    }
    return headers;
  };

  const openGrant = async (
    source: RemoteServerGrantSource,
    signal?: AbortSignal,
  ): Promise<RemoteServerProxyOpening> => {
    // A session the host has forgotten (idle expiry, a host restart) answers
    // 401 once; a fresh one is minted and the request asked again, once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let current: Awaited<ReturnType<typeof ensureSession>>;
      try {
        current = await ensureSession();
      } catch (error) {
        return error instanceof RemoteConnectionError && error.category === "unauthorized"
          ? revoked()
          : unreachable();
      }
      const body = new TextEncoder().encode(
        JSON.stringify({ kind: "open-remote-server-grant", requestId: randomUuid(), source }),
      );
      let response: Response;
      try {
        const headers = await signedHeaders(
          current.facts,
          "POST",
          GRANTS_PATH,
          await sha256Hex(body),
        );
        response = await fetch(new URL(GRANTS_PATH, options.origin).toString(), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body,
          credentials: "include",
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        return unreachable();
      }
      if (response.status === 401) {
        if (session === current) session = undefined;
        if ((await reasonCode(response)) !== undefined || attempt === 1) return revoked();
        continue;
      }
      if (response.status === 429 || response.status === 503) return busy();
      if (!response.ok) return unreachable();
      let result: RemoteServerGrantResult;
      try {
        result = decodeHostAnswer(RemoteServerGrantResult)(await response.json());
      } catch {
        return unreachable();
      }
      if (result.kind === "remote-server-grant-refused") {
        return refused(result.refusal.reason, result.refusal.message);
      }
      current.grants.add(String(result.grant.grantId));
      return { status: "opened", grant: result.grant };
    }
    return revoked();
  };

  const signRelayRequest = async (
    request: RemoteServerRelayRequest,
  ): Promise<RemoteServerRelaySigning> => {
    if (!METHOD_PATTERN.test(request.method) || !DIGEST_PATTERN.test(request.bodyDigest)) {
      return { status: "refused", reason: "invalid-request" };
    }
    const current = session;
    if (current === undefined || !current.grants.has(request.grantId)) {
      return { status: "refused", reason: "grant-not-held" };
    }
    // Judge the path the host will see, after the same normalization, so a
    // dot segment cannot climb from the grant's route to another.
    const canonical = canonicalizeRemotePathQuery(request.pathQuery);
    const grantPath = `${PROXY_ROUTE_PREFIX}${request.grantId}`;
    const path = canonical?.split("?", 1)[0];
    if (canonical === undefined || (path !== grantPath && !path?.startsWith(`${grantPath}/`))) {
      return { status: "refused", reason: "outside-grant" };
    }
    return {
      status: "signed",
      headers: await signedHeaders(current.facts, request.method, canonical, request.bodyDigest),
    };
  };

  return {
    openGrant,
    signRelayRequest,
    forget: () => {
      session = undefined;
    },
  };
}

async function reasonCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { readonly reasonCode?: unknown };
    return body.reasonCode === "revoked" || body.reasonCode === "expired"
      ? body.reasonCode
      : undefined;
  } catch {
    return undefined;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
