import { randomBytes as defaultRandomBytes } from "node:crypto";
import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActorDeviceId,
  EventId,
  EventName,
  REMOTE_SERVER_GRANT_CLOSED,
  REMOTE_SERVER_GRANT_OPENED,
  REMOTE_SERVER_GRANTS_PER_DEVICE,
  REMOTE_SERVER_GRANTS_PER_HOST,
  REMOTE_SERVER_PROXY_RELAYED,
  REMOTE_SERVER_PROXY_RELAYED_HEADER,
  THREAD_RETENTION_EVENT_NAMES,
  UtcTimestamp,
  decodeCodeThreadUpdated,
  decodeThreadRetentionThreadPurged,
  type CommittedAppend,
  decodeRemoteServerGrantClosedPayload,
  decodeRemoteServerGrantId,
  decodeRemoteServerGrantOpenedPayload,
  decodeRemoteServerGrantResult,
  type CodeThread,
  type CodeThreadId,
  type EventActor,
  type RemoteServerGrantCloseReason,
  type RemoteServerGrantId,
  type RemoteServerGrantOpenedPayload,
  type RemoteServerGrantRefusal,
  type RemoteServerGrantRequest,
  type RemoteServerGrantResult,
  type RemoteServerGrantSource,
  type WindowId,
} from "@octant/contracts";
import {
  decideRemoteServerGrant,
  relayRequestHeaders,
  relayWebSocketRequestHeaders,
  type RemoteServerGrantThread,
  type RemoteServerRelayHeader,
} from "@octant/domain";
import { Schema } from "effect";
import type { LocalListenerHolder, LocalListenerHolding } from "../localServers/localListenerPort";
import type { RemoteServerGrantTarget } from "../localServers/localServerService";
import type { Journal } from "../persistence/journal";
import type { OpenRemoteServerGrantRecord } from "../persistence/remoteServerGrantProjection";
import {
  WEBSOCKET_RELAY_MAX_MESSAGE_BYTES,
  WebSocketEndpoint,
  acceptWebSocketUpgrade,
  newWebSocketKey,
  sendableCloseCode,
  type WebSocketPeer,
  type WebSocketPeerEvents,
} from "../webSocketRelay";
import {
  DEFAULT_REMOTE_SERVER_RELAY_LIMITS,
  openDevServerWebSocket,
  relayToDevServer,
  type RemoteServerRelayLimits,
} from "./remoteServerProxyRelay";
import { REMOTE_SERVER_PROXY_PATH } from "./remoteServerProxySessions";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeEventActorDeviceId = Schema.decodeUnknownSync(EventActorDeviceId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export const REMOTE_SERVER_GRANT_AGGREGATE = "remote-server-grant";

/**
 * Who asks for a grant, from the request's authenticated principal. A paired
 * device's proxy session is part of it, because a grant is bound to the session
 * it was minted under and ends with it.
 */
export type RemoteServerGrantPrincipal =
  | { readonly kind: "local-window" }
  | {
      readonly kind: "remote-device";
      readonly deviceId: string;
      readonly credentialGeneration: number;
      readonly sessionIdDigest: string;
    };

export interface RemoteServerGrantOpenInput {
  readonly principal: RemoteServerGrantPrincipal;
  /** The request's service scope, which the listing and thread reads are judged under. */
  readonly scopeId: WindowId;
  readonly request: RemoteServerGrantRequest;
  /**
   * Asked once more just before a grant is minted, after every await: whether
   * the session and device the request was authenticated under still stand.
   */
  readonly stillAuthorized?: () => boolean;
  readonly signal?: AbortSignal;
}

/** The proxy session a relayed request was authenticated under, and its device. */
export interface RemoteServerRelayPrincipal {
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly sessionIdDigest: string;
  /** The session's origin: the only `Origin` its requests may carry. */
  readonly origin: string;
}

export interface RemoteServerRelayRequestInput {
  readonly principal: RemoteServerRelayPrincipal;
  /** The request's service scope, which the thread read is judged under. */
  readonly scopeId: WindowId;
  /** As the request named it; it opens nothing unless it is this session's open grant. */
  readonly grantId: string;
  readonly method: string;
  /** The dev server's own path and query. */
  readonly pathQuery: string;
  /** The request's headers as they reached the proxy route. */
  readonly headers: ReadonlyArray<RemoteServerRelayHeader>;
  readonly body: Uint8Array | undefined;
  /** Asked once more just before the host connects: whether the session still stands. */
  readonly stillAuthorized: () => boolean;
  readonly signal: AbortSignal;
}

/**
 * The answer to one relayed request. `relayed` carries the dev server's
 * response; `unavailable` is the host failing to check, never a verdict on the
 * grant; `session-ended` is the proxy session or device ending meanwhile.
 */
export type RemoteServerRelayOutcome =
  | { readonly kind: "relayed"; readonly response: Response }
  | { readonly kind: "refused"; readonly reason: "grant-closed" | "server-unreachable" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "session-ended" };

/** A WebSocket upgrade under a grant: a relayed request with no body. */
export type RemoteServerUpgradeRequestInput = Omit<
  RemoteServerRelayRequestInput,
  "method" | "body"
>;

/**
 * The answer to one WebSocket upgrade. `upgraded` carries the answer the
 * listener's transport turns into the switched connection; `busy` is the
 * grant or device at its socket cap.
 */
export type RemoteServerUpgradeOutcome =
  | { readonly kind: "upgraded"; readonly response: Response }
  | {
      readonly kind: "refused";
      readonly reason: "grant-closed" | "server-unreachable" | "upgrade-refused";
    }
  | { readonly kind: "busy" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "session-ended" };

/** How many relayed WebSockets may be open, and how large a message each carries. */
export interface RemoteServerSocketLimits {
  readonly perGrant: number;
  readonly perDevice: number;
  readonly maxMessageBytes: number;
  /** An accepted upgrade the listener has not switched within this is dropped. */
  readonly switchTimeoutMs: number;
}

export const DEFAULT_REMOTE_SERVER_SOCKET_LIMITS: RemoteServerSocketLimits = {
  perGrant: 4,
  perDevice: 16,
  maxMessageBytes: WEBSOCKET_RELAY_MAX_MESSAGE_BYTES,
  switchTimeoutMs: 10_000,
};

/**
 * The answer to one grant request. `unavailable` is the host failing to look,
 * which is never a refusal of the server; `session-ended` is the proxy session
 * or device ending while the request was decided.
 */
export type RemoteServerGrantOpening =
  | { readonly kind: "answered"; readonly result: RemoteServerGrantResult }
  | { readonly kind: "unavailable" }
  | { readonly kind: "session-ended" };

export interface RemoteServerGrantServiceOptions {
  /** Re-observe the named listing under the request's scope, as Open and Stop do. */
  readonly observeTarget: (
    scopeId: WindowId,
    source: RemoteServerGrantSource,
    signal?: AbortSignal,
  ) => Promise<RemoteServerGrantTarget>;
  /** The remote read rule for a thread: whether this scope can open it. */
  readonly canOpenThread: (scopeId: WindowId, threadId: CodeThreadId) => Promise<boolean>;
  readonly readThread: (
    threadId: CodeThreadId,
  ) => Pick<CodeThread, "lifecycle" | "executionPolicy"> | undefined;
  /** Grants a past run of this host journaled as open. */
  readonly readOpenGrants: () => ReadonlyArray<OpenRemoteServerGrantRecord>;
  /**
   * Re-observe the port a grant forwards to: whether the process it was minted
   * for still holds it as Octant's. Asked before every relayed request.
   */
  readonly confirmEndpoint: (
    holder: LocalListenerHolder,
    signal?: AbortSignal,
  ) => Promise<LocalListenerHolding>;
  /** Whether Code is on; a grant is a Code thread's, so it closes when Code is off. */
  readonly isCodeEnabled: () => boolean;
  readonly relayLimits?: Partial<RemoteServerRelayLimits>;
  readonly socketLimits?: Partial<RemoteServerSocketLimits>;
  readonly journal: Pick<Journal, "append">;
  /** Speaks for the host when anything but the device itself ends a grant. */
  readonly hostActor: EventActor;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly limits?: { readonly perDevice?: number; readonly perHost?: number };
}

interface LiveGrant {
  readonly grantId: RemoteServerGrantId;
  readonly aggregateId: string;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly sessionIdDigest: string;
  readonly threadId: CodeThreadId;
  /** Where the host forwards, and the process that held it when the grant was minted. */
  readonly endpoint: {
    readonly url: string;
    readonly port: number;
    readonly pid: number;
    readonly processName: string;
  };
}

/**
 * Mints and closes grants to open one Octant-owned dev server from a paired
 * device.
 *
 * The host gathers every fact the grant policy needs itself: the principal from
 * the authenticated request, thread readability from the remote read rule, the
 * listener by re-observing the listing its id came from, ownership and health
 * from that observation, the thread from the worktree the server runs in, and
 * the posture from the thread. Nothing about the server comes from the client.
 *
 * Grants live in this host's memory, bound to the proxy session they were
 * minted under; the journal records each opening and closing. A host that
 * starts closes every grant a past run left open, because the session it was
 * bound to did not survive.
 */
export class RemoteServerGrantService {
  readonly #options: RemoteServerGrantServiceOptions;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #perDevice: number;
  readonly #perHost: number;
  readonly #grants = new Map<string, LiveGrant>();
  readonly #relayLimits: RemoteServerRelayLimits;
  readonly #socketLimits: RemoteServerSocketLimits;
  /** Relayed WebSockets open or opening, by grant. */
  readonly #sockets = new Map<string, number>();
  /** Every relayed request still in flight, by grant, each with its abort. */
  readonly #relaying = new Map<string, Set<() => void>>();
  /** The certificate an HTTPS dev server presented first under each grant. */
  readonly #pins = new Map<string, string>();
  /** The endpoint check running for a grant, and the one queued behind it. */
  readonly #confirming = new Map<
    string,
    { readonly current: Promise<LocalListenerHolding>; next?: Promise<LocalListenerHolding> }
  >();
  /**
   * Bumped whenever a thread or a server stops holding grants, whether or not
   * one was open. A request that started before the bump may have read the
   * thread or the listener before it changed, so it mints nothing.
   */
  #settlements = 0;

  constructor(options: RemoteServerGrantServiceOptions) {
    this.#options = options;
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#perDevice = options.limits?.perDevice ?? REMOTE_SERVER_GRANTS_PER_DEVICE;
    this.#perHost = options.limits?.perHost ?? REMOTE_SERVER_GRANTS_PER_HOST;
    this.#relayLimits = { ...DEFAULT_REMOTE_SERVER_RELAY_LIMITS, ...options.relayLimits };
    this.#socketLimits = { ...DEFAULT_REMOTE_SERVER_SOCKET_LIMITS, ...options.socketLimits };
  }

  async open(input: RemoteServerGrantOpenInput): Promise<RemoteServerGrantOpening> {
    const { principal, request } = input;
    const settlementsAtStart = this.#settlements;
    if (principal.kind !== "remote-device") {
      // A local window opens the server directly; nothing about it is read.
      return this.#decided(request, { actor: "local-user", listener: { status: "not-listed" } });
    }

    // Readability before the listing: a device that cannot read the thread it
    // named learns nothing about which ids are listed in it.
    const named =
      request.source.surface === "local-servers"
        ? await this.#threadFact(input.scopeId, request.source.threadId)
        : undefined;
    if (named === "unavailable") return { kind: "unavailable" };
    if (named?.access === "unreadable") {
      return this.#decided(request, {
        actor: "remote-client",
        thread: named,
        listener: { status: "not-listed" },
      });
    }

    let target: RemoteServerGrantTarget;
    try {
      target = await this.#options.observeTarget(input.scopeId, request.source, input.signal);
    } catch {
      return { kind: "unavailable" };
    }
    if (target.status === "unavailable") return { kind: "unavailable" };
    if (target.status === "not-listed") {
      return this.#decided(request, {
        actor: "remote-client",
        ...(named === undefined ? {} : { thread: named }),
        listener: { status: "not-listed" },
      });
    }

    // Read the thread again after the observation: an archive, a lost read,
    // or a posture change while the host looked must decide this grant, not
    // the thread as it stood before.
    const threadId = target.threadId;
    const thread =
      threadId === undefined ? undefined : await this.#threadFact(input.scopeId, threadId);
    if (thread === "unavailable") return { kind: "unavailable" };
    const decision = decideRemoteServerGrant({
      actor: "remote-client",
      ...(thread === undefined ? {} : { thread }),
      listener: { status: "listed", ownership: target.ownership, health: target.health },
    });
    if (decision.kind === "refuse") return refusedWith(request, decision.refusal);
    // The policy grants nothing without a thread, so this is never reached
    // without one; it keeps the compiler and a later policy change honest.
    if (threadId === undefined) {
      return refusedWith(request, { reason: "not-in-thread" });
    }

    if (input.stillAuthorized !== undefined && !input.stillAuthorized()) {
      return { kind: "session-ended" };
    }
    // Everything from here to the journal append is synchronous, so no close
    // can land between these checks and the grant existing.
    if (this.#settlements !== settlementsAtStart) return { kind: "unavailable" };
    if (this.#options.readThread(threadId)?.lifecycle !== "active") {
      return refusedWith(request, { reason: "thread-unreadable" });
    }

    const reused = [...this.#grants.values()].find(
      (grant) =>
        grant.deviceId === principal.deviceId &&
        grant.sessionIdDigest === principal.sessionIdDigest &&
        String(grant.threadId) === String(threadId) &&
        grant.endpoint.pid === target.endpoint.pid &&
        grant.endpoint.port === target.endpoint.port &&
        grant.endpoint.url === target.endpoint.url,
    );
    if (reused !== undefined) return opened(request, reused);

    const held = [...this.#grants.values()].filter(
      (grant) => grant.deviceId === principal.deviceId,
    ).length;
    if (held >= this.#perDevice || this.#grants.size >= this.#perHost) {
      return refusedWith(request, { reason: "grant-limit" });
    }

    const grant: LiveGrant = {
      grantId: decodeRemoteServerGrantId(
        `rsg_${Buffer.from(this.#randomBytes(32)).toString("hex")}`,
      ),
      aggregateId: this.#options.uuid(),
      deviceId: principal.deviceId,
      credentialGeneration: principal.credentialGeneration,
      sessionIdDigest: principal.sessionIdDigest,
      threadId,
      endpoint: target.endpoint,
    };
    // Journaled before the grant exists: a grant nobody can find in the journal
    // is a grant nobody can account for.
    try {
      this.#append(
        grant.aggregateId,
        0,
        REMOTE_SERVER_GRANT_OPENED,
        deviceActor(grant.deviceId),
        payloadOf(grant),
      );
    } catch {
      return { kind: "unavailable" };
    }
    this.#grants.set(String(grant.grantId), grant);
    return opened(request, grant);
  }

  /**
   * Relay one request under a grant to its dev server, after the checks every
   * new upstream connection takes (see `#check`). A lost check refuses the
   * request like any closed grant.
   *
   * The request is registered under its grant before the host connects, so a
   * grant that closes at any point after (a revoke, a sign-out, an archive)
   * closes the connection and cuts the relayed response before the call that
   * closed it returns.
   */
  async relay(input: RemoteServerRelayRequestInput): Promise<RemoteServerRelayOutcome> {
    const checked = await this.#check(input);
    if (!("grantId" in checked)) return checked;
    // Everything from here to registering the request is synchronous, so a
    // close that lands after these checks finds the request and cuts it.
    const grant = checked;
    const last = this.#lastCheck(grant, input);
    if (last !== undefined) return last;
    const cut = new AbortController();
    const untrack = this.#track(grant, () => cut.abort());
    const upstream = new URL(grant.endpoint.url);
    const attempt = await relayToDevServer({
      endpointUrl: grant.endpoint.url,
      request: {
        method: input.method,
        pathQuery: input.pathQuery,
        headers: relayRequestHeaders({
          headers: input.headers,
          listenerOrigin: input.principal.origin,
          grantPath: `${REMOTE_SERVER_PROXY_PATH}${String(grant.grantId)}`,
          upstream: {
            scheme: upstream.protocol === "https:" ? "https" : "http",
            port: grant.endpoint.port,
          },
          bodyBytes: input.body?.byteLength,
        }),
        body: input.body,
      },
      acceptCertificate: (fingerprint) => this.#acceptCertificate(grant, fingerprint),
      signal: AbortSignal.any([cut.signal, input.signal]),
      onSettled: untrack,
      limits: this.#relayLimits,
    });
    switch (attempt.kind) {
      case "responded":
        return { kind: "relayed", response: attempt.response };
      case "certificate-changed":
        this.#closeGrant(grant, "server-changed-hands");
        return closedGrant();
      case "unreachable":
        return cut.signal.aborted
          ? closedGrant()
          : { kind: "refused", reason: "server-unreachable" };
      case "aborted":
        return closedGrant();
    }
  }

  /**
   * Open a WebSocket under a grant to its dev server, for a page's upgrade.
   *
   * The host checks the grant exactly as it does before a relayed request,
   * then holds the grant and the device to their socket caps, and connects.
   * Only when the dev server has accepted does the page's connection switch;
   * after that, messages carry no proof of their own and the socket lives
   * under its grant: it is registered there before the host connects, and
   * closing the grant closes both ends (the page's with 1008) before the call
   * that closed it returns.
   */
  async relayUpgrade(input: RemoteServerUpgradeRequestInput): Promise<RemoteServerUpgradeOutcome> {
    const checked = await this.#check(input);
    if (!("grantId" in checked)) return checked;
    const grant = checked;
    // Everything from here to registering the socket is synchronous, as in relay.
    const last = this.#lastCheck(grant, input);
    if (last !== undefined) return last;
    const key = String(grant.grantId);
    const onDevice = [...this.#grants.values()]
      .filter((candidate) => candidate.deviceId === grant.deviceId)
      .reduce((sum, candidate) => sum + (this.#sockets.get(String(candidate.grantId)) ?? 0), 0);
    if (
      (this.#sockets.get(key) ?? 0) >= this.#socketLimits.perGrant ||
      onDevice >= this.#socketLimits.perDevice
    ) {
      return { kind: "busy" };
    }
    this.#sockets.set(key, (this.#sockets.get(key) ?? 0) + 1);
    let held = true;
    const cut = new AbortController();
    const untrack = this.#track(grant, () => cut.abort());
    const release = () => {
      if (!held) return;
      held = false;
      untrack();
      const count = (this.#sockets.get(key) ?? 1) - 1;
      if (count <= 0) this.#sockets.delete(key);
      else this.#sockets.set(key, count);
    };

    const upstream = new URL(grant.endpoint.url);
    const wsKey = newWebSocketKey();
    const protocols = offeredProtocols(input.headers);
    const attempt = await openDevServerWebSocket({
      endpointUrl: grant.endpoint.url,
      pathQuery: input.pathQuery,
      key: wsKey,
      protocols,
      headers: relayWebSocketRequestHeaders({
        headers: input.headers,
        listenerOrigin: input.principal.origin,
        grantPath: `${REMOTE_SERVER_PROXY_PATH}${key}`,
        upstream: {
          scheme: upstream.protocol === "https:" ? "https" : "http",
          port: grant.endpoint.port,
        },
        key: wsKey,
      }),
      acceptCertificate: (fingerprint) => this.#acceptCertificate(grant, fingerprint),
      signal: AbortSignal.any([cut.signal, input.signal]),
      limits: this.#relayLimits,
    });
    if (attempt.kind !== "opened") release();
    switch (attempt.kind) {
      case "opened":
        break;
      case "declined":
        return { kind: "refused", reason: "upgrade-refused" };
      case "certificate-changed":
        this.#closeGrant(grant, "server-changed-hands");
        return closedGrant();
      case "unreachable":
        return cut.signal.aborted
          ? closedGrant()
          : { kind: "refused", reason: "server-unreachable" };
      case "aborted":
        return closedGrant();
    }
    const { socket, head, protocol } = attempt;
    if (cut.signal.aborted) {
      socket.destroy();
      release();
      return closedGrant();
    }

    const devServer = new WebSocketEndpoint(socket, "client", this.#socketLimits.maxMessageBytes);
    let page: WebSocketPeer | undefined;
    const end = () => {
      clearTimeout(switchTimer);
      cut.signal.removeEventListener("abort", onCut);
      release();
    };
    function onCut() {
      page?.close(1008, "The grant for this server closed.");
      devServer.close(1001, "");
      if (page === undefined) socket.destroy();
      end();
    }
    cut.signal.addEventListener("abort", onCut, { once: true });
    // An acceptance the listener never switches would hold the dev server's
    // connection and a socket slot for nothing.
    const switchTimer = setTimeout(() => {
      if (page !== undefined) return;
      socket.destroy();
      end();
    }, this.#socketLimits.switchTimeoutMs);
    switchTimer.unref?.();

    const response = acceptWebSocketUpgrade(
      {
        protocol,
        cancel: () => {
          if (page !== undefined) return;
          socket.destroy();
          end();
        },
        open: (client): WebSocketPeerEvents => {
          page = client;
          clearTimeout(switchTimer);
          if (!held) {
            client.close(1008, "The grant for this server closed.");
            return { message: () => undefined, closed: () => undefined };
          }
          devServer.start(
            {
              message: (message) => client.send(message),
              closed: (code, reason) => {
                client.close(sendableCloseCode(code), reason);
                end();
              },
            },
            head,
          );
          return {
            message: (message) => devServer.send(message),
            closed: (code, reason) => {
              devServer.close(sendableCloseCode(code), reason);
              end();
            },
          };
        },
      },
      { [REMOTE_SERVER_PROXY_RELAYED_HEADER]: REMOTE_SERVER_PROXY_RELAYED },
    );
    return { kind: "upgraded", response };
  }

  /** Whether any grant bound to this proxy session has a relayed WebSocket open. */
  holdsOpenSockets(sessionIdDigest: string): boolean {
    for (const grant of this.#grants.values()) {
      if (grant.sessionIdDigest !== sessionIdDigest) continue;
      if ((this.#sockets.get(String(grant.grantId)) ?? 0) > 0) return true;
    }
    return false;
  }

  /** Close every grant bound to one proxy session. */
  closeSession(sessionIdDigest: string, reason: RemoteServerGrantCloseReason): void {
    this.#closeWhere((grant) => grant.sessionIdDigest === sessionIdDigest, reason);
  }

  closeDevice(deviceId: string, reason: RemoteServerGrantCloseReason): void {
    this.#closeWhere((grant) => grant.deviceId === deviceId, reason);
  }

  closeThread(threadId: string, reason: RemoteServerGrantCloseReason): void {
    this.#settlements += 1;
    this.#closeWhere((grant) => String(grant.threadId) === String(threadId), reason);
  }

  /**
   * Close grants a committed journal append ends: a Code thread that stops
   * being active, and a Code thread that is purged. Each event is judged on its
   * own payload, and one that cannot be read never stops the rest.
   */
  observeCommitted(append: CommittedAppend): void {
    for (const event of append.events) {
      try {
        if (event.eventName === "code.thread-updated@1" && event.aggregateType === "code-thread") {
          const { thread } = decodeCodeThreadUpdated(event.payload);
          if (thread.lifecycle !== "active") this.closeThread(String(thread.id), "thread-archived");
        } else if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
          const purged = decodeThreadRetentionThreadPurged(event.payload);
          // Closed before the purge erases the thread's records, which takes
          // these closings with it.
          if (purged.mode === "code")
            this.closeThread(String(purged.threadId), "thread-unreadable");
        }
      } catch {
        // An event this service cannot read closes nothing; the next request
        // re-reads the thread before minting.
      }
    }
  }

  /** A server Octant stopped: every grant to the process that held that port. */
  closeServer(stopped: { readonly pid: number; readonly port: number }): void {
    this.#settlements += 1;
    this.#closeWhere(
      (grant) => grant.endpoint.pid === stopped.pid && grant.endpoint.port === stopped.port,
      "server-stopped",
    );
  }

  closeAll(reason: RemoteServerGrantCloseReason): void {
    this.#closeWhere(() => true, reason);
  }

  /**
   * Close what a past run of this host left open. Its proxy sessions lived in
   * that process's memory, so none of its grants can be presented again.
   */
  reconcile(): void {
    for (const record of this.#options.readOpenGrants()) {
      if (this.#grants.has(String(record.grant.grantId))) continue;
      try {
        this.#append(record.aggregateId, 1, REMOTE_SERVER_GRANT_CLOSED, this.#options.hostActor, {
          ...record.grant,
          reason: "proxy-session-ended",
        });
      } catch {
        console.warn("Octant could not record that a remote server grant ended.");
      }
    }
  }

  /** How many grants are open, for one device or the whole host. */
  openCount(deviceId?: string): number {
    if (deviceId === undefined) return this.#grants.size;
    return [...this.#grants.values()].filter((grant) => grant.deviceId === deviceId).length;
  }

  /** The open grant an id names, only for the device, generation, and session it is bound to. */
  #grantFor(grantId: string, principal: RemoteServerRelayPrincipal): LiveGrant | undefined {
    const grant = this.#grants.get(grantId);
    if (
      grant === undefined ||
      grant.deviceId !== principal.deviceId ||
      grant.credentialGeneration !== principal.credentialGeneration ||
      grant.sessionIdDigest !== principal.sessionIdDigest
    ) {
      return undefined;
    }
    return grant;
  }

  /**
   * The checks before every new upstream connection, in order: the grant is
   * open and bound to this device, credential generation, and proxy session;
   * Code is on; the thread is active and this device can still read it; and
   * the process the grant was minted for still holds its port as Octant's. A
   * loss closes the grant, journaled with why; a check the host could not
   * make answers unavailable and keeps the grant.
   */
  async #check(
    input: Pick<RemoteServerRelayRequestInput, "grantId" | "principal" | "scopeId">,
  ): Promise<
    LiveGrant | Extract<RemoteServerRelayOutcome, { readonly kind: "refused" | "unavailable" }>
  > {
    const grant = this.#grantFor(input.grantId, input.principal);
    if (grant === undefined) return closedGrant();
    if (!this.#options.isCodeEnabled()) {
      this.#closeGrant(grant, "code-disabled");
      return closedGrant();
    }
    const thread = this.#options.readThread(grant.threadId);
    if (thread === undefined || thread.lifecycle !== "active") {
      this.#closeGrant(grant, thread === undefined ? "thread-unreadable" : "thread-archived");
      return closedGrant();
    }
    let readable: boolean;
    try {
      readable = await this.#options.canOpenThread(input.scopeId, grant.threadId);
    } catch {
      return { kind: "unavailable" };
    }
    if (!readable) {
      this.#closeGrant(grant, "thread-unreadable");
      return closedGrant();
    }
    const host = loopbackHost(grant.endpoint.url);
    // The relay connects to a loopback address literal or nowhere.
    if (host === undefined) return { kind: "refused", reason: "server-unreachable" };
    const holding = await this.#confirmEndpoint(grant, host);
    if (holding === "unavailable") return { kind: "unavailable" };
    if (holding !== "held") {
      this.#closeGrant(grant, holding === "stopped" ? "server-stopped" : "server-changed-hands");
      return closedGrant();
    }
    return grant;
  }

  /** The synchronous checks just before the host connects; nothing may await after them. */
  #lastCheck(
    grant: LiveGrant,
    input: Pick<RemoteServerRelayRequestInput, "stillAuthorized">,
  ): Extract<RemoteServerRelayOutcome, { readonly kind: "refused" | "session-ended" }> | undefined {
    if (!input.stillAuthorized()) return { kind: "session-ended" };
    if (this.#grants.get(String(grant.grantId)) !== grant) return closedGrant();
    if (!this.#options.isCodeEnabled()) {
      this.#closeGrant(grant, "code-disabled");
      return closedGrant();
    }
    return undefined;
  }

  #closeGrant(grant: LiveGrant, reason: RemoteServerGrantCloseReason): void {
    this.#closeWhere((candidate) => candidate === grant, reason);
  }

  /** Register an in-flight request's abort under its grant; the result unregisters it. */
  #track(grant: LiveGrant, abort: () => void): () => void {
    const key = String(grant.grantId);
    let aborts = this.#relaying.get(key);
    if (aborts === undefined) {
      aborts = new Set();
      this.#relaying.set(key, aborts);
    }
    aborts.add(abort);
    return () => {
      const current = this.#relaying.get(key);
      current?.delete(abort);
      if (current?.size === 0) this.#relaying.delete(key);
    };
  }

  /**
   * The first certificate an HTTPS dev server presents under a grant is pinned
   * for the grant's life. A different one later means a different server, or
   * the same port changed hands between two checks.
   */
  #acceptCertificate(grant: LiveGrant, fingerprint: string): boolean {
    const key = String(grant.grantId);
    if (this.#grants.get(key) !== grant) return false;
    const pinned = this.#pins.get(key);
    if (pinned === undefined) {
      this.#pins.set(key, fingerprint);
      return true;
    }
    return pinned === fingerprint;
  }

  /**
   * Re-observe the grant's endpoint for a request. A request never relies on
   * an observation that started before it arrived: it joins the check queued
   * behind the one running, which starts when that one ends, so a burst of
   * requests shares at most two observations rather than one each.
   */
  #confirmEndpoint(grant: LiveGrant, host: "127.0.0.1" | "::1"): Promise<LocalListenerHolding> {
    const key = String(grant.grantId);
    const queued = this.#confirming.get(key);
    if (queued === undefined) return this.#startConfirmation(key, grant, host);
    if (queued.next !== undefined) return queued.next;
    const next = queued.current.then(
      () => this.#startConfirmation(key, grant, host),
      () => this.#startConfirmation(key, grant, host),
    );
    queued.next = next;
    return next;
  }

  #startConfirmation(
    key: string,
    grant: LiveGrant,
    host: "127.0.0.1" | "::1",
  ): Promise<LocalListenerHolding> {
    const current = this.#options
      .confirmEndpoint({
        host,
        port: grant.endpoint.port,
        pid: grant.endpoint.pid,
        processName: grant.endpoint.processName,
      })
      .catch((): LocalListenerHolding => "unavailable");
    this.#confirming.set(key, { current });
    void current.then(() => {
      const slot = this.#confirming.get(key);
      if (slot?.current === current && slot.next === undefined) this.#confirming.delete(key);
    });
    return current;
  }

  /** `unavailable` is the host failing to answer, never a verdict on the thread. */
  async #threadFact(
    scopeId: WindowId,
    threadId: CodeThreadId,
  ): Promise<RemoteServerGrantThread | "unavailable"> {
    const thread = this.#options.readThread(threadId);
    // An archived thread holds no grant, since archiving closes one, so it is
    // refused as a thread this device cannot open servers in.
    if (thread === undefined || thread.lifecycle !== "active") return { access: "unreadable" };
    let readable: boolean;
    try {
      readable = await this.#options.canOpenThread(scopeId, threadId);
    } catch {
      return "unavailable";
    }
    return readable
      ? { access: "readable", posture: thread.executionPolicy }
      : { access: "unreadable" };
  }

  #decided(
    request: RemoteServerGrantRequest,
    facts: Parameters<typeof decideRemoteServerGrant>[0],
  ): RemoteServerGrantOpening {
    const decision = decideRemoteServerGrant(facts);
    if (decision.kind === "refuse") return refusedWith(request, decision.refusal);
    // Every call site above passes facts the policy refuses.
    return { kind: "unavailable" };
  }

  #closeWhere(matches: (grant: LiveGrant) => boolean, reason: RemoteServerGrantCloseReason): void {
    for (const grant of this.#grants.values()) {
      if (!matches(grant)) continue;
      const key = String(grant.grantId);
      this.#grants.delete(key);
      this.#pins.delete(key);
      // Cut every request in flight under the grant before the close returns:
      // the upstream socket closes and the relayed response errors.
      const aborts = this.#relaying.get(key);
      this.#relaying.delete(key);
      for (const abort of aborts ?? []) {
        try {
          abort();
        } catch {
          // One request's abort failing never keeps another's open.
        }
      }
      try {
        this.#append(grant.aggregateId, 1, REMOTE_SERVER_GRANT_CLOSED, this.#options.hostActor, {
          ...payloadOf(grant),
          reason,
        });
      } catch {
        console.warn("Octant could not record that a remote server grant ended.");
      }
    }
  }

  #append(
    aggregateId: string,
    expectedVersion: number,
    eventName: typeof REMOTE_SERVER_GRANT_OPENED | typeof REMOTE_SERVER_GRANT_CLOSED,
    actor: EventActor,
    payload: unknown,
  ): void {
    const decoded =
      eventName === REMOTE_SERVER_GRANT_OPENED
        ? decodeRemoteServerGrantOpenedPayload(payload)
        : decodeRemoteServerGrantClosedPayload(payload);
    this.#options.journal.append({
      aggregate: {
        aggregateType: REMOTE_SERVER_GRANT_AGGREGATE,
        aggregateId: decodeAggregateId(aggregateId),
      },
      expectedVersion: decodeAggregateVersion(expectedVersion),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor,
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload: decoded,
        },
      ],
    });
  }
}

function payloadOf(grant: LiveGrant): RemoteServerGrantOpenedPayload {
  return decodeRemoteServerGrantOpenedPayload({
    grantId: grant.grantId,
    deviceId: grant.deviceId,
    threadId: grant.threadId,
    port: grant.endpoint.port,
  });
}

/** The device that asked is the actor of its grant's opening. */
function deviceActor(deviceId: string): EventActor {
  return {
    kind: "remote-device",
    actorId: decodeActorId(deviceId),
    deviceId: decodeEventActorDeviceId(deviceId),
  };
}

/** The loopback address literal a grant's endpoint names, or nothing. */
function loopbackHost(url: string): "127.0.0.1" | "::1" | undefined {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" ? "127.0.0.1" : hostname === "[::1]" ? "::1" : undefined;
  } catch {
    return undefined;
  }
}

function closedGrant(): { readonly kind: "refused"; readonly reason: "grant-closed" } {
  return { kind: "refused", reason: "grant-closed" };
}

/** The subprotocols a page's upgrade offered, in its order. */
function offeredProtocols(headers: ReadonlyArray<RemoteServerRelayHeader>): ReadonlyArray<string> {
  return headers
    .filter(([name]) => name.toLowerCase() === "sec-websocket-protocol")
    .flatMap(([, value]) => value.split(","))
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== "");
}

function opened(request: RemoteServerGrantRequest, grant: LiveGrant): RemoteServerGrantOpening {
  return {
    kind: "answered",
    result: decodeRemoteServerGrantResult({
      kind: "remote-server-grant-opened",
      requestId: request.requestId,
      grant: { grantId: grant.grantId, threadId: grant.threadId, port: grant.endpoint.port },
    }),
  };
}

type PolicyRefusal =
  | Extract<ReturnType<typeof decideRemoteServerGrant>, { readonly kind: "refuse" }>["refusal"]
  | { readonly reason: "grant-limit" };

function refusedWith(
  request: RemoteServerGrantRequest,
  refusal: PolicyRefusal,
): RemoteServerGrantOpening {
  const wire: RemoteServerGrantRefusal =
    refusal.reason === "not-listening"
      ? { reason: "not-listening", health: refusal.health, message: REFUSAL_COPY["not-listening"] }
      : { reason: refusal.reason, message: REFUSAL_COPY[refusal.reason] };
  return {
    kind: "answered",
    result: decodeRemoteServerGrantResult({
      kind: "remote-server-grant-refused",
      requestId: request.requestId,
      refusal: wire,
    }),
  };
}

const REFUSAL_COPY: Record<RemoteServerGrantRefusal["reason"], string> = {
  "local-principal": "A window on this computer opens the server directly.",
  "thread-unreadable": "This device can't open servers in that thread.",
  "not-found": "That server stopped or changed. Open it again from its list.",
  "not-octant-owned": "Octant didn't start this server, so it opens only on its own computer.",
  "not-in-thread": "This server isn't in a thread, so it opens only on its own computer.",
  "not-listening": "That server isn't answering, so there is nothing to open.",
  "open-denied": "This thread doesn't let that server open from another computer.",
  "grant-limit": "This device has as many servers open as it may. Try again once one closes.",
};
