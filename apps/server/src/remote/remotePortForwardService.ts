// A paired computer's half of a port forward (slice 10 of hub and spokes): one
// port on this computer's own loopback, reached as raw TCP by a device its own
// person paired, for an hour, through that device's proxy session. Each
// connection the device opens is a WebSocket carrying binary frames, bridged
// here to `127.0.0.1:<port>`. The forward is journaled opened and closed with
// the device and the port, never an address or what travels.

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
  REMOTE_PORT_FORWARDS_PER_DEVICE,
  REMOTE_PORT_FORWARDS_PER_HOST,
  REMOTE_SERVER_PROXY_RELAYED,
  REMOTE_SERVER_PROXY_RELAYED_HEADER,
  UtcTimestamp,
  decodeRemotePortForwardId,
  decodeRemotePortForwardOpenedPayload,
  decodeRemotePortForwardResult,
  type EventActor,
  type RemotePortForwardCloseReason,
  type RemotePortForwardId,
  type RemotePortForwardRequest,
  type RemotePortForwardResult,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
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

interface LiveForward {
  readonly forwardId: RemotePortForwardId;
  /** The journal's id for this forward's events; the forward id never enters the journal's keys. */
  readonly aggregateId: string;
  readonly deviceId: string;
  readonly sessionIdDigest: string;
  readonly port: number;
  readonly expiresAt: number;
  /** Ends every connection the forward carries. */
  readonly cut: AbortController;
  connections: number;
}

export type RemotePortForwardUpgrade =
  | { readonly kind: "upgraded"; readonly response: Response }
  | { readonly kind: "refused"; readonly reason: "forward-closed" | "busy" };

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
}

export class RemotePortForwardService {
  readonly #options: RemotePortForwardServiceOptions;
  readonly #forwards = new Map<string, LiveForward>();

  constructor(options: RemotePortForwardServiceOptions) {
    this.#options = options;
  }

  /**
   * Opens a forward for a device this computer's own person paired. Any other
   * device, and a device or host at its limit, is refused with a sentence.
   */
  open(input: {
    readonly deviceId: string;
    readonly actsAsHostPerson: boolean;
    readonly sessionIdDigest: string;
    readonly request: RemotePortForwardRequest;
  }): RemotePortForwardResult {
    this.sweep();
    const { request } = input;
    if (!input.actsAsHostPerson) {
      return decodeRemotePortForwardResult({
        kind: "remote-port-forward-refused",
        requestId: request.requestId,
        reason: "not-the-person",
        message: "Only a device this computer's own person paired can forward one of its ports.",
      });
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
      port: request.port,
      expiresAt: this.#options.now() + REMOTE_PORT_FORWARD_LIFETIME_MS,
      cut: new AbortController(),
      connections: 0,
    };
    this.#append(forward, REMOTE_PORT_FORWARD_OPENED, 0, deviceActor(input.deviceId), {
      forwardId,
      deviceId: input.deviceId,
      port: request.port,
    });
    this.#forwards.set(String(forwardId), forward);
    return decodeRemotePortForwardResult({
      kind: "remote-port-forward-opened",
      requestId: request.requestId,
      forward: { forwardId, port: request.port, expiresAt: forward.expiresAt },
    });
  }

  /**
   * Carries one connection of a forward the device holds under this proxy
   * session: the WebSocket the device asked for is bridged to the port on
   * this computer's loopback. Binary frames only; text closes it.
   */
  accept(input: {
    readonly deviceId: string;
    readonly sessionIdDigest: string;
    readonly forwardId: string;
  }): RemotePortForwardUpgrade {
    this.sweep();
    const forward = this.#forwards.get(input.forwardId);
    if (
      forward === undefined ||
      forward.deviceId !== input.deviceId ||
      forward.sessionIdDigest !== input.sessionIdDigest
    ) {
      return { kind: "refused", reason: "forward-closed" };
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
      const page = this.#options.journal.replayAggregateType({
        aggregateType: REMOTE_PORT_FORWARD_AGGREGATE,
        afterSequence,
        limit: 500,
        eventName: REMOTE_PORT_FORWARD_OPENED,
      });
      for (const event of page) {
        afterSequence = event.globalSequence;
        const aggregateId = String(event.aggregateId);
        if (!left.delete(aggregateId)) continue;
        const opened = decodeRemotePortForwardOpenedPayload(event.payload);
        if (this.#forwards.has(String(opened.forwardId))) continue;
        this.#append({ aggregateId }, REMOTE_PORT_FORWARD_CLOSED, 1, this.#options.hostActor, {
          ...opened,
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
    this.#append(forward, REMOTE_PORT_FORWARD_CLOSED, 1, this.#options.hostActor, {
      forwardId: forward.forwardId,
      deviceId: forward.deviceId,
      port: forward.port,
      reason,
    });
  }

  #append(
    forward: Pick<LiveForward, "aggregateId">,
    eventName: typeof REMOTE_PORT_FORWARD_OPENED | typeof REMOTE_PORT_FORWARD_CLOSED,
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

/** The device that asked is the actor of its forward's opening. */
function deviceActor(deviceId: string): EventActor {
  return {
    kind: "remote-device",
    actorId: decodeActorId(deviceId),
    deviceId: decodeEventActorDeviceId(deviceId),
  };
}
