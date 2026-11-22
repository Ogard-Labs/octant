// A paired computer's half of a port forward (slice 10 of hub and spokes): one
// port on this computer's own loopback, reached as raw TCP by a paired device
// for an hour, through that device's proxy session. A device its own person
// paired may name any port. A device only the hub introduced names a running
// server of a thread in a Project the member's Act item names, and both the
// Act item and that server's hold on the port are read again at every
// connection (maintainer decision, 2026-11-21). Each connection the device
// opens is a WebSocket carrying binary frames, bridged here to
// `127.0.0.1:<port>`. The forward is journaled opened and closed with the
// device and the port (and, for a thread's server, the thread and Project),
// never an address or what travels.

import { randomBytes as defaultRandomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActorDeviceId,
  EventId,
  EventName,
  REMOTE_PORT_FORWARD_CLOSED,
  REMOTE_PORT_FORWARD_CONNECTIONS,
  REMOTE_PORT_FORWARD_LIFETIME_MS,
  REMOTE_PORT_FORWARD_OPENED,
  REMOTE_PORT_FORWARD_OPENED_V2,
  REMOTE_PORT_FORWARDS_PER_DEVICE,
  REMOTE_PORT_FORWARDS_PER_HOST,
  REMOTE_SERVER_PROXY_RELAYED,
  REMOTE_SERVER_PROXY_RELAYED_HEADER,
  UtcTimestamp,
  decodeRemotePortForwardId,
  decodeRemotePortForwardOpenedPayload,
  decodeRemotePortForwardOpenedPayloadV2,
  decodeRemotePortForwardResult,
  type CodeThreadId,
  type EventActor,
  type RemotePortForwardCloseReason,
  type RemotePortForwardId,
  type RemotePortForwardRequest,
  type RemotePortForwardResult,
  type RemoteServerGrantSource,
} from "@octant/contracts";
import { Schema } from "effect";
import { hubActRefusal, type HubActScopePort } from "../hub/hubActScope";
import type { Journal } from "../persistence/journal";
import type { RemoteThreadServerObservation } from "./remoteServerGrantService";
import {
  acceptWebSocketUpgrade,
  type WebSocketPeer,
  type WebSocketPeerEvents,
} from "../webSocketRelay";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeEventActorDeviceId = Schema.decodeUnknownSync(EventActorDeviceId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export const REMOTE_PORT_FORWARD_AGGREGATE = "remote-port-forward";
/** Bytes a connection may hold unsent toward the port before it is ended. */
export const FORWARD_WRITE_BUDGET_BYTES = 8 * 1024 * 1024;

/**
 * Who asks for a forward, read from this computer's own record of the device
 * and session: a device its person paired, a device only the hub introduced
 * (any other device session that is no agent grant's), or an agent grant.
 */
export type RemotePortForwardAsker = "host-person" | "hub-introduced" | "agent-grant";

/**
 * Re-observes a thread's listed server under the asking device's own scope,
 * as a grant request is observed. The route binds it to the request.
 */
export type ObserveForwardedServer = (
  source: RemoteServerGrantSource,
  signal?: AbortSignal,
) => Promise<RemoteThreadServerObservation>;

interface LiveForward {
  readonly forwardId: RemotePortForwardId;
  /** The journal's id for this forward's events; the forward id never enters the journal's keys. */
  readonly aggregateId: string;
  readonly deviceId: string;
  readonly sessionIdDigest: string;
  readonly port: number;
  readonly expiresAt: number;
  readonly asker: Exclude<RemotePortForwardAsker, "agent-grant">;
  /** The thread's listed server the port was taken from; absent for a port the person picked. */
  readonly server?: {
    readonly source: RemoteServerGrantSource;
    readonly threadId: CodeThreadId;
    readonly projectId: string;
  };
  /** Ends every connection the forward carries. */
  readonly cut: AbortController;
  connections: number;
}

export type RemotePortForwardUpgrade =
  | { readonly kind: "upgraded"; readonly response: Response }
  | { readonly kind: "refused"; readonly reason: "forward-closed" | "busy" | "unavailable" };

type ForwardRefusal = Extract<
  RemotePortForwardResult,
  { readonly kind: "remote-port-forward-refused" }
>["reason"];

export interface RemotePortForwardServiceOptions {
  readonly journal: Pick<Journal, "append" | "aggregateVersions" | "replayAggregateType">;
  /** Who the journal names for a forward the host itself closes. */
  readonly hostActor: EventActor;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly now: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  /** Opens a TCP connection to this computer's loopback; tests stand one in. */
  readonly connect?: (port: number) => Socket;
  /**
   * The member's Act item for its hub, read at each open and connection. While
   * none is bound, a device the hub introduced forwards nothing.
   */
  readonly hubActScope?: () => HubActScopePort | undefined;
  /** A Code thread's Project from this computer's own record; undefined for one it does not hold. */
  readonly threadProjectId?: (threadId: CodeThreadId) => string | undefined;
}

export class RemotePortForwardService {
  readonly #options: RemotePortForwardServiceOptions;
  readonly #forwards = new Map<string, LiveForward>();

  constructor(options: RemotePortForwardServiceOptions) {
    this.#options = options;
  }

  /**
   * Opens a forward. A device this computer's own person paired may name any
   * port, or a thread's listed server. A device only the hub introduced must
   * name a thread's listed server, in a Project the member's Act item names,
   * and the port is the one the host sees that server hold. An agent grant,
   * every other case, and a device or host at its limit are refused with a
   * sentence.
   */
  async open(input: {
    readonly deviceId: string;
    readonly asker: RemotePortForwardAsker;
    readonly sessionIdDigest: string;
    readonly request: RemotePortForwardRequest;
    readonly observeServer?: ObserveForwardedServer;
    /** Asked after the server is observed: whether the proxy session still stands. */
    readonly stillAuthorized?: () => boolean;
    readonly signal?: AbortSignal;
  }): Promise<RemotePortForwardResult> {
    this.sweep();
    const { request } = input;
    const refused = (reason: ForwardRefusal, message: string) =>
      decodeRemotePortForwardResult({
        kind: "remote-port-forward-refused",
        requestId: request.requestId,
        reason,
        message,
      });
    const asker = input.asker;
    if (asker === "agent-grant") {
      return refused("not-the-person", "An agent grant cannot forward this computer's ports.");
    }
    let port: number;
    let server: LiveForward["server"];
    if ("source" in request) {
      const resolved = await this.#resolveServer(asker, request.source, input);
      if (resolved.kind === "refused") return refused(resolved.reason, resolved.message);
      port = resolved.port;
      server = {
        source: request.source,
        threadId: resolved.threadId,
        projectId: resolved.projectId,
      };
    } else if (asker === "hub-introduced") {
      return refused(
        "source-required",
        "A device the hub introduced can forward only a running server of a thread, not a port it names.",
      );
    } else {
      port = request.port;
    }
    // Nothing awaits from here to the forward existing, so a session that ends
    // after this check closes the forward with it.
    if (input.stillAuthorized !== undefined && !input.stillAuthorized()) {
      return refused("unavailable", SERVER_REFUSAL_COPY.unavailable);
    }
    const forwards = [...this.#forwards.values()];
    if (
      forwards.filter((forward) => forward.deviceId === input.deviceId).length >=
        REMOTE_PORT_FORWARDS_PER_DEVICE ||
      forwards.length >= REMOTE_PORT_FORWARDS_PER_HOST
    ) {
      return decodeRemotePortForwardResult({
        kind: "remote-port-forward-refused",
        requestId: request.requestId,
        reason: "forward-limit",
        message: "Too many ports are forwarded from this computer. Stop one and try again.",
      });
    }
    const random = (this.#options.randomBytes ?? defaultRandomBytes)(32);
    const forwardId = decodeRemotePortForwardId(`rpf_${Buffer.from(random).toString("hex")}`);
    const forward: LiveForward = {
      forwardId,
      aggregateId: this.#options.uuid(),
      deviceId: input.deviceId,
      sessionIdDigest: input.sessionIdDigest,
      port,
      expiresAt: this.#options.now() + REMOTE_PORT_FORWARD_LIFETIME_MS,
      asker,
      ...(server === undefined ? {} : { server }),
      cut: new AbortController(),
      connections: 0,
    };
    if (server === undefined) {
      this.#append(forward, REMOTE_PORT_FORWARD_OPENED, 0, deviceActor(input.deviceId), {
        forwardId,
        deviceId: input.deviceId,
        port,
      });
    } else {
      this.#append(forward, REMOTE_PORT_FORWARD_OPENED_V2, 0, deviceActor(input.deviceId), {
        forwardId,
        deviceId: input.deviceId,
        port,
        threadId: server.threadId,
        projectId: server.projectId,
      });
    }
    this.#forwards.set(String(forwardId), forward);
    return decodeRemotePortForwardResult({
      kind: "remote-port-forward-opened",
      requestId: request.requestId,
      forward: { forwardId, port, expiresAt: forward.expiresAt },
    });
  }

  /**
   * The port of the thread's listed server a forward names, with the thread
   * and its Project from this computer's own record, or why it is refused.
   */
  async #resolveServer(
    asker: Exclude<RemotePortForwardAsker, "agent-grant">,
    source: RemoteServerGrantSource,
    input: { readonly observeServer?: ObserveForwardedServer; readonly signal?: AbortSignal },
  ): Promise<
    | {
        readonly kind: "resolved";
        readonly port: number;
        readonly threadId: CodeThreadId;
        readonly projectId: string;
      }
    | { readonly kind: "refused"; readonly reason: ForwardRefusal; readonly message: string }
  > {
    // The Act item before the listing for a named thread: a device the item
    // does not cover there learns nothing about which servers run in it.
    if (asker === "hub-introduced" && source.surface === "local-servers") {
      const refusal = this.#actRefusal(this.#options.threadProjectId?.(source.threadId));
      if (refusal !== undefined)
        return { kind: "refused", reason: "outside-act", message: refusal };
    }
    if (input.observeServer === undefined) {
      return { kind: "refused", reason: "unavailable", message: SERVER_REFUSAL_COPY.unavailable };
    }
    const observed = await input.observeServer(source, input.signal);
    if (observed.kind === "unavailable") {
      return { kind: "refused", reason: "unavailable", message: SERVER_REFUSAL_COPY.unavailable };
    }
    if (observed.kind === "refused") {
      // A local principal never reaches the proxy route; it is refused as no person's device.
      const reason = observed.reason === "local-principal" ? "not-the-person" : observed.reason;
      return { kind: "refused", reason, message: SERVER_REFUSAL_COPY[reason] };
    }
    const projectId = this.#options.threadProjectId?.(observed.threadId);
    if (projectId === undefined) {
      return {
        kind: "refused",
        reason: "thread-unreadable",
        message: SERVER_REFUSAL_COPY["thread-unreadable"],
      };
    }
    if (asker === "hub-introduced") {
      const refusal = this.#actRefusal(projectId);
      if (refusal !== undefined)
        return { kind: "refused", reason: "outside-act", message: refusal };
    }
    return { kind: "resolved", port: observed.port, threadId: observed.threadId, projectId };
  }

  /**
   * The sentence refusing a device the hub introduced in a Project, or
   * undefined when Act allows it. A computer in no hub keeps its own rule for
   * such a device, which forwards nothing, so no hub refuses too.
   */
  #actRefusal(projectId: string | undefined): string | undefined {
    const scope = this.#options.hubActScope?.();
    const decision = scope?.decide(projectId ?? "");
    if (decision === undefined || decision.status === "not-in-a-hub") {
      return "This computer is in no hub, so a device the hub introduced cannot forward ports here.";
    }
    return hubActRefusal(scope, projectId, "forward");
  }

  /**
   * Whether a forward of a thread's server may carry one more connection: the
   * Act item still names the thread's Project for a device the hub
   * introduced, and the thread's server still holds the forwarded port. A
   * forward that fails either is closed, with the reason journaled.
   */
  async #confirmServer(
    forward: LiveForward,
    server: NonNullable<LiveForward["server"]>,
    input: { readonly observeServer?: ObserveForwardedServer; readonly signal?: AbortSignal },
  ): Promise<"held" | "closed" | "unavailable"> {
    const actHolds = () =>
      forward.asker !== "hub-introduced" ||
      this.#actRefusal(this.#options.threadProjectId?.(server.threadId)) === undefined;
    if (!actHolds()) {
      this.#close(forward, "outside-act");
      return "closed";
    }
    if (input.observeServer === undefined) return "unavailable";
    const observed = await input.observeServer(server.source, input.signal);
    if (this.#forwards.get(String(forward.forwardId)) !== forward) return "closed";
    if (observed.kind === "unavailable") return "unavailable";
    if (
      observed.kind === "refused" ||
      String(observed.threadId) !== String(server.threadId) ||
      observed.port !== forward.port
    ) {
      this.#close(forward, "server-gone");
      return "closed";
    }
    // The item is read again after the look, which may have taken a while.
    if (!actHolds()) {
      this.#close(forward, "outside-act");
      return "closed";
    }
    return "held";
  }

  /**
   * Carries one connection of a forward the device holds under this proxy
   * session: the WebSocket the device asked for is bridged to the port on
   * this computer's loopback. Binary frames only; text closes it. A forward of
   * a thread's server is confirmed first, and closed if it no longer holds.
   */
  async accept(input: {
    readonly deviceId: string;
    readonly sessionIdDigest: string;
    readonly forwardId: string;
    readonly observeServer?: ObserveForwardedServer;
    readonly signal?: AbortSignal;
  }): Promise<RemotePortForwardUpgrade> {
    this.sweep();
    const forward = this.#forwards.get(input.forwardId);
    if (
      forward === undefined ||
      forward.deviceId !== input.deviceId ||
      forward.sessionIdDigest !== input.sessionIdDigest
    ) {
      return { kind: "refused", reason: "forward-closed" };
    }
    if (forward.server !== undefined) {
      const confirmed = await this.#confirmServer(forward, forward.server, input);
      if (confirmed === "unavailable") return { kind: "refused", reason: "unavailable" };
      if (confirmed === "closed") return { kind: "refused", reason: "forward-closed" };
    }
    if (forward.connections >= REMOTE_PORT_FORWARD_CONNECTIONS) {
      return { kind: "refused", reason: "busy" };
    }
    forward.connections += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      forward.connections -= 1;
    };
    const response = acceptWebSocketUpgrade(
      {
        protocol: undefined,
        cancel: release,
        open: (client: WebSocketPeer): WebSocketPeerEvents => {
          if (forward.cut.signal.aborted) {
            release();
            client.close(1008, "This forward ended.");
            return { message: () => undefined, closed: () => undefined };
          }
          const tcp = (
            this.#options.connect ?? ((port) => netConnect({ host: "127.0.0.1", port }))
          )(forward.port);
          const end = (code: number, reason: string) => {
            forward.cut.signal.removeEventListener("abort", onCut);
            tcp.destroy();
            client.close(code, reason);
            release();
          };
          const onCut = () => end(1008, "This forward ended.");
          forward.cut.signal.addEventListener("abort", onCut, { once: true });
          tcp.on("data", (chunk: Buffer) => client.send({ text: false, data: chunk }));
          tcp.on("end", () => end(1000, ""));
          tcp.on("error", () => end(1011, "The port on that computer did not answer."));
          return {
            message: (message) => {
              if (message.text) {
                end(1003, "A forward carries bytes, not text.");
                return;
              }
              tcp.write(message.data);
              // The WebSocket keeps delivering while the port reads slowly, and
              // a socket queues every write it cannot send, so a service that
              // stops reading would otherwise grow this host's memory without
              // bound. Past the budget the connection ends.
              if (tcp.writableLength > FORWARD_WRITE_BUDGET_BYTES) {
                end(1009, "The port on that computer is not reading.");
              }
            },
            closed: () => {
              forward.cut.signal.removeEventListener("abort", onCut);
              tcp.end();
              release();
            },
          };
        },
      },
      { [REMOTE_SERVER_PROXY_RELAYED_HEADER]: REMOTE_SERVER_PROXY_RELAYED },
    );
    return { kind: "upgraded", response };
  }

  /** Ends the forwards past their hour. */
  sweep(): void {
    const now = this.#options.now();
    for (const forward of [...this.#forwards.values()]) {
      if (forward.expiresAt <= now) this.#close(forward, "expired");
    }
  }

  /**
   * Whether a forward of this proxy session carries a connection now. A
   * connection counts as use of its session, as a relayed socket does, so a
   * long-lived database connection does not end when the session would idle.
   */
  holdsOpenConnections(sessionIdDigest: string): boolean {
    for (const forward of this.#forwards.values()) {
      if (forward.sessionIdDigest === sessionIdDigest && forward.connections > 0) return true;
    }
    return false;
  }

  closeSession(sessionIdDigest: string): void {
    for (const forward of [...this.#forwards.values()]) {
      if (forward.sessionIdDigest === sessionIdDigest) this.#close(forward, "proxy-session-ended");
    }
  }

  closeDevice(deviceId: string): void {
    for (const forward of [...this.#forwards.values()]) {
      if (forward.deviceId === deviceId) this.#close(forward, "device-revoked");
    }
  }

  closeAll(): void {
    for (const forward of [...this.#forwards.values()]) this.#close(forward, "host-stopped");
  }

  /**
   * Forwards live only in this host's memory, so a forward the journal still
   * shows open was left by a run that stopped without closing it. A starting
   * host records each one closed, so the journal never shows a forward open
   * that nothing can reach. An open forward's aggregate is at version 1.
   */
  closeLeftOpen(): void {
    const left = new Set(
      this.#options.journal
        .aggregateVersions(REMOTE_PORT_FORWARD_AGGREGATE)
        .filter((head) => head.aggregateVersion === 1)
        .map((head) => head.aggregateId),
    );
    let afterSequence = 0;
    while (left.size > 0) {
      // Both versions of the opening: every event of a forward but its closing.
      const page = this.#options.journal.replayAggregateType({
        aggregateType: REMOTE_PORT_FORWARD_AGGREGATE,
        afterSequence,
        limit: 500,
        exceptEventName: REMOTE_PORT_FORWARD_CLOSED,
      });
      for (const event of page) {
        afterSequence = event.globalSequence;
        const aggregateId = String(event.aggregateId);
        if (!left.delete(aggregateId)) continue;
        const opened =
          String(event.eventName) === REMOTE_PORT_FORWARD_OPENED_V2
            ? decodeRemotePortForwardOpenedPayloadV2(event.payload)
            : decodeRemotePortForwardOpenedPayload(event.payload);
        if (this.#forwards.has(String(opened.forwardId))) continue;
        this.#append({ aggregateId }, REMOTE_PORT_FORWARD_CLOSED, 1, this.#options.hostActor, {
          forwardId: opened.forwardId,
          deviceId: opened.deviceId,
          port: opened.port,
          reason: "host-stopped",
        });
      }
      if (page.length < 500) return;
    }
  }

  openCount(deviceId?: string): number {
    return [...this.#forwards.values()].filter(
      (forward) => deviceId === undefined || forward.deviceId === deviceId,
    ).length;
  }

  #close(forward: LiveForward, reason: RemotePortForwardCloseReason): void {
    if (!this.#forwards.delete(String(forward.forwardId))) return;
    forward.cut.abort();
    // The forward is already cut; a journal that cannot take the closing
    // event (a full disk) must not stop the other forwards of a revoked
    // device or session from closing, nor escape the expiry timer and end
    // the host. The journal then still shows it open, and the next start's
    // `closeLeftOpen` records it closed.
    try {
      this.#append(forward, REMOTE_PORT_FORWARD_CLOSED, 1, this.#options.hostActor, {
        forwardId: forward.forwardId,
        deviceId: forward.deviceId,
        port: forward.port,
        reason,
      });
    } catch {
      // Reconciled at the next start, as above.
    }
  }

  #append(
    forward: Pick<LiveForward, "aggregateId">,
    eventName:
      | typeof REMOTE_PORT_FORWARD_OPENED
      | typeof REMOTE_PORT_FORWARD_OPENED_V2
      | typeof REMOTE_PORT_FORWARD_CLOSED,
    expectedVersion: number,
    actor: EventActor,
    payload: unknown,
  ): void {
    this.#options.journal.append({
      aggregate: {
        aggregateType: REMOTE_PORT_FORWARD_AGGREGATE,
        aggregateId: decodeAggregateId(forward.aggregateId),
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
          payload,
        },
      ],
    });
  }
}

/** Why a named server cannot be forwarded, in the words the forwarding row shows. */
const SERVER_REFUSAL_COPY: Readonly<
  Record<Exclude<ForwardRefusal, "source-required" | "outside-act" | "forward-limit">, string>
> = {
  "not-the-person": "Only a device this computer's own person paired can forward its ports.",
  "thread-unreadable": "This device can't forward servers in that thread.",
  "not-found": "That server stopped or changed. Forward it again from its list.",
  "not-octant-owned": "Octant didn't start this server, so its port stays on its own computer.",
  "not-in-thread": "This server isn't in a thread, so its port stays on its own computer.",
  "not-listening": "That server isn't answering, so there is nothing to forward.",
  "open-denied": "This thread doesn't let that server leave its own computer.",
  unavailable: "Octant could not check that server on its computer. Try again.",
};

/** The device that asked is the actor of its forward's opening. */
function deviceActor(deviceId: string): EventActor {
  return {
    kind: "remote-device",
    actorId: decodeActorId(deviceId),
    deviceId: decodeEventActorDeviceId(deviceId),
  };
}
