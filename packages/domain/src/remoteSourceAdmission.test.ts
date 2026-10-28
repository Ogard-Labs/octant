import { describe, expect, it } from "vitest";
import {
  admitRemoteSource,
  REMOTE_SOURCE_GATES,
  type RemoteRequestSourceClass,
  type RemoteSourceGate,
} from "./remoteSourceAdmission";

const PRIVATE_NETWORK_CLASSES: ReadonlyArray<RemoteRequestSourceClass> = [
  "loopback",
  "lan-private",
  "tailscale",
];

describe("remote source admission", () => {
  it("admits a relayed stream to hello, negotiation, the authentication challenge, sessions, and authenticated requests", () => {
    const admitted: ReadonlyArray<RemoteSourceGate> = [
      "hello",
      "negotiation",
      "auth-challenge",
      "session",
      "authenticated",
    ];
    for (const gate of admitted) {
      expect(admitRemoteSource(gate, "relayed"), gate).toEqual({ status: "admitted" });
    }
  });

  it("refuses a relayed stream every pairing route and ticket minting", () => {
    const pairing: ReadonlyArray<RemoteSourceGate> = [
      "pairing-claim",
      "pairing-status",
      "pairing-ticket",
    ];
    for (const gate of pairing) {
      expect(admitRemoteSource(gate, "relayed"), gate).toEqual({
        status: "refused",
        reason: "private-network-only",
      });
    }
  });

  it("refuses a relayed stream the public pre-authentication routes and static assets", () => {
    for (const gate of ["public-pre-auth", "static-asset"] as const) {
      expect(admitRemoteSource(gate, "relayed"), gate).toEqual({
        status: "refused",
        reason: "private-network-only",
      });
    }
  });

  it("admits loopback, private LAN, and Tailscale sources at every gate, as today", () => {
    for (const gate of REMOTE_SOURCE_GATES) {
      for (const sourceClass of PRIVATE_NETWORK_CLASSES) {
        expect(admitRemoteSource(gate, sourceClass), `${gate} ${sourceClass}`).toEqual({
          status: "admitted",
        });
      }
    }
  });

  it("refuses an unclassified source at every gate", () => {
    for (const gate of REMOTE_SOURCE_GATES) {
      expect(admitRemoteSource(gate, "unknown"), gate).toEqual({
        status: "refused",
        reason: "unclassified-source",
      });
    }
  });
});
