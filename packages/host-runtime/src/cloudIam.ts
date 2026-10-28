import { randomUUID } from "node:crypto";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { issuerRequestDeadline } from "./issuerRequest";
import { sigV4Date, signSigV4 } from "./sigV4";

/**
 * Cloud-IAM request signing in the host credential broker.
 *
 * The source identity is the organization's single sign-on: the person signs
 * in at their access portal with a device code, and the broker keeps that
 * session and the temporary role credentials it mints for one account and
 * role. Every piece of that is reusable identity material, so none of it
 * leaves the broker. The server asks for one request's signature at a time,
 * naming the request by its fields; the broker checks each field against the
 * signing scope it stored at sign-in, builds the canonical request itself,
 * and answers with headers. It never signs a digest a caller supplies, and
 * no route answers with a key, a secret, or a session token of the portal.
 */

const GRANT_KIND = "host-cloud-iam-grant";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// The client the broker registers with the portal's OIDC service for each
// sign-in. The scope asks for a refresh token, so a session lasts as long as
// the organization's session policy allows rather than one access token.
const CLIENT_NAME = "Octant";
const CLIENT_SCOPES = ["sso:account:access"] as const;
// The portal keeps a device code for ten minutes; an answer claiming longer
// would keep the broker polling for a code nobody can still enter.
const DEVICE_MAX_SECONDS = 15 * 60;
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
const SLOW_DOWN_MS = 5_000;
// A poll the portal could not answer (no answer, a 429, or a 5xx) is retried
// after a wait that doubles with each one in a row, up to this, and never
// past the code's own expiry.
const TRANSIENT_POLL_MAX_MS = 60_000;
// A settled attempt stays readable this long past its code's expiry, longer
// than the server follows one, so a late status read still learns how it
// ended; after that the broker forgets it, so abandoned attempts do not pile up.
const ATTEMPT_RETENTION_MS = 5 * 60_000;
// Role credentials this close to their expiry are renewed before signing, so
// a signature never rides credentials that end while the request is in flight.
const ROLE_RENEW_SKEW_MS = 5 * 60_000;
const SESSION_RENEW_SKEW_MS = 60_000;
// The portal's client secrets and session tokens run past a thousand
// characters; this bound only refuses an answer no portal sends.
const MAX_SECRET_CHARS = 8_192;
const MAX_RESPONSE_CHARS = 16 * 1_024;
const MAX_ROUTE_BYTES = 16 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DESCRIPTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REGION_PATTERN = /^(?!cn-)[a-z]{2}-[a-z]{4,9}-[1-9]$/;
const AWSAPPS_START_URL = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.awsapps\.com)\/start$/;
const PORTAL_START_URL =
  /^https:\/\/(ssoins-[0-9a-f]{16}\.portal\.(?!cn-)[a-z]{2}-[a-z]{4,9}-[1-9]\.app\.aws)$/;
const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/;
const ROLE_NAME_PATTERN = /^[A-Za-z0-9+=,.@_-]{1,64}$/;
const USER_CODE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]{1,2048}$/;
const ACCESS_KEY_ID_PATTERN = /^[A-Z0-9]{16,128}$/;
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;
const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;
// A path the broker will sign: already percent-encoded, made only of
// unreserved characters, `/`, and well-formed escapes.
const SIGNABLE_PATH_PATTERN = /^(?:\/(?:[A-Za-z0-9\-._~:@]|%[0-9A-F]{2})+)+$/;
const QUERY_PART_PATTERN = /^[\x21-\x7e]{0,256}$/;
// The headers a caller may ask the broker to sign. `host`, the date, and the
// session token are the broker's own; an authorization header is its answer.
const SIGNABLE_HEADERS: ReadonlySet<string> = new Set(["content-type", "accept"]);
const SIGNABLE_HEADER_VALUE = /^[\x20-\x7e]{1,256}$/;
const SIGN_KEYS: ReadonlySet<string> = new Set(["credentialRef", "request", "renewCredentials"]);
const REQUEST_KEYS: ReadonlySet<string> = new Set([
  "method",
  "host",
  "path",
  "query",
  "headers",
  "payloadHash",
]);

/** Where a `cloud-iam` sign-in comes from: the portal, its region, and the account and role. */
export interface CloudIamSource {
  readonly startUrl: string;
  readonly ssoRegion: string;
  readonly accountId: string;
  readonly roleName: string;
}

/** The requests a grant may sign, from the broker's closed table. */
export interface CloudIamScope {
  readonly partition: "aws";
  readonly region: string;
  readonly service: "bedrock";
  readonly host: string;
  readonly pathPrefix: "/model/";
  readonly method: "POST";
}

export interface CloudIamDescriptor {
  readonly descriptorId: string;
  readonly termsId: string;
  readonly flow: "device-code";
  readonly source: CloudIamSource;
  readonly scope: CloudIamScope;
}

/** One request as the caller describes it; the broker builds what it signs from these. */
export interface CloudIamSignRequest {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}

export type CloudIamRefusalReason =
  | "denied"
  | "timeout"
  | "exchange-refused"
  | "not-authorized"
  | "unavailable"
  | "terms-required"
  | "invalid";

export type CloudIamSignInAgainReason = "expired" | "revoked";

export type CloudIamPublicState =
  | {
      readonly kind: "awaiting-consent";
      readonly attemptId: string;
      readonly descriptorId: string;
      readonly flow: "device-code";
      readonly verificationUri: string;
      readonly userCode: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "signed-in";
      readonly attemptId: string;
      readonly descriptorId: string;
      readonly credentialRef: string;
    }
  | {
      readonly kind: "refused";
      readonly attemptId: string;
      readonly descriptorId: string;
      readonly reason: CloudIamRefusalReason;
    }
  | { readonly kind: "unknown" };

export type CloudIamBeginResult =
  | Extract<CloudIamPublicState, { readonly kind: "awaiting-consent" }>
  | { readonly kind: "refused"; readonly reason: CloudIamRefusalReason };

/**
 * `outside-scope`: the request falls outside what the grant was signed in
 * for, or the reference names no cloud grant; nothing was signed.
 * `not-authorized`: the portal no longer gives this person the role; the
 * grant is kept, since an administrator may assign it again.
 */
export type CloudIamSignResult =
  | { readonly kind: "signed"; readonly headers: Readonly<Record<string, string>> }
  | { readonly kind: "sign-in-again"; readonly reason: CloudIamSignInAgainReason }
  | { readonly kind: "not-authorized" }
  | { readonly kind: "outside-scope" }
  | { readonly kind: "unavailable" };

export type CloudIamRevokeResult = { readonly kind: "revoked" } | { readonly kind: "unavailable" };

export interface CloudIamRuntime {
  readonly begin: (input: {
    readonly descriptor: CloudIamDescriptor;
    readonly actorId: string;
    readonly termsAcknowledgedAt: string;
  }) => Promise<CloudIamBeginResult>;
  readonly status: (attemptId: string) => CloudIamPublicState;
  readonly sign: (input: {
    readonly credentialRef: string;
    readonly request: CloudIamSignRequest;
    readonly renewCredentials: boolean;
  }) => Promise<CloudIamSignResult>;
  /**
   * Sign out: ask the portal to end the session, then delete the local grant
   * whatever the portal answered. Temporary credentials already minted were
   * never outside the broker.
   */
  readonly revoke: (credentialRef: string) => Promise<CloudIamRevokeResult>;
  readonly close: () => Promise<void>;
}

interface RoleCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: number;
}

interface StoredGrant {
  readonly kind: typeof GRANT_KIND;
  readonly version: 1;
  readonly generation: number;
  readonly source: CloudIamSource;
  readonly scope: CloudIamScope;
  readonly client: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly expiresAt: number;
  };
  readonly session: {
    readonly accessToken: string;
    readonly expiresAt: number;
    /** Absent when the portal granted none: the session then ends with its access token. */
    readonly refreshToken?: string;
  };
  readonly role?: RoleCredentials;
}

interface Attempt {
  status: CloudIamPublicState;
  closed: boolean;
  /** When the attempt's device code runs out, in epoch milliseconds. */
  readonly expiresAt: number;
}

/** Whether a stored value is a cloud grant, which no raw resolve may release. */
export function isCloudIamGrantMaterial(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && parsed.kind === GRANT_KIND;
  } catch {
    return false;
  }
}

/**
 * The broker builds every portal address from the instance's own region; no
 * descriptor or answer can name another host.
 */
function oidcEndpoint(ssoRegion: string, path: string): string {
  return `https://oidc.${ssoRegion}.amazonaws.com${path}`;
}

function portalEndpoint(ssoRegion: string, path: string): string {
  return `https://portal.sso.${ssoRegion}.amazonaws.com${path}`;
}

export function createCloudIamRuntime(options: {
  readonly store: CredentialStore;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): CloudIamRuntime {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const attempts = new Map<string, Attempt>();
  const renewals = new Map<string, Promise<RenewOutcome>>();
  let closed = false;

  const publish = (attemptId: string, status: CloudIamPublicState): void => {
    const attempt = attempts.get(attemptId);
    if (attempt !== undefined) attempt.status = status;
  };

  const begin: CloudIamRuntime["begin"] = async (input) => {
    if (closed) return { kind: "refused", reason: "unavailable" };
    if (!UUID_PATTERN.test(input.actorId) || input.termsAcknowledgedAt.trim().length === 0) {
      return { kind: "refused", reason: "terms-required" };
    }
    const descriptor = validateDescriptor(input.descriptor);
    if (descriptor === undefined) return { kind: "refused", reason: "invalid" };
    const { ssoRegion, startUrl } = descriptor.source;
    const registered = await postJson(fetchImpl, oidcEndpoint(ssoRegion, "/client/register"), {
      clientName: CLIENT_NAME,
      clientType: "public",
      scopes: CLIENT_SCOPES,
    });
    if (registered.kind !== "json") return { kind: "refused", reason: refusalOf(registered) };
    const client = readClient(registered.value, now());
    if (client === undefined) return { kind: "refused", reason: "exchange-refused" };
    const authorized = await postJson(fetchImpl, oidcEndpoint(ssoRegion, "/device_authorization"), {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      startUrl,
    });
    if (authorized.kind !== "json") return { kind: "refused", reason: refusalOf(authorized) };
    const device = readDeviceAuthorization(authorized.value, descriptor.source);
    if (device === undefined) return { kind: "refused", reason: "exchange-refused" };
    const attemptId = randomUUID();
    const expiresAt = now() + device.expiresInSeconds * 1_000;
    const awaiting: CloudIamBeginResult = {
      kind: "awaiting-consent",
      attemptId,
      descriptorId: descriptor.descriptorId,
      flow: "device-code",
      verificationUri: device.verificationUri,
      userCode: device.userCode,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const attempt: Attempt = { status: awaiting, closed: false, expiresAt };
    pruneSettledAttempts(attempts, now());
    attempts.set(attemptId, attempt);
    void poll({
      attempt,
      attemptId,
      descriptor,
      client,
      deviceCode: device.deviceCode,
      expiresAt,
      intervalMs: device.intervalSeconds * 1_000,
    });
    return awaiting;
  };

  const poll = async (session: {
    readonly attempt: Attempt;
    readonly attemptId: string;
    readonly descriptor: CloudIamDescriptor;
    readonly client: StoredGrant["client"];
    readonly deviceCode: string;
    readonly expiresAt: number;
    intervalMs: number;
  }): Promise<void> => {
    const { attempt, attemptId, descriptor } = session;
    const settle = (status: CloudIamPublicState) => {
      attempt.closed = true;
      publish(attemptId, status);
    };
    const refuse = (reason: CloudIamRefusalReason) =>
      settle({ kind: "refused", attemptId, descriptorId: descriptor.descriptorId, reason });
    // Consecutive polls the portal could not answer. A code that runs out
    // while the portal is still failing reads `unavailable`, not `timeout`:
    // the person may never have been able to enter it.
    let transientPolls = 0;
    const expired = () => refuse(transientPolls > 0 ? "unavailable" : "timeout");
    while (!closed && !attempt.closed) {
      if (now() >= session.expiresAt) return expired();
      await sleep(
        transientPolls === 0
          ? session.intervalMs
          : Math.min(session.intervalMs * 2 ** transientPolls, TRANSIENT_POLL_MAX_MS),
      );
      if (closed || attempt.closed) return;
      if (now() >= session.expiresAt) return expired();
      const answered = await postJson(
        fetchImpl,
        oidcEndpoint(descriptor.source.ssoRegion, "/token"),
        {
          clientId: session.client.clientId,
          clientSecret: session.client.clientSecret,
          grantType: DEVICE_GRANT,
          deviceCode: session.deviceCode,
        },
      );
      if (answered.kind === "unavailable") {
        transientPolls += 1;
        continue;
      }
      transientPolls = 0;
      if (answered.kind === "refused") {
        if (answered.error === "authorization_pending") continue;
        if (answered.error === "slow_down") {
          session.intervalMs += SLOW_DOWN_MS;
          continue;
        }
        if (answered.error === "access_denied") return refuse("denied");
        if (answered.error === "expired_token") return refuse("timeout");
        return refuse("exchange-refused");
      }
      const issued = readSession(answered.value, now());
      if (issued === undefined) return refuse("exchange-refused");
      // The role is minted before anything is stored: a person the portal
      // does not give this account and role holds no grant for it.
      const minted = await mintRoleCredentials(fetchImpl, descriptor.source, issued.accessToken);
      if (minted.kind !== "credentials") {
        return refuse(
          minted.kind === "not-authorized"
            ? "not-authorized"
            : minted.kind === "unauthorized"
              ? "exchange-refused"
              : "unavailable",
        );
      }
      const grant: StoredGrant = {
        kind: GRANT_KIND,
        version: 1,
        generation: 0,
        source: descriptor.source,
        scope: descriptor.scope,
        client: session.client,
        session: issued,
        role: minted.credentials,
      };
      const credentialRef = randomUUID();
      try {
        await options.store.set(credentialRef, JSON.stringify(grant));
      } catch {
        return refuse("unavailable");
      }
      return settle({
        kind: "signed-in",
        attemptId,
        descriptorId: descriptor.descriptorId,
        credentialRef,
      });
    }
  };

  const readGrant = async (
    credentialRef: string,
  ): Promise<
    | { readonly kind: "grant"; readonly grant: StoredGrant }
    | { readonly kind: "missing" }
    | { readonly kind: "foreign" }
    | { readonly kind: "unavailable" }
  > => {
    let raw: string;
    try {
      raw = await options.store.resolve(credentialRef);
    } catch (error) {
      if (error instanceof CredentialStoreFailure && error.category === "missing") {
        return { kind: "missing" };
      }
      return { kind: "unavailable" };
    }
    const grant = decodeGrant(raw);
    return grant === undefined ? { kind: "foreign" } : { kind: "grant", grant };
  };

  /**
   * Renew the role credentials, renewing the portal session first when it is
   * near its end. Single-flight per grant: concurrent signatures share one
   * renewal. A session the portal no longer accepts ends the grant; a role
   * the portal no longer gives keeps it.
   */
  const renew = (credentialRef: string, grant: StoredGrant): Promise<RenewOutcome> => {
    const running = renewals.get(credentialRef);
    if (running !== undefined) return running;
    const run = renewOnce(credentialRef, grant).finally(() => {
      renewals.delete(credentialRef);
    });
    renewals.set(credentialRef, run);
    return run;
  };

  const renewOnce = async (credentialRef: string, read: StoredGrant): Promise<RenewOutcome> => {
    // The caller read the grant before this renewal began; another renewal
    // may have stored new credentials since. Renewing from the stale copy
    // would lose the generation check below, and could spend a refresh token
    // the portal has already rotated, ending a grant that was just renewed.
    const latest = await readGrant(credentialRef);
    if (latest.kind === "missing") return { kind: "sign-in-again", reason: "expired" };
    if (latest.kind !== "grant") return { kind: "unavailable" };
    const current = latest.grant;
    if (
      current.generation !== read.generation &&
      current.role !== undefined &&
      current.role.expiresAt - ROLE_RENEW_SKEW_MS > now()
    ) {
      return { kind: "renewed", grant: current };
    }
    let grant = current;
    let sessionRenewed = false;
    const end = async (reason: CloudIamSignInAgainReason): Promise<RenewOutcome> => {
      try {
        await options.store.delete(credentialRef);
      } catch {
        return { kind: "unavailable" };
      }
      return { kind: "sign-in-again", reason };
    };
    if (grant.session.expiresAt - SESSION_RENEW_SKEW_MS <= now()) {
      const renewed = await renewSession(grant);
      if (renewed.kind === "sign-in-again") return end(renewed.reason);
      if (renewed.kind !== "session") return { kind: "unavailable" };
      grant = { ...grant, session: renewed.session };
      sessionRenewed = true;
    }
    let minted = await mintRoleCredentials(fetchImpl, grant.source, grant.session.accessToken);
    if (minted.kind === "unauthorized" && !sessionRenewed) {
      // The portal refused a session token that had not yet expired by its
      // own clock: renew it once and try again.
      const renewed = await renewSession(grant);
      if (renewed.kind === "sign-in-again") return end(renewed.reason);
      if (renewed.kind !== "session") return { kind: "unavailable" };
      grant = { ...grant, session: renewed.session };
      minted = await mintRoleCredentials(fetchImpl, grant.source, grant.session.accessToken);
    }
    if (minted.kind === "unauthorized") return end("revoked");
    if (minted.kind === "not-authorized") {
      await storeIfCurrent(credentialRef, current, grant);
      return { kind: "not-authorized" };
    }
    if (minted.kind !== "credentials") {
      await storeIfCurrent(credentialRef, current, grant);
      return { kind: "unavailable" };
    }
    const next: StoredGrant = { ...grant, role: minted.credentials };
    const stored = await storeIfCurrent(credentialRef, current, next);
    return stored ? { kind: "renewed", grant: next } : { kind: "unavailable" };
  };

  /** Store a renewed grant unless another renewal already replaced it. */
  const storeIfCurrent = async (
    credentialRef: string,
    previous: StoredGrant,
    next: StoredGrant,
  ): Promise<boolean> => {
    if (next === previous) return true;
    try {
      const latest = decodeGrant(await options.store.resolve(credentialRef));
      if (latest === undefined || latest.generation !== previous.generation) return false;
      await options.store.set(
        credentialRef,
        JSON.stringify({ ...next, generation: previous.generation + 1 }),
      );
      return true;
    } catch {
      return false;
    }
  };

  const renewSession = async (
    grant: StoredGrant,
  ): Promise<
    | { readonly kind: "session"; readonly session: StoredGrant["session"] }
    | { readonly kind: "sign-in-again"; readonly reason: CloudIamSignInAgainReason }
    | { readonly kind: "unavailable" }
  > => {
    const refreshToken = grant.session.refreshToken;
    if (refreshToken === undefined || grant.client.expiresAt <= now()) {
      return { kind: "sign-in-again", reason: "expired" };
    }
    const answered = await postJson(fetchImpl, oidcEndpoint(grant.source.ssoRegion, "/token"), {
      clientId: grant.client.clientId,
      clientSecret: grant.client.clientSecret,
      grantType: "refresh_token",
      refreshToken,
    });
    if (answered.kind === "refused") {
      // A session that ran its course reads expired; a client or grant the
      // portal withdrew reads revoked. Both end the grant. Everything else
      // (a 429, a 5xx, no answer) is transient and keeps it.
      if (answered.error === "invalid_grant" || answered.error === "expired_token") {
        return { kind: "sign-in-again", reason: "expired" };
      }
      if (
        answered.error === "invalid_client" ||
        answered.error === "unauthorized_client" ||
        answered.error === "access_denied"
      ) {
        return { kind: "sign-in-again", reason: "revoked" };
      }
      return { kind: "unavailable" };
    }
    if (answered.kind !== "json") return { kind: "unavailable" };
    const session = readSession(answered.value, now());
    if (session === undefined) return { kind: "unavailable" };
    // The portal may rotate the refresh token or leave it as it was.
    return {
      kind: "session",
      session: { ...session, refreshToken: session.refreshToken ?? refreshToken },
    };
  };

  const sign: CloudIamRuntime["sign"] = async (input) => {
    if (closed || !UUID_PATTERN.test(input.credentialRef)) return { kind: "unavailable" };
    const read = await readGrant(input.credentialRef);
    if (read.kind === "missing") return { kind: "sign-in-again", reason: "expired" };
    if (read.kind === "foreign") return { kind: "outside-scope" };
    if (read.kind === "unavailable") return { kind: "unavailable" };
    let grant = read.grant;
    // Every field is checked against the stored scope before any credential
    // is touched: a request outside it costs no renewal and no signature.
    if (!withinScope(input.request, grant.scope)) return { kind: "outside-scope" };
    if (
      input.renewCredentials ||
      grant.role === undefined ||
      grant.role.expiresAt - ROLE_RENEW_SKEW_MS <= now()
    ) {
      const renewed = await renew(input.credentialRef, grant);
      if (renewed.kind !== "renewed") return renewed;
      grant = renewed.grant;
    }
    const role = grant.role;
    if (role === undefined) return { kind: "unavailable" };
    if (!withinScope(input.request, grant.scope)) return { kind: "outside-scope" };
    const signed = signSigV4({
      request: {
        method: input.request.method,
        host: input.request.host,
        path: input.request.path,
        query: input.request.query,
        headers: lowercaseKeys(input.request.headers),
        payloadHash: input.request.payloadHash,
      },
      credentials: role,
      region: grant.scope.region,
      service: grant.scope.service,
      amzDate: sigV4Date(now()),
    });
    return { kind: "signed", headers: signed.headers };
  };

  const revoke: CloudIamRuntime["revoke"] = async (credentialRef) => {
    if (!UUID_PATTERN.test(credentialRef)) return { kind: "unavailable" };
    const read = await readGrant(credentialRef);
    if (read.kind === "missing") return { kind: "revoked" };
    if (read.kind === "unavailable") return { kind: "unavailable" };
    if (read.kind === "grant") {
      // Best effort: the portal ends the session it issued. The local grant
      // goes either way, which is what signing out on this computer means.
      try {
        const response = await fetchImpl(portalEndpoint(read.grant.source.ssoRegion, "/logout"), {
          method: "POST",
          redirect: "error",
          headers: { "x-amz-sso_bearer_token": read.grant.session.accessToken },
          signal: issuerRequestDeadline(),
        });
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // An unreachable portal leaves its session to end on its own.
      }
    }
    try {
      await options.store.delete(credentialRef);
    } catch {
      return { kind: "unavailable" };
    }
    return { kind: "revoked" };
  };

  return Object.freeze({
    begin,
    status: (attemptId: string): CloudIamPublicState =>
      attempts.get(attemptId)?.status ?? { kind: "unknown" },
    sign,
    revoke,
    close: async () => {
      closed = true;
      for (const attempt of attempts.values()) attempt.closed = true;
    },
  });
}

type RenewOutcome =
  | { readonly kind: "renewed"; readonly grant: StoredGrant }
  | { readonly kind: "sign-in-again"; readonly reason: CloudIamSignInAgainReason }
  | { readonly kind: "not-authorized" }
  | { readonly kind: "unavailable" };

/**
 * Whether one request lies inside a grant's scope: the scope's method and
 * host exactly, a canonical path under its prefix, at most a few plain query
 * parameters, only the signable headers, and a payload hash.
 */
function withinScope(request: CloudIamSignRequest, scope: CloudIamScope): boolean {
  return (
    request.method === scope.method &&
    request.host === scope.host &&
    request.path.startsWith(scope.pathPrefix) &&
    request.path.length <= 2_048 &&
    SIGNABLE_PATH_PATTERN.test(request.path) &&
    request.path.split("/").every((segment) => !isDotSegment(segment)) &&
    request.query.length <= 8 &&
    request.query.every(
      ([key, value]) =>
        key.length > 0 && QUERY_PART_PATTERN.test(key) && QUERY_PART_PATTERN.test(value),
    ) &&
    Object.entries(request.headers).every(
      ([name, value]) =>
        SIGNABLE_HEADERS.has(name.toLowerCase()) && SIGNABLE_HEADER_VALUE.test(value),
    ) &&
    new Set(Object.keys(request.headers).map((name) => name.toLowerCase())).size ===
      Object.keys(request.headers).length &&
    PAYLOAD_HASH_PATTERN.test(request.payloadHash)
  );
}

/**
 * A path segment a URL parser resolves away. The WHATWG URL standard, which
 * `fetch` follows, reads `%2E` as a dot here too: `/model/%2E%2E/async-invoke`
 * is sent to `/async-invoke`, outside the prefix this grant signs for.
 */
function isDotSegment(segment: string): boolean {
  const unescaped = segment.replaceAll("%2E", ".");
  return unescaped === "." || unescaped === "..";
}

type MintOutcome =
  | { readonly kind: "credentials"; readonly credentials: RoleCredentials }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not-authorized" }
  | { readonly kind: "unavailable" };

/**
 * Ask the portal for the role's temporary credentials. A 401 is a session
 * token the portal no longer accepts; a 403 or 404 is an account or role the
 * person is not given; a 429, a 5xx, or no answer is transient.
 */
async function mintRoleCredentials(
  fetchImpl: typeof fetch,
  source: CloudIamSource,
  sessionToken: string,
): Promise<MintOutcome> {
  const query = new URLSearchParams({
    account_id: source.accountId,
    role_name: source.roleName,
  }).toString();
  let response: Response;
  try {
    response = await fetchImpl(
      portalEndpoint(source.ssoRegion, `/federation/credentials?${query}`),
      {
        method: "GET",
        redirect: "error",
        headers: { "x-amz-sso_bearer_token": sessionToken },
        signal: issuerRequestDeadline(),
      },
    );
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "unauthorized" };
  }
  if (response.status === 403 || response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "not-authorized" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "unavailable" };
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = await readResponseJson(response);
  } catch {
    return { kind: "unavailable" };
  }
  const role = body === undefined ? undefined : body.roleCredentials;
  if (!isRecord(role)) return { kind: "unavailable" };
  const accessKeyId = role.accessKeyId;
  const secretAccessKey = role.secretAccessKey;
  const roleSessionToken = role.sessionToken;
  const expiration = role.expiration;
  if (
    typeof accessKeyId !== "string" ||
    !ACCESS_KEY_ID_PATTERN.test(accessKeyId) ||
    typeof secretAccessKey !== "string" ||
    !isBoundedSecret(secretAccessKey) ||
    typeof roleSessionToken !== "string" ||
    !isBoundedSecret(roleSessionToken) ||
    typeof expiration !== "number" ||
    !Number.isFinite(expiration)
  ) {
    return { kind: "unavailable" };
  }
  return {
    kind: "credentials",
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: roleSessionToken,
      expiresAt: expiration,
    },
  };
}

function readClient(
  value: Record<string, unknown>,
  now: number,
): StoredGrant["client"] | undefined {
  const clientId = value.clientId;
  const clientSecret = value.clientSecret;
  const expiresAtSeconds = value.clientSecretExpiresAt;
  if (
    typeof clientId !== "string" ||
    !isBoundedSecret(clientId) ||
    typeof clientSecret !== "string" ||
    !isBoundedSecret(clientSecret) ||
    typeof expiresAtSeconds !== "number" ||
    !Number.isFinite(expiresAtSeconds) ||
    expiresAtSeconds * 1_000 <= now
  ) {
    return undefined;
  }
  return { clientId, clientSecret, expiresAt: expiresAtSeconds * 1_000 };
}

function readDeviceAuthorization(
  value: Record<string, unknown>,
  source: CloudIamSource,
):
  | {
      readonly deviceCode: string;
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresInSeconds: number;
      readonly intervalSeconds: number;
    }
  | undefined {
  const deviceCode = value.deviceCode;
  const userCode = value.userCode;
  const verificationUri = value.verificationUri;
  const expiresIn = value.expiresIn;
  const interval = typeof value.interval === "number" ? value.interval : undefined;
  if (
    typeof deviceCode !== "string" ||
    !isBoundedSecret(deviceCode) ||
    typeof userCode !== "string" ||
    !USER_CODE_PATTERN.test(userCode) ||
    typeof verificationUri !== "string" ||
    !isVerificationPage(verificationUri, source) ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return undefined;
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresInSeconds: Math.min(expiresIn, DEVICE_MAX_SECONDS),
    intervalSeconds: Math.min(
      Math.max(
        1,
        interval !== undefined && Number.isFinite(interval)
          ? interval
          : DEFAULT_DEVICE_INTERVAL_SECONDS,
      ),
      60,
    ),
  };
}

/**
 * The page a person enters the code at must be one the cloud itself serves:
 * the device page of the portal's region, or the organization's own access
 * portal host. A code shown beside any other address would teach the person
 * to type it into a page Octant did not name. The text itself must be visible
 * ASCII, since the command prints it to a terminal.
 */
function isVerificationPage(value: string, source: CloudIamSource): boolean {
  if (!VISIBLE_ASCII_PATTERN.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return false;
  }
  return (
    url.hostname === `device.sso.${source.ssoRegion}.amazonaws.com` ||
    url.hostname === startUrlHost(source.startUrl)
  );
}

function startUrlHost(startUrl: string): string | undefined {
  return AWSAPPS_START_URL.exec(startUrl)?.[1] ?? PORTAL_START_URL.exec(startUrl)?.[1];
}

function readSession(
  value: Record<string, unknown>,
  now: number,
): StoredGrant["session"] | undefined {
  const accessToken = value.accessToken;
  const expiresIn = value.expiresIn;
  const refreshToken = value.refreshToken;
  if (
    typeof accessToken !== "string" ||
    !isBoundedSecret(accessToken) ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    (refreshToken !== undefined &&
      (typeof refreshToken !== "string" || !isBoundedSecret(refreshToken)))
  ) {
    return undefined;
  }
  return {
    accessToken,
    expiresAt: now + expiresIn * 1_000,
    ...(typeof refreshToken === "string" ? { refreshToken } : {}),
  };
}

type PostOutcome =
  | { readonly kind: "json"; readonly value: Record<string, unknown> }
  /** A 4xx answer, with the OAuth error code it named when it named one. */
  | { readonly kind: "refused"; readonly error: string | undefined }
  | { readonly kind: "unavailable" };

/**
 * One JSON request to the portal's OIDC service. Only the error code is read
 * from a refusal, from the body's `error` or the service's error-type header,
 * never a description.
 */
async function postJson(
  fetchImpl: typeof fetch,
  endpoint: string,
  body: Readonly<Record<string, unknown>>,
): Promise<PostOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: issuerRequestDeadline(),
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "unavailable" };
  }
  let value: Record<string, unknown> | undefined;
  try {
    value = await readResponseJson(response);
  } catch {
    return { kind: "unavailable" };
  }
  if (response.ok)
    return value === undefined ? { kind: "refused", error: undefined } : { kind: "json", value };
  const error = value?.error;
  return {
    kind: "refused",
    error:
      typeof error === "string" && ERROR_CODE_PATTERN.test(error)
        ? error
        : errorTypeCode(response.headers.get("x-amzn-errortype")),
  };
}

const ERROR_TYPES: Readonly<Record<string, string>> = {
  AuthorizationPendingException: "authorization_pending",
  SlowDownException: "slow_down",
  AccessDeniedException: "access_denied",
  ExpiredTokenException: "expired_token",
  InvalidGrantException: "invalid_grant",
  InvalidClientException: "invalid_client",
  UnauthorizedClientException: "unauthorized_client",
};

function errorTypeCode(header: string | null): string | undefined {
  if (header === null) return undefined;
  const name = header.split(":", 1)[0]?.trim() ?? "";
  return Object.hasOwn(ERROR_TYPES, name) ? ERROR_TYPES[name] : undefined;
}

/**
 * Forget settled attempts well past their code's expiry. One still polling is
 * kept: its poll may yet store a grant, which must stay named by its attempt.
 */
function pruneSettledAttempts(attempts: Map<string, Attempt>, now: number): void {
  for (const [attemptId, attempt] of attempts) {
    if (
      attempt.status.kind !== "awaiting-consent" &&
      now > attempt.expiresAt + ATTEMPT_RETENTION_MS
    ) {
      attempts.delete(attemptId);
    }
  }
}

function refusalOf(outcome: PostOutcome): CloudIamRefusalReason {
  return outcome.kind === "unavailable" ? "unavailable" : "exchange-refused";
}

function validateDescriptor(value: CloudIamDescriptor): CloudIamDescriptor | undefined {
  const source = readSource(value.source);
  const scope = readScope(value.scope);
  if (
    !DESCRIPTOR_ID_PATTERN.test(value.descriptorId) ||
    !DESCRIPTOR_ID_PATTERN.test(value.termsId) ||
    value.flow !== "device-code" ||
    source === undefined ||
    scope === undefined
  ) {
    return undefined;
  }
  return {
    descriptorId: value.descriptorId,
    termsId: value.termsId,
    flow: "device-code",
    source,
    scope,
  };
}

function readSource(value: unknown): CloudIamSource | undefined {
  if (!hasExactKeys(value, ["startUrl", "ssoRegion", "accountId", "roleName"])) return undefined;
  const { startUrl, ssoRegion, accountId, roleName } = value;
  if (
    typeof startUrl !== "string" ||
    startUrlHost(startUrl) === undefined ||
    typeof ssoRegion !== "string" ||
    !REGION_PATTERN.test(ssoRegion) ||
    typeof accountId !== "string" ||
    !ACCOUNT_ID_PATTERN.test(accountId) ||
    typeof roleName !== "string" ||
    !ROLE_NAME_PATTERN.test(roleName)
  ) {
    return undefined;
  }
  return { startUrl, ssoRegion, accountId, roleName };
}

/**
 * The broker's closed signing table: one partition, one service, that
 * service's runtime host in the scope's own region, one path prefix, one
 * method. A scope naming anything else is refused at sign-in, and a stored
 * grant naming anything else is not read.
 */
function readScope(value: unknown): CloudIamScope | undefined {
  if (!hasExactKeys(value, ["partition", "region", "service", "host", "pathPrefix", "method"])) {
    return undefined;
  }
  const { partition, region, service, host, pathPrefix, method } = value;
  if (
    partition !== "aws" ||
    typeof region !== "string" ||
    !REGION_PATTERN.test(region) ||
    service !== "bedrock" ||
    host !== `bedrock-runtime.${region}.amazonaws.com` ||
    pathPrefix !== "/model/" ||
    method !== "POST"
  ) {
    return undefined;
  }
  return { partition, region, service, host, pathPrefix, method };
}

function decodeGrant(raw: string): StoredGrant | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.kind !== GRANT_KIND || parsed.version !== 1) return undefined;
  const source = readSource(parsed.source);
  const scope = readScope(parsed.scope);
  const { client, session, role, generation } = parsed;
  if (
    source === undefined ||
    scope === undefined ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    !isRecord(client) ||
    typeof client.clientId !== "string" ||
    typeof client.clientSecret !== "string" ||
    typeof client.expiresAt !== "number" ||
    !isRecord(session) ||
    typeof session.accessToken !== "string" ||
    typeof session.expiresAt !== "number" ||
    (session.refreshToken !== undefined && typeof session.refreshToken !== "string")
  ) {
    return undefined;
  }
  let roleCredentials: RoleCredentials | undefined;
  if (role !== undefined) {
    if (
      !isRecord(role) ||
      typeof role.accessKeyId !== "string" ||
      typeof role.secretAccessKey !== "string" ||
      typeof role.sessionToken !== "string" ||
      typeof role.expiresAt !== "number"
    ) {
      return undefined;
    }
    roleCredentials = {
      accessKeyId: role.accessKeyId,
      secretAccessKey: role.secretAccessKey,
      sessionToken: role.sessionToken,
      expiresAt: role.expiresAt,
    };
  }
  return {
    kind: GRANT_KIND,
    version: 1,
    generation,
    source,
    scope,
    client: {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      expiresAt: client.expiresAt,
    },
    session: {
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      ...(typeof session.refreshToken === "string" ? { refreshToken: session.refreshToken } : {}),
    },
    ...(roleCredentials === undefined ? {} : { role: roleCredentials }),
  };
}

export async function handleCloudIamBrokerRoute(
  pathname: string,
  request: Request,
  runtime: CloudIamRuntime,
): Promise<Response> {
  const decoded = await readObject(request);
  if (decoded.kind === "too-large") return failure("too-large", 413);
  if (decoded.kind === "invalid") return failure("invalid-request", 400);
  const value = decoded.value;
  const answer = (body: unknown) =>
    Response.json(body, { headers: { "cache-control": "no-store" } });
  if (pathname === "/v1/cloud-iam/begin") {
    if (!hasExactKeys(value, ["descriptor", "actorId", "termsAcknowledgedAt"])) {
      return failure("invalid-request", 400);
    }
    const { descriptor, actorId, termsAcknowledgedAt } = value;
    if (
      !hasExactKeys(descriptor, ["descriptorId", "termsId", "flow", "source", "scope"]) ||
      typeof descriptor.descriptorId !== "string" ||
      typeof descriptor.termsId !== "string" ||
      descriptor.flow !== "device-code" ||
      typeof actorId !== "string" ||
      typeof termsAcknowledgedAt !== "string"
    ) {
      return failure("invalid-request", 400);
    }
    const source = readSource(descriptor.source);
    const scope = readScope(descriptor.scope);
    if (source === undefined || scope === undefined) return failure("invalid-request", 400);
    return answer(
      await runtime.begin({
        descriptor: {
          descriptorId: descriptor.descriptorId,
          termsId: descriptor.termsId,
          flow: "device-code",
          source,
          scope,
        },
        actorId,
        termsAcknowledgedAt,
      }),
    );
  }
  if (pathname === "/v1/cloud-iam/status") {
    const attemptId = value.attemptId;
    if (!hasExactKeys(value, ["attemptId"]) || typeof attemptId !== "string") {
      return failure("invalid-request", 400);
    }
    if (!UUID_PATTERN.test(attemptId)) return failure("invalid-request", 400);
    return answer(runtime.status(attemptId));
  }
  if (pathname === "/v1/cloud-iam/sign") {
    // Exactly a reference, the request's own fields, and whether to renew.
    // A digest, a canonical request, a date, or a scope of the caller's own
    // is not a field here, so a body that carries one is refused unsigned.
    if (!Object.keys(value).every((key) => SIGN_KEYS.has(key))) {
      return failure("invalid-request", 400);
    }
    const { credentialRef, request: fields, renewCredentials } = value;
    const parsed = readSignRequest(fields);
    if (
      typeof credentialRef !== "string" ||
      !UUID_PATTERN.test(credentialRef) ||
      parsed === undefined ||
      (renewCredentials !== undefined && typeof renewCredentials !== "boolean")
    ) {
      return failure("invalid-request", 400);
    }
    return answer(
      await runtime.sign({
        credentialRef,
        request: parsed,
        renewCredentials: renewCredentials === true,
      }),
    );
  }
  if (pathname === "/v1/cloud-iam/revoke") {
    const credentialRef = value.credentialRef;
    if (
      !hasExactKeys(value, ["credentialRef"]) ||
      typeof credentialRef !== "string" ||
      !UUID_PATTERN.test(credentialRef)
    ) {
      return failure("invalid-request", 400);
    }
    return answer(await runtime.revoke(credentialRef));
  }
  return failure("not-found", 404);
}

function readSignRequest(value: unknown): CloudIamSignRequest | undefined {
  if (!isRecord(value) || !Object.keys(value).every((key) => REQUEST_KEYS.has(key))) {
    return undefined;
  }
  if (Object.keys(value).length !== REQUEST_KEYS.size) return undefined;
  const { method, host, path, query, headers, payloadHash } = value;
  if (
    typeof method !== "string" ||
    typeof host !== "string" ||
    typeof path !== "string" ||
    typeof payloadHash !== "string" ||
    !Array.isArray(query) ||
    !isRecord(headers)
  ) {
    return undefined;
  }
  const pairs: Array<readonly [string, string]> = [];
  for (const pair of query) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string"
    ) {
      return undefined;
    }
    pairs.push([pair[0], pair[1]]);
  }
  const signable: Record<string, string> = {};
  for (const [name, field] of Object.entries(headers)) {
    if (typeof field !== "string") return undefined;
    signable[name] = field;
  }
  return { method, host, path, query: pairs, headers: signable, payloadHash };
}

async function readObject(
  request: Request,
): Promise<
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" }
> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_ROUTE_BYTES) return { kind: "too-large" };
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(value) ? { kind: "ok", value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * An answer's JSON object, or `undefined` for one too long or not an object.
 * A body that stops arriving (the request's deadline passed, or the
 * connection dropped) throws, so the caller reads it as no answer rather
 * than as an answer it could not understand.
 */
async function readResponseJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_CHARS) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function lowercaseKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function isBoundedSecret(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SECRET_CHARS && VISIBLE_ASCII_LONG.test(value);
}

// Secrets and tokens are printable ASCII; a line break or control character
// in one would be refused by the services that issued it.
const VISIBLE_ASCII_LONG = /^[\x21-\x7e]+$/;

function hasExactKeys<const Keys extends string>(
  value: unknown,
  keys: ReadonlyArray<Keys>,
): value is Record<Keys, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function failure(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
