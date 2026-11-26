// The device relay on the host a device paired with (decision H36). The host's
// own person names which paired devices may come through the hub; the host
// tells the hub only those devices' key fingerprints, and only while its
// person ticked Relay. When the hub opens a tunnel, the host checks again that
// the device is listed, still active, and that remote access is not paused,
// then serves the tunnel's bytes as its own listener: the device's TLS ends
// here, never on the hub.

import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type {
  AuditActingPrincipal,
  HubMembershipChangedPayload,
  HubRelayDevicesUpdate,
} from "@octant/contracts";
import { classifyRemoteSourceClass, normalizePeerAddress } from "../remoteRequestFacts";
import type { RequestTransportFacts } from "../server";
import { acceptWebSocketUpgrade } from "../webSocketRelay";
import { webSocketByteStream } from "../relayedConnection";
import type { HubStatePort, SpokeRelayState } from "./hubStateStore";

export interface RelayDevice {
  readonly deviceId: string;
  readonly fingerprint: string;
  readonly active: boolean;
}

export interface SpokeRelayHubPort {
  /** Sends the hub this host's list; false when it was not taken. */
  readonly sendDevices: (update: HubRelayDevicesUpdate) => Promise<boolean>;
}

export interface SpokeRelayServiceOptions {
  readonly state: HubStatePort;
  /** Whether this host's person ticked Relay in its hub grant. */
  readonly relayGranted: () => boolean;
  readonly hub: SpokeRelayHubPort;
  /** This host's paired devices, as its device registry holds them now. */
  readonly devices: () => ReadonlyArray<RelayDevice>;
  readonly paused: () => boolean;
  /** Serves one relayed byte stream as this host's listener; false while it is not ready. */
  readonly serve: (socket: Duplex, facts: RequestTransportFacts) => boolean;
  readonly record: (change: HubMembershipChangedPayload) => void;
}

export type RelayAllowOutcome =
  | { readonly status: "changed"; readonly allowed: boolean }
  | { readonly status: "refused"; readonly kind: "unknown-device" };

export type RelayTunnelRefusal =
  | "relay-not-granted"
  | "remote-access-paused"
  | "device-not-listed"
  | "not-private"
  | "busy";

// The hub caps tunnels too; this host does not rely on it, since each tunnel
// here is its own TLS server.
const TUNNELS_MAX = 32;

const EMPTY: SpokeRelayState = { deviceIds: [] };

export class SpokeRelayService {
  readonly #options: SpokeRelayServiceOptions;
  /** What the hub last took, so a look sends again only when it changed. */
  #lastSent: string | undefined;
  /** Each open relayed stream, by the device key it carries. */
  readonly #streams = new Map<string, Set<Duplex>>();

  constructor(options: SpokeRelayServiceOptions) {
    this.#options = options;
  }

  view(): ReadonlyArray<{ readonly deviceId: string; readonly allowed: boolean }> {
    const allowed = new Set(this.#load().deviceIds);
    return this.#options
      .devices()
      .filter((device) => device.active)
      .map((device) => ({ deviceId: device.deviceId, allowed: allowed.has(device.deviceId) }));
  }

  async allow(
    deviceId: string,
    allowed: boolean,
    principal: AuditActingPrincipal,
  ): Promise<RelayAllowOutcome> {
    const known = this.#options
      .devices()
      .some((device) => device.deviceId === deviceId && device.active);
    if (allowed && !known) return { status: "refused", kind: "unknown-device" };
    const held = this.#load();
    const others = held.deviceIds.filter((id) => id !== deviceId);
    this.#save({ ...held, deviceIds: allowed ? [...others, deviceId] : others });
    this.#options.record({ change: "relay-device-changed", actingPrincipal: principal });
    this.sweep();
    await this.publish();
    return { status: "changed", allowed };
  }

  /** A device lost its standing here: it leaves the list at once, and the hub is told. */
  async deviceRemoved(deviceId: string): Promise<void> {
    const held = this.#load();
    if (held.deviceIds.includes(deviceId)) {
      this.#save({ ...held, deviceIds: held.deviceIds.filter((id) => id !== deviceId) });
    }
    this.sweep();
    await this.publish();
  }

  /**
   * Ends each open relayed stream whose device may no longer come through:
   * Relay unticked, the device forgotten or unlisted, or remote access paused.
   */
  sweep(): void {
    const allowed = this.#options.paused() ? new Set<string>() : new Set(this.#fingerprints());
    for (const [fingerprint, streams] of this.#streams) {
      if (allowed.has(fingerprint)) continue;
      for (const stream of streams) stream.destroy();
      this.#streams.delete(fingerprint);
    }
  }

  /** The fingerprints the hub may admit: listed, active, and only while Relay is ticked. */
  #fingerprints(): ReadonlyArray<string> {
    if (!this.#options.relayGranted()) return [];
    const allowed = new Set(this.#load().deviceIds);
    return this.#options
      .devices()
      .filter((device) => device.active && allowed.has(device.deviceId))
      .map((device) => device.fingerprint)
      .sort();
  }

  /**
   * What was last sent, and to which hub: a spoke that follows a promoted hub
   * keeps its devices, but the new hub has never heard of them.
   */
  #sendKey(fingerprints: ReadonlyArray<string>): string {
    const link = this.#options.state.load().link;
    const hub = link === undefined ? "" : `${String(link.hubMemberId)}@${link.hubOrigin}`;
    return `${hub}#${fingerprints.join(",")}`;
  }

  async publish(): Promise<void> {
    const fingerprints = this.#fingerprints();
    const key = this.#sendKey(fingerprints);
    const sent = await this.#options.hub.sendDevices({ fingerprints });
    const held = this.#load();
    if (sent) {
      this.#lastSent = key;
      if (held.unpublished === true) this.#save({ deviceIds: held.deviceIds });
    } else if (held.unpublished !== true) {
      this.#save({ ...held, unpublished: true });
    }
  }

  /** Sends again when the hub has not taken the list, or the grant or the devices changed. */
  async look(): Promise<void> {
    this.sweep();
    const held = this.#load();
    const current = this.#sendKey(this.#fingerprints());
    if (held.unpublished !== true && current === this.#lastSent) return;
    await this.publish();
  }

  /**
   * The hub, already authenticated, asks to open one device's tunnel. Every
   * check is this host's own; the hub's list is never trusted for it.
   */
  openTunnel(input: {
    readonly deviceFingerprint: string;
    readonly hubAddress: string | undefined;
  }):
    | { readonly status: "accepted"; readonly response: Response }
    | {
        readonly status: "refused";
        readonly kind: RelayTunnelRefusal;
      } {
    if (!this.#options.relayGranted()) return { status: "refused", kind: "relay-not-granted" };
    if (this.#options.paused()) return { status: "refused", kind: "remote-access-paused" };
    if (!this.#fingerprints().includes(input.deviceFingerprint)) {
      return { status: "refused", kind: "device-not-listed" };
    }
    let open = 0;
    for (const streams of this.#streams.values()) open += streams.size;
    if (open >= TUNNELS_MAX) return { status: "refused", kind: "busy" };
    const address = normalizePeerAddress(input.hubAddress);
    const sourceClass = classifyRemoteSourceClass(address);
    if (sourceClass !== "lan-private" && sourceClass !== "tailscale") {
      return { status: "refused", kind: "not-private" };
    }
    // The tunnel arrived from the hub's private address; each relayed device
    // gets its own admission key, so one device cannot spend another's budget.
    const facts: RequestTransportFacts = {
      listenerTrust: "remote",
      sourceClass,
      sourceKey: createHash("sha256").update(`relay|${input.deviceFingerprint}`).digest("hex"),
      relayed: true,
      relayedDeviceFingerprint: input.deviceFingerprint,
    };
    const serve = this.#options.serve;
    return {
      status: "accepted",
      response: acceptWebSocketUpgrade(
        {
          protocol: undefined,
          open: (client) => {
            const { stream, events } = webSocketByteStream(client);
            const fingerprint = input.deviceFingerprint;
            const held = this.#streams.get(fingerprint) ?? new Set<Duplex>();
            held.add(stream);
            this.#streams.set(fingerprint, held);
            stream.once("close", () => {
              held.delete(stream);
              if (held.size === 0 && this.#streams.get(fingerprint) === held) {
                this.#streams.delete(fingerprint);
              }
            });
            if (!serve(stream, facts)) stream.destroy();
            return events;
          },
          cancel: () => undefined,
        },
        { "cache-control": "no-store" },
      ),
    };
  }

  #load(): SpokeRelayState {
    return this.#options.state.load().relays ?? EMPTY;
  }

  #save(relays: SpokeRelayState): void {
    this.#options.state.save({ ...this.#options.state.load(), relays });
  }
}
