import type { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { HubLinkState, type HubState, type HubStatePort } from "./hubStateStore";
import { SpokeRelayService } from "./spokeRelayService";
import { takeWebSocketUpgrade } from "../webSocketRelay";

const window = { kind: "local-window" } as const;
const FINGERPRINT = "a".repeat(64);

/** A complete hub link, decoded like a stored one, to the hub `hubMemberId` at `hubOrigin`. */
function linkTo(hubMemberId: string, hubOrigin: string): HubLinkState {
  return Schema.decodeUnknownSync(HubLinkState)({
    selfMemberId: "33333333-3333-4333-8333-333333333333",
    hubMemberId,
    hubName: "Hub",
    hubOrigin,
    hubListenerPin: "b".repeat(64),
    hubIdentityPublicKey: "hub-key",
    rosterSigningPublicKey: "roster-key",
    grant: { items: [], actProjects: [] },
    roster: {
      roster: { sequence: 1, members: [], standbyOrder: [], failoverAfterSeconds: 60 },
      signedBy: { kind: "hub", memberId: hubMemberId },
      signature: "signature",
    },
    peerGrants: [],
  });
}

function memoryState(): HubStatePort {
  let state: HubState = {};
  return { load: () => state, save: (next) => void (state = next) };
}

function host() {
  let granted = true;
  let paused = false;
  let active = true;
  const served: Duplex[] = [];
  const service = new SpokeRelayService({
    state: memoryState(),
    relayGranted: () => granted,
    hub: { sendDevices: async () => true },
    devices: () => [{ deviceId: "phone", fingerprint: FINGERPRINT, active }],
    paused: () => paused,
    serve: (socket) => {
      served.push(socket);
      return true;
    },
    record: () => undefined,
  });
  /** Opens one tunnel the way the listener's transport does, and returns its stream. */
  const open = (): Duplex => {
    const opened = service.openTunnel({
      deviceFingerprint: FINGERPRINT,
      hubAddress: "100.101.102.103",
    });
    if (opened.status !== "accepted") throw new Error(opened.kind);
    takeWebSocketUpgrade(opened.response)?.open({ send: () => undefined, close: () => undefined });
    const stream = served.at(-1);
    if (stream === undefined) throw new Error("nothing was served");
    return stream;
  };
  return {
    service,
    open,
    untickRelay: () => {
      granted = false;
    },
    pause: () => {
      paused = true;
    },
    forget: () => {
      active = false;
    },
  };
}

describe("relayed devices on their host", () => {
  it("turning a device's relay off ends its open tunnel", async () => {
    const context = host();
    await context.service.allow("phone", true, window);
    const stream = context.open();
    expect(stream.destroyed).toBe(false);
    await context.service.allow("phone", false, window);
    expect(stream.destroyed).toBe(true);
  });

  it("forgetting a device ends its open tunnel", async () => {
    const context = host();
    await context.service.allow("phone", true, window);
    const stream = context.open();
    context.forget();
    await context.service.deviceRemoved("phone");
    expect(stream.destroyed).toBe(true);
  });

  it("unticking Relay or pausing remote access ends open tunnels at the next look", async () => {
    for (const change of ["untick", "pause"] as const) {
      const context = host();
      await context.service.allow("phone", true, window);
      const stream = context.open();
      if (change === "untick") context.untickRelay();
      else context.pause();
      await context.service.look();
      expect(stream.destroyed, change).toBe(true);
    }
  });

  it("sends its device list again to a promoted hub that has never had it", async () => {
    const OLD_HUB = "11111111-1111-4111-8111-111111111111";
    const PROMOTED = "22222222-2222-4222-8222-222222222222";
    let state: HubState = { link: linkTo(OLD_HUB, "https://a") };
    // The spoke's hub client sends to whichever hub the link names at the time.
    const received: string[] = [];
    const service = new SpokeRelayService({
      state: { load: () => state, save: (next) => void (state = next) },
      relayGranted: () => true,
      hub: {
        sendDevices: async (update) => {
          received.push(`${String(state.link?.hubMemberId)} ${update.fingerprints.join(",")}`);
          return true;
        },
      },
      devices: () => [{ deviceId: "phone", fingerprint: FINGERPRINT, active: true }],
      paused: () => false,
      serve: () => true,
      record: () => undefined,
    });
    await service.allow("phone", true, window);
    await service.look();
    expect(received).toEqual([`${OLD_HUB} ${FINGERPRINT}`]);
    state = { ...state, link: linkTo(PROMOTED, "https://b") };
    await service.look();
    expect(received).toEqual([`${OLD_HUB} ${FINGERPRINT}`, `${PROMOTED} ${FINGERPRINT}`]);
  });
});
