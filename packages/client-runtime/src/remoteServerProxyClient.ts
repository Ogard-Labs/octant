// The device's side of opening a dev server that runs on another paired
// computer: its proxy session, its grants, and the one signing door the
// desktop's forwarder may knock on.
//
// It runs where the device key lives (an Octant window's renderer), because
// that key is non-extractable. The forwarder in the desktop's main process
// holds no key: for each request a page sends, it asks this client to sign,
// and this client signs only a request for the proxy route of a grant it was
// given, so the channel can never sign a product request.
//
// A port forward rides the same session: the host opens it for a port on its
// own loopback (one the person picked, or the one a thread's listed server
// holds, which the host reads itself), and this client then signs only the
// WebSocket upgrade of each connection the desktop carries for it, at the
// forward's exact path.

import {
  decodeHostAnswer,
  RemotePortForwardResult,
  RemoteServerGrantResult,
  type RemotePortForward,
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
const FORWARDS_PATH = "/api/server-proxy/forwards";
const GRANT_ID_PATTERN = /^rsg_[0-9a-f]{64}$/;
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

export type RemotePortForwardOpening =
  | { readonly status: "opened"; readonly forward: RemotePortForward }
  | {
      readonly status: "refused";
      readonly reason:
        | RemoteServerProxyRefusalReason
        | Extract<
            RemotePortForwardResult,
            { readonly kind: "remote-port-forward-refused" }
          >["reason"];
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

export type RemoteServerProxyAdoption =
  | { readonly status: "adopted" }
  | {
      readonly status: "refused";
      readonly reason: "device-revoked" | "host-unreachable" | "invalid-grant";
      readonly message: string;
    };

export interface RemoteServerProxyClient {
  /** Asks the host for a grant to one listed server, minting a proxy session first when needed. */
  readonly openGrant: (
    source: RemoteServerGrantSource,
    signal?: AbortSignal,
  ) => Promise<RemoteServerProxyOpening>;
  /**
   * Asks the host to forward one port on its own loopback to this device: a
   * port the person picked, or a thread's listed server, whose port the host
   * reads from its own listing. A computer that admitted this device through
   * the hub forwards only the latter.
   */
  readonly openForward: (
    target: number | RemoteServerGrantSource,
    signal?: AbortSignal,
  ) => Promise<RemotePortForwardOpening>;
  /**
   * Registers a server-Project preview grant minted by `/api/server-project-preview`
   * under this client's proxy session so the forwarder can sign its requests.
   */
  readonly adoptGrant: (grantId: string) => Promise<RemoteServerProxyAdoption>;
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
  let session:
    | {
        readonly facts: RemoteSessionFacts;
        readonly grants: Set<string>;
        readonly forwards: Set<string>;
      }
    | undefined;
  let issuing: Promise<RemoteSessionFacts> | undefined;

  const refused = (
    reason: RemoteServerProxyRefusalReason,
    message: string,
  ): Extract<RemoteServerProxyOpening, { readonly status: "refused" }> => ({
    status: "refused",
    reason,
    message,
  });
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
    session ??= { facts, grants: new Set(), forwards: new Set() };
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

  /**
   * Posts one signed request to a proxy route and decodes the host's answer.
   * A session the host has forgotten (idle expiry, a host restart) answers
   * 401 once; a fresh one is minted and the request asked again, once.
   */
  const askHost = async <T>(
    path: string,
    payload: unknown,
    decode: (value: unknown) => T,
    signal: AbortSignal | undefined,
  ): Promise<
    | {
        readonly status: "answered";
        readonly result: T;
        readonly session: NonNullable<typeof session>;
      }
    | Extract<RemoteServerProxyOpening, { readonly status: "refused" }>
  > => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let current: Awaited<ReturnType<typeof ensureSession>>;
      try {
        current = await ensureSession();
      } catch (error) {
        return error instanceof RemoteConnectionError && error.category === "unauthorized"
          ? revoked()
          : unreachable();
      }
      const body = new TextEncoder().encode(JSON.stringify(payload));
      let response: Response;
      try {
        const headers = await signedHeaders(current.facts, "POST", path, await sha256Hex(body));
        response = await fetch(new URL(path, options.origin).toString(), {
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
      try {
        return { status: "answered", result: decode(await response.json()), session: current };
      } catch {
        return unreachable();
      }
    }
    return revoked();
  };

  const openGrant = async (
    source: RemoteServerGrantSource,
    signal?: AbortSignal,
  ): Promise<RemoteServerProxyOpening> => {
    const answer = await askHost(
      GRANTS_PATH,
      { kind: "open-remote-server-grant", requestId: randomUuid(), source },
      decodeHostAnswer(RemoteServerGrantResult),
      signal,
    );
    if (answer.status === "refused") return answer;
    const result = answer.result;
    if (result.kind === "remote-server-grant-refused") {
      return refused(result.refusal.reason, result.refusal.message);
    }
    answer.session.grants.add(String(result.grant.grantId));
    return { status: "opened", grant: result.grant };
  };

  const openForward = async (
    target: number | RemoteServerGrantSource,
    signal?: AbortSignal,
  ): Promise<RemotePortForwardOpening> => {
    const answer = await askHost(
      FORWARDS_PATH,
      typeof target === "number"
        ? { kind: "open-remote-port-forward", requestId: randomUuid(), port: target }
        : { kind: "open-remote-port-forward", requestId: randomUuid(), source: target },
      decodeHostAnswer(RemotePortForwardResult),
      signal,
    );
    if (answer.status === "refused") return answer;
    const result = answer.result;
    if (result.kind === "remote-port-forward-refused") {
      return { status: "refused", reason: result.reason, message: result.message };
    }
    answer.session.forwards.add(String(result.forward.forwardId));
    return { status: "opened", forward: result.forward };
  };

  const signRelayRequest = async (
    request: RemoteServerRelayRequest,
  ): Promise<RemoteServerRelaySigning> => {
    if (!METHOD_PATTERN.test(request.method) || !DIGEST_PATTERN.test(request.bodyDigest)) {
      return { status: "refused", reason: "invalid-request" };
    }
    const current = session;
    if (current?.forwards.has(request.grantId) === true) {
      // A forward's connection is one WebSocket upgrade at its exact path.
      const forwardPath = `${PROXY_ROUTE_PREFIX}${request.grantId}`;
      if (
        request.method !== "GET" ||
        canonicalizeRemotePathQuery(request.pathQuery) !== forwardPath
      ) {
        return { status: "refused", reason: "outside-grant" };
      }
      return {
        status: "signed",
        headers: await signedHeaders(current.facts, "GET", forwardPath, request.bodyDigest),
      };
    }
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

  const adoptGrant = async (grantId: string): Promise<RemoteServerProxyAdoption> => {
    if (!GRANT_ID_PATTERN.test(grantId)) {
      return {
        status: "refused",
        reason: "invalid-grant",
        message: "That preview grant identifier is invalid.",
      };
    }
    let current: Awaited<ReturnType<typeof ensureSession>>;
    try {
      current = await ensureSession();
    } catch (error) {
      return error instanceof RemoteConnectionError && error.category === "unauthorized"
        ? {
            status: "refused",
            reason: "device-revoked",
            message: `This computer no longer has access to ${options.hostName}. Pair it again to open servers there.`,
          }
        : {
            status: "refused",
            reason: "host-unreachable",
            message: `Can't reach ${options.hostName}. Check that it's on and on the same network.`,
          };
    }
    current.grants.add(grantId);
    return { status: "adopted" };
  };

  return {
    openGrant,
    openForward,
    adoptGrant,
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
