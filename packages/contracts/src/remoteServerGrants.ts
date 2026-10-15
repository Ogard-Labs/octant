import { Schema } from "effect";
import { CodeThreadId } from "./code";
import {
  LocalServerHealth,
  LocalServerListenerId,
  LocalServerPort,
  LocalServerRequestId,
} from "./localServers";
import { ProjectId } from "./projects";
import { DeviceId } from "./remoteAccess";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Opaque grant to open one Octant-owned dev server on another computer.
 *
 * The host mints it from 32 random bytes and binds it, on the host, to the
 * paired device, its credential generation, the proxy session, the thread, the
 * listener id, and the observed endpoint. None of those bindings travel inside
 * the id, so presenting it proves nothing on its own: every proxied request is
 * still checked against the device proof and the host's record of the grant.
 */
export const RemoteServerGrantId = Schema.String.pipe(
  Schema.pattern(/^rsg_[a-f0-9]{64}$/),
  Schema.brand("RemoteServerGrantId"),
);
export type RemoteServerGrantId = typeof RemoteServerGrantId.Type;

/**
 * The listing the listener id came from. The same listener has a different id
 * in a thread's Local servers and in the start screen's Running services, so
 * the request names which listing the host re-observes. Running services names
 * no thread or Project, exactly as its own commands do: the host learns the
 * thread from the row it re-observes, never from the client.
 */
export const RemoteServerGrantSource = Schema.Union(
  Schema.Struct({
    surface: Schema.Literal("local-servers"),
    threadId: CodeThreadId,
    projectId: ProjectId,
    listenerId: LocalServerListenerId,
  }).annotations(strict),
  Schema.Struct({
    surface: Schema.Literal("running-services"),
    listenerId: LocalServerListenerId,
  }).annotations(strict),
);
export type RemoteServerGrantSource = typeof RemoteServerGrantSource.Type;

/**
 * A paired device asks the host for a grant. Strict: the client never names a
 * port, address, URL, process, or command line, so a request cannot point the
 * proxy at anything the host did not list itself.
 */
export const RemoteServerGrantRequest = Schema.Struct({
  kind: Schema.Literal("open-remote-server-grant"),
  requestId: LocalServerRequestId,
  source: RemoteServerGrantSource,
}).annotations(strict);
export type RemoteServerGrantRequest = typeof RemoteServerGrantRequest.Type;

/**
 * What the client needs to reach the server: the grant for the proxy route, and
 * the thread and port it derives the page's stable local name from. The host's
 * loopback URL and the identity of the process holding the port stay on the
 * host.
 */
export const RemoteServerGrant = Schema.Struct({
  grantId: RemoteServerGrantId,
  threadId: CodeThreadId,
  port: LocalServerPort,
}).annotations(strict);
export type RemoteServerGrant = typeof RemoteServerGrant.Type;

/**
 * Why the host would not mint a grant, one case per rule.
 *
 * - `local-principal`: the request came from a local window or an agent on the
 *   host, which opens the server directly and never through the proxy.
 * - `thread-unreadable`: the device cannot read the thread under the remote
 *   rules.
 * - `not-found`: the id is not in the named listing. An id that was never
 *   listed and a server that stopped answer the same, so a refusal never says
 *   whether some other process holds a port.
 * - `not-octant-owned`: Octant cannot tell who started the server, so it never
 *   leaves the host, with or without a confirmation.
 * - `not-in-thread`: the server does not run in one thread's own worktree
 *   (it runs in the Project folder, which is no one thread's, or outside the
 *   requested thread's checkout), and grants are thread-scoped.
 * - `not-listening`: the host did not see the server answer, either because it
 *   held the port without answering or because the host never finished asking.
 * - `open-denied`: the local Open decision for the thread's posture refuses it,
 *   and a paired device never gets more than a local window would.
 * - `grant-limit`: every other rule allows the grant, but the device already
 *   holds {@link REMOTE_SERVER_GRANTS_PER_DEVICE} open grants or the host holds
 *   {@link REMOTE_SERVER_GRANTS_PER_HOST}. Asked last, so it never hides a
 *   refusal that says why the server itself cannot open.
 */
export const RemoteServerGrantRefusal = Schema.Union(
  Schema.Struct({
    reason: Schema.Literal(
      "local-principal",
      "thread-unreadable",
      "not-found",
      "not-octant-owned",
      "not-in-thread",
      "open-denied",
      "grant-limit",
    ),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    reason: Schema.Literal("not-listening"),
    health: LocalServerHealth.pipe(
      Schema.filter((health) => health !== "listening", {
        message: () => "A listening server is not a reason to refuse a grant.",
      }),
    ),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type RemoteServerGrantRefusal = typeof RemoteServerGrantRefusal.Type;
export type RemoteServerGrantRefusalReason = RemoteServerGrantRefusal["reason"];

/** How many grants one paired device may hold open at once. */
export const REMOTE_SERVER_GRANTS_PER_DEVICE = 8;
/** How many grants the host holds open at once, across every paired device. */
export const REMOTE_SERVER_GRANTS_PER_HOST = 32;

export const RemoteServerGrantResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("remote-server-grant-opened"),
    requestId: LocalServerRequestId,
    grant: RemoteServerGrant,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remote-server-grant-refused"),
    requestId: LocalServerRequestId,
    refusal: RemoteServerGrantRefusal,
  }).annotations(strict),
);
export type RemoteServerGrantResult = typeof RemoteServerGrantResult.Type;

export const REMOTE_SERVER_GRANT_OPENED = "remote-server.grant-opened@1" as const;
export const REMOTE_SERVER_GRANT_CLOSED = "remote-server.grant-closed@1" as const;
export const REMOTE_SERVER_GRANT_EVENT_NAMES = [
  REMOTE_SERVER_GRANT_OPENED,
  REMOTE_SERVER_GRANT_CLOSED,
] as const;
export type RemoteServerGrantEventName = (typeof REMOTE_SERVER_GRANT_EVENT_NAMES)[number];

/**
 * A grant opening and closing are journaled with the device, thread, and port;
 * single proxied requests are not. The loopback URL, process identity, and
 * proxy session stay out of the journal.
 */
const GrantEventFields = {
  grantId: RemoteServerGrantId,
  deviceId: DeviceId,
  threadId: CodeThreadId,
  port: LocalServerPort,
} as const;

export const RemoteServerGrantOpenedPayload = Schema.Struct(GrantEventFields).annotations(strict);
export type RemoteServerGrantOpenedPayload = typeof RemoteServerGrantOpenedPayload.Type;

/**
 * Every way a grant ends. Each one is a loss of something the grant was bound
 * to: the device's standing, the proxy session, the listener, the thread, Code
 * itself, or the process that held the port.
 */
export const RemoteServerGrantCloseReason = Schema.Literal(
  "device-revoked",
  "device-credential-rotated",
  "device-credential-expired",
  "device-signed-out",
  "proxy-session-ended",
  "listener-disabled",
  "thread-archived",
  "thread-unreadable",
  "code-disabled",
  "server-stopped",
  "server-changed-hands",
);
export type RemoteServerGrantCloseReason = typeof RemoteServerGrantCloseReason.Type;

export const RemoteServerGrantClosedPayload = Schema.Struct({
  ...GrantEventFields,
  reason: RemoteServerGrantCloseReason,
}).annotations(strict);
export type RemoteServerGrantClosedPayload = typeof RemoteServerGrantClosedPayload.Type;

/**
 * A response the host relays from the dev server carries this header with the
 * value {@link REMOTE_SERVER_PROXY_RELAYED}. The host strips every `x-octant-`
 * header the dev server sends, so only the host can set it: a response without
 * it is the host's own answer (a refusal, a budget, a failed proof), never the
 * dev server's, whatever its status or body says.
 *
 * Relayed requests travel on `/api/server-proxy/<grant id>` followed by the dev
 * server's own path and query.
 */
export const REMOTE_SERVER_PROXY_RELAYED_HEADER = "x-octant-server-proxy" as const;
export const REMOTE_SERVER_PROXY_RELAYED = "relayed" as const;

/**
 * Why the host did not relay a request whose device proof it accepted.
 *
 * - `grant-closed`: the grant is not open for this device and proxy session,
 *   or a check before this request closed it (the server stopped or changed
 *   hands, the thread was archived or can no longer be read, Code is off). A
 *   grant that never existed, one another device holds, and one that closed
 *   answer the same, so a refusal never says which.
 * - `server-unreachable`: the host could not connect to the dev server on its
 *   loopback address in time, or the dev server failed before answering.
 * - `upgrade-refused`: the request asked to upgrade the connection, which this
 *   route does not carry.
 */
export const RemoteServerProxyRefusal = Schema.Struct({
  kind: Schema.Literal("remote-server-proxy-refused"),
  reason: Schema.Literal("grant-closed", "server-unreachable", "upgrade-refused"),
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type RemoteServerProxyRefusal = typeof RemoteServerProxyRefusal.Type;
export type RemoteServerProxyRefusalReason = RemoteServerProxyRefusal["reason"];

export const decodeRemoteServerProxyRefusal = Schema.decodeUnknownSync(RemoteServerProxyRefusal);
export const encodeRemoteServerProxyRefusal = Schema.encodeSync(RemoteServerProxyRefusal);

export const decodeRemoteServerGrantId = Schema.decodeUnknownSync(RemoteServerGrantId);
export const decodeRemoteServerGrantRequest = Schema.decodeUnknownSync(RemoteServerGrantRequest);
export const decodeRemoteServerGrantResult = Schema.decodeUnknownSync(RemoteServerGrantResult);
export const encodeRemoteServerGrantResult = Schema.encodeSync(RemoteServerGrantResult);
export const decodeRemoteServerGrantOpenedPayload = Schema.decodeUnknownSync(
  RemoteServerGrantOpenedPayload,
);
export const decodeRemoteServerGrantClosedPayload = Schema.decodeUnknownSync(
  RemoteServerGrantClosedPayload,
);
