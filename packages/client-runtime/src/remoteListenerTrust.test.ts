import { refusePairingCodeListener } from "@octant/domain";
import { describe, expect, it } from "vitest";
import {
  decodeListenerOriginTrust,
  judgeListenerAddresses,
  judgeListenerCertificate,
  listenerPinFromSha256,
  type ListenerOriginTrust,
} from "./remoteListenerTrust";

const PIN_A = listenerPinFromSha256(new Uint8Array(32).fill(1));
const PIN_B = listenerPinFromSha256(new Uint8Array(32).fill(2));
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const pinned = (pin: string): ListenerOriginTrust => ({ current: { kind: "pinned", pin } });
const platform: ListenerOriginTrust = { current: { kind: "platform" } };

describe("judging a listener's addresses", () => {
  it.each([
    ["a Tailscale IPv4 address", "100.101.102.103"],
    ["a Tailscale IPv6 address", "fd7a:115c:a1e0::1"],
    ["a private LAN address", "192.168.1.20"],
    ["a unique local IPv6 address", "fd12:3456::1"],
  ])("accepts %s", (_label, address) => {
    expect(judgeListenerAddresses([address])).toEqual({ status: "private", address });
  });

  it.each([
    ["a public address", ["203.0.113.7"]],
    ["loopback", ["127.0.0.1"]],
    ["a *.ts.net name rather than an address", ["host.example-tailnet.ts.net"]],
    ["an IPv4-mapped IPv6 form of a private address", ["::ffff:10.0.0.5"]],
    ["an address with a zone", ["fe80::1%en0"]],
    ["a private answer beside a public one", ["100.101.102.103", "203.0.113.7"]],
    ["no answer", []],
    ["an unknown peer", [undefined]],
  ])("refuses %s", (_label, addresses) => {
    expect(judgeListenerAddresses(addresses)).toEqual({
      status: "refused",
      reason: "not-private-address",
    });
  });
});

describe("judging a listener's certificate", () => {
  it("accepts a pinned origin only on its pin, whatever the platform says", () => {
    expect(
      judgeListenerCertificate({
        trust: pinned(PIN_A),
        servedPin: PIN_A,
        platformTrusted: false,
        now: NOW,
      }),
    ).toEqual({ status: "accepted", trust: pinned(PIN_A) });
    expect(
      judgeListenerCertificate({
        trust: pinned(PIN_A),
        servedPin: PIN_B,
        platformTrusted: true,
        now: NOW,
      }),
    ).toEqual({ status: "refused", reason: "pin-mismatch" });
    expect(
      judgeListenerCertificate({
        trust: pinned(PIN_A),
        servedPin: undefined,
        platformTrusted: true,
        now: NOW,
      }),
    ).toEqual({ status: "refused", reason: "pin-mismatch" });
  });

  it("accepts an origin with no pin only when the platform verified the certificate", () => {
    expect(
      judgeListenerCertificate({
        trust: platform,
        servedPin: PIN_A,
        platformTrusted: true,
        now: NOW,
      }),
    ).toEqual({ status: "accepted", trust: platform });
    expect(
      judgeListenerCertificate({
        trust: platform,
        servedPin: PIN_A,
        platformTrusted: false,
        now: NOW,
      }),
    ).toEqual({ status: "refused", reason: "platform-untrusted" });
  });

  it("refuses a pin of an unknown hash as needing a newer Octant, even when the text matches", () => {
    const sha384 = "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    expect(
      judgeListenerCertificate({
        trust: pinned(sha384),
        servedPin: sha384,
        platformTrusted: true,
        now: NOW,
      }),
    ).toEqual({ status: "refused", reason: "newer-version" });
  });

  describe("with a staged trust", () => {
    const staged = (until: string): ListenerOriginTrust => ({
      current: { kind: "pinned", pin: PIN_A },
      staged: { trust: { kind: "pinned", pin: PIN_B }, until },
    });

    it("keeps the staged trust while the current one still passes", () => {
      const trust = staged("2026-11-01T00:00:00.000Z");

      expect(
        judgeListenerCertificate({ trust, servedPin: PIN_A, platformTrusted: false, now: NOW }),
      ).toEqual({ status: "accepted", trust });
    });

    it("makes the staged trust current, dropping the old one, when only it passes", () => {
      expect(
        judgeListenerCertificate({
          trust: staged("2026-11-01T00:00:00.000Z"),
          servedPin: PIN_B,
          platformTrusted: false,
          now: NOW,
        }),
      ).toEqual({ status: "accepted", trust: pinned(PIN_B) });
    });

    it("stops accepting the staged trust when its window has ended", () => {
      const trust = staged("2026-10-01T00:00:00.000Z");

      expect(
        judgeListenerCertificate({ trust, servedPin: PIN_B, platformTrusted: true, now: NOW }),
      ).toEqual({ status: "refused", reason: "pin-mismatch" });
      expect(
        judgeListenerCertificate({ trust, servedPin: PIN_A, platformTrusted: false, now: NOW }),
      ).toEqual({ status: "accepted", trust: pinned(PIN_A) });
    });

    it("moves a pinned origin to platform trust only through a staged platform trust", () => {
      const trust: ListenerOriginTrust = {
        current: { kind: "pinned", pin: PIN_A },
        staged: { trust: { kind: "platform" }, until: "2026-11-01T00:00:00.000Z" },
      };

      expect(
        judgeListenerCertificate({ trust, servedPin: PIN_B, platformTrusted: true, now: NOW }),
      ).toEqual({ status: "accepted", trust: platform });
      expect(
        judgeListenerCertificate({ trust, servedPin: PIN_B, platformTrusted: false, now: NOW }),
      ).toEqual({ status: "refused", reason: "pin-mismatch" });
    });
  });
});

describe("a listener pin", () => {
  it("has the form the host's pairing code carries", () => {
    expect(refusePairingCodeListener({ origin: "https://100.101.102.103:8443", pin: PIN_A })).toBe(
      undefined,
    );
  });
});

describe("reading a stored trust", () => {
  it("reads what it stores", () => {
    const trust: ListenerOriginTrust = {
      current: { kind: "pinned", pin: PIN_A },
      staged: { trust: { kind: "platform" }, until: "2026-11-01T00:00:00.000Z" },
    };

    expect(decodeListenerOriginTrust(JSON.parse(JSON.stringify(trust)))).toEqual(trust);
  });

  it.each([
    ["no current trust", {}],
    ["an unknown kind", { current: { kind: "any" } }],
    ["a pinned trust with no pin", { current: { kind: "pinned" } }],
    ["a pin without its algorithm", { current: { kind: "pinned", pin: "AAAA" } }],
    [
      "a staged trust with no end",
      { current: { kind: "platform" }, staged: { trust: { kind: "platform" } } },
    ],
    [
      "a staged trust whose end is not a time",
      { current: { kind: "platform" }, staged: { trust: { kind: "platform" }, until: "soon" } },
    ],
  ])("reads nothing from %s", (_label, value) => {
    expect(decodeListenerOriginTrust(value)).toBeUndefined();
  });
});
