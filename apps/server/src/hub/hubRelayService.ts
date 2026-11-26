// The device relay on the acting hub (decision H36). A device opens a
// WebSocket on the public entrance, signs the hub's challenge with the device
// key it paired with, and names one host. The hub admits it only when that
// host listed the key's fingerprint, then opens a tunnel to the host over the
// pinned private transport and carries the bytes both ways. The bytes are the
// device's own TLS to the host's listener: the hub reads none of them and
// learns only which device reached which host, when, and how much.

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  HubMemberId,
  PUBLIC_ENTRANCE_MAX_RELAY_TUNNELS,
  RELAY_OPENED_MESSAGE,
  RELAY_REFUSED_CLOSE_CODE,
  RELAY_UNAVAILABLE_CLOSE_CODE,
  decodeRelayAdmission,
  relayAdmissionPayload,
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type HubRelayDevicesUpdate,
  type RelayAdmission,
} from "@octant/contracts";
import { Schema } from "effect";
import {
  WebSocketEndpoint,
  isWebSocketKey,
  webSocketAcceptFor,
  type WebSocketMessage,
} from "../webSocketRelay";
import { publicKeyFingerprint, verifySignature } from "./hubCrypto";
import type { HubRelayHubState, HubStatePort } from "./hubStateStore";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
/** One relayed message is one TLS record or a few; far above that is not a device. */
export const RELAY_MAX_MESSAGE_BYTES = 1024 * 1024;
const ADMISSION_TIMEOUT_MS = 10_000;

/** The far end of one tunnel, on the host the device asked for, not yet reading. */
export interface RelayTunnelEnd {
  readonly endpoint: WebSocketEndpoint;
  readonly head: Buffer;
}

export interface HubRelayServiceOptions {
  readonly state: HubStatePort;
  /** Whether this host serves the entrance as the acting hub. */
  readonly serving: () => boolean;
  readonly hubMemberId: () => string;
  /**
   * The member ids of the roster this host serves from. A host the roster no
   * longer lists keeps no relay: its device keys are forgotten and its open
   * tunnels end, since it can no longer withdraw them itself.
   */
  readonly members?: () => ReadonlyArray<string> | undefined;
  /** Opens the tunnel on the host; undefined when it cannot be reached or refused it. */
  readonly openTunnel: (
    targetMemberId: string,
    deviceFingerprint: string,
  ) => Promise<RelayTunnelEnd | undefined>;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly maxTunnels?: number;
  readonly admissionTimeoutMs?: number;
}

export interface HubRelayStatus {
  readonly enabled: boolean;
  readonly hosts: number;
  readonly tunnels: number;
}

const EMPTY: HubRelayHubState = { enabled: false, hosts: [] };

function refuseUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
}

export class HubRelayService {
  readonly #options: HubRelayServiceOptions;
  /** Every open device end: admitting or carrying. Closed together when the relay stops. */
  readonly #open = new Map<
    WebSocketEndpoint,
    {
      readonly end: (code: number, reason: string) => void;
      /** Set once admitted: whose list let it through, so withdrawing that key ends it. */
      carries?: { readonly target: string; readonly fingerprint: string };
    }
  >();
  #tunnels = 0;

  constructor(options: HubRelayServiceOptions) {
    this.#options = options;
  }

  status(): HubRelayStatus {
    const held = this.#load();
    return { enabled: held.enabled, hosts: held.hosts.length, tunnels: this.#tunnels };
  }

  setEnabled(
    enabled: boolean,
    principal: AuditActingPrincipal,
  ): { readonly status: "changed"; readonly enabled: boolean } {
    this.#save({ ...this.#load(), enabled });
    this.#options.record({ change: "relay-switch-changed", actingPrincipal: principal });
    if (!enabled) this.closeAll();
    return { status: "changed", enabled };
  }

  /** Ends every relay at once: the switch went off, or remote access paused. */
  closeAll(): void {
    for (const open of this.#open.values()) open.end(1001, "relay closed");
  }

  /**
   * Ends what should no longer carry: everything when the switch is off or
   * this host stopped acting as hub, and each tunnel whose device key its
   * host has withdrawn. Withdrawing permission ends a tunnel already open,
   * not only the next one.
   */
  sweep(): void {
    // A host the roster dropped is forgotten even while the relay is off, so
    // turning it back on never finds its keys.
    const listed = this.#options.members?.();
    if (listed !== undefined) {
      const members = new Set(listed);
      const held = this.#load();
      const kept = held.hosts.filter((host) => members.has(String(host.memberId)));
      if (kept.length !== held.hosts.length) this.#save({ ...held, hosts: kept });
    }
    if (!this.#load().enabled || !this.#options.serving()) {
      this.closeAll();
      return;
    }
    for (const open of this.#open.values()) {
      if (
        open.carries !== undefined &&
        !this.#listed(open.carries.target, open.carries.fingerprint)
      ) {
        open.end(1001, "relay withdrawn");
      }
    }
  }

  /** Replaces the device keys one host lets through; an empty list withdraws them. */
  receiveDevices(
    memberId: string,
    update: HubRelayDevicesUpdate,
  ): { readonly status: "recorded"; readonly count: number } {
    const held = this.#load();
    const others = held.hosts.filter((host) => String(host.memberId) !== memberId);
    this.#save({
      ...held,
      hosts:
        update.fingerprints.length === 0
          ? others
          : [...others, { memberId: decodeMemberId(memberId), fingerprints: update.fingerprints }],
    });
    this.#options.record({
      change: "relay-devices-received",
      actingPrincipal: { kind: "peer", memberId: decodeMemberId(memberId) },
      memberId: decodeMemberId(memberId),
    });
    this.sweep();
    return { status: "recorded", count: update.fingerprints.length };
  }

  /** The entrance's relay route; absent while the switch is off or this host is not the acting hub. */
  handler(): ((request: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined {
    if (!this.#load().enabled || !this.#options.serving()) return undefined;
    return (request, socket, head) => this.#upgrade(request, socket, head);
  }

  #listed(targetMemberId: string, fingerprint: string): boolean {
    const members = this.#options.members?.();
    if (members !== undefined && !members.includes(targetMemberId)) return false;
    return this.#load().hosts.some(
      (host) => String(host.memberId) === targetMemberId && host.fingerprints.includes(fingerprint),
    );
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => undefined);
    const key = request.headers["sec-websocket-key"];
    if (
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      !isWebSocketKey(key) ||
      request.headers["sec-websocket-version"] !== "13"
    ) {
      refuseUpgrade(socket, "400 Bad Request");
      return;
    }
    if (this.#tunnels >= (this.#options.maxTunnels ?? PUBLIC_ENTRANCE_MAX_RELAY_TUNNELS)) {
      refuseUpgrade(socket, "503 Service Unavailable");
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${webSocketAcceptFor(key)}`,
        "",
        "",
      ].join("\r\n"),
    );
    const transport = socket as Duplex & {
      setTimeout(timeout: number): unknown;
      setNoDelay(noDelay?: boolean): unknown;
    };
    if (typeof transport.setTimeout !== "function") {
      socket.destroy();
      return;
    }
    const device = new WebSocketEndpoint(transport, "server", RELAY_MAX_MESSAGE_BYTES);
    const challenge = randomBytes(32).toString("base64url");
    const hubMemberId = this.#options.hubMemberId();
    let phase: "admitting" | "opening" | "carrying" | "ended" = "admitting";
    let host: WebSocketEndpoint | undefined;
    let counted = false;
    const end = (code: number, reason: string) => {
      if (phase === "ended") return;
      phase = "ended";
      clearTimeout(timer);
      this.#open.delete(device);
      if (counted) this.#tunnels -= 1;
      counted = false;
      device.close(code, reason);
      host?.close(1000, "");
    };
    const open: { end: typeof end; carries?: { target: string; fingerprint: string } } = { end };
    this.#open.set(device, open);
    const timer = setTimeout(
      () => end(RELAY_REFUSED_CLOSE_CODE, "refused"),
      this.#options.admissionTimeoutMs ?? ADMISSION_TIMEOUT_MS,
    );
    timer.unref?.();
    device.start(
      {
        message: (message) => {
          if (phase === "carrying") {
            if (!message.text) host?.send(message);
            return;
          }
          if (phase !== "admitting") return;
          phase = "opening";
          void this.#admit(message, challenge, hubMemberId).then(async (admitted) => {
            if (phase !== "opening") return;
            if (admitted === undefined) {
              end(RELAY_REFUSED_CLOSE_CODE, "refused");
              return;
            }
            if (this.#tunnels >= (this.#options.maxTunnels ?? PUBLIC_ENTRANCE_MAX_RELAY_TUNNELS)) {
              end(RELAY_UNAVAILABLE_CLOSE_CODE, "busy");
              return;
            }
            this.#tunnels += 1;
            counted = true;
            open.carries = {
              target: String(admitted.targetMemberId),
              fingerprint: admitted.fingerprint,
            };
            const far = await this.#options
              .openTunnel(String(admitted.targetMemberId), admitted.fingerprint)
              .catch(() => undefined);
            if (far === undefined || phase !== "opening") {
              far?.endpoint.close(1000, "");
              end(RELAY_UNAVAILABLE_CLOSE_CODE, "unavailable");
              return;
            }
            host = far.endpoint;
            clearTimeout(timer);
            phase = "carrying";
            far.endpoint.start(
              {
                message: (inner: WebSocketMessage) => {
                  if (!inner.text) device.send(inner);
                },
                closed: () => end(1000, ""),
              },
              far.head,
            );
            device.send({ text: true, data: Buffer.from(RELAY_OPENED_MESSAGE) });
          });
        },
        closed: () => end(1000, ""),
      },
      head,
    );
    device.send({
      text: true,
      data: Buffer.from(JSON.stringify({ challenge, hubMemberId })),
    });
  }

  /** The device's answer, if it names a host that listed this key and the key signed the challenge. */
  async #admit(
    message: WebSocketMessage,
    challenge: string,
    hubMemberId: string,
  ): Promise<(RelayAdmission & { readonly fingerprint: string }) | undefined> {
    if (!message.text) return undefined;
    let admission: RelayAdmission;
    try {
      admission = decodeRelayAdmission(JSON.parse(Buffer.from(message.data).toString("utf8")));
    } catch {
      return undefined;
    }
    const fingerprint = publicKeyFingerprint(admission.deviceSpki);
    if (!this.#listed(String(admission.targetMemberId), fingerprint)) return undefined;
    const signed = verifySignature({
      payload: relayAdmissionPayload({
        challenge,
        targetMemberId: String(admission.targetMemberId),
        hubMemberId,
      }),
      signature: admission.signature,
      publicKey: admission.deviceSpki,
    });
    return signed ? { ...admission, fingerprint } : undefined;
  }

  #load(): HubRelayHubState {
    return this.#options.state.load().relayHub ?? EMPTY;
  }

  #save(relayHub: HubRelayHubState): void {
    this.#options.state.save({ ...this.#options.state.load(), relayHub });
  }
}
