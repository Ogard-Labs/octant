import { describe, expect, it } from "vitest";
import {
  decodeLaunchSessionExchange,
  decodeLaunchSessionExchangeRequest,
  decodeLaunchSessionFailure,
  decodeLaunchSessionReceipt,
  decodeLaunchSessionRequest,
  isCanonicalLaunchSessionToken,
  LaunchSessionToken,
} from "./launchSession";

const windowId = "11111111-1111-4111-8111-111111111111";
const token = `${"A".repeat(42)}A`;
const decodeToken = LaunchSessionToken.make(token);

describe("isCanonicalLaunchSessionToken", () => {
  it("accepts a canonical 256-bit base64url token", () => {
    expect(isCanonicalLaunchSessionToken(token)).toBe(true);
    expect(isCanonicalLaunchSessionToken(`${"A".repeat(42)}B`)).toBe(false);
    expect(isCanonicalLaunchSessionToken("short")).toBe(false);
    expect(isCanonicalLaunchSessionToken(undefined)).toBe(false);
  });
});

describe("decodeLaunchSessionRequest", () => {
  it("decodes an admin launch-session creation request", () => {
    expect(decodeLaunchSessionRequest({ windowId, capability: token })).toEqual({
      windowId,
      capability: token,
    });
  });

  it.each<[unknown, string]>([
    [{ windowId, capability: "short" }, "capability"],
    [{ windowId: "not-a-uuid", capability: token }, "windowId"],
    [{ capability: token }, "windowId"],
    [{ windowId, capability: token, extra: 1 }, "excess"],
  ])("rejects an invalid request %#", (input) => {
    expect(() => decodeLaunchSessionRequest(input)).toThrow();
  });
});

describe("decodeLaunchSessionReceipt", () => {
  it("decodes a single-use token and its positive expiry", () => {
    expect(decodeLaunchSessionReceipt({ launchToken: token, expiresAt: 1_000 })).toEqual({
      launchToken: decodeToken,
      expiresAt: 1_000,
    });
  });

  it("rejects a non-positive expiry", () => {
    expect(() => decodeLaunchSessionReceipt({ launchToken: token, expiresAt: 0 })).toThrow();
  });
});

describe("decodeLaunchSessionExchangeRequest", () => {
  it("decodes a renderer exchange request", () => {
    expect(decodeLaunchSessionExchangeRequest({ launchToken: token })).toEqual({
      launchToken: decodeToken,
    });
  });

  it("rejects a malformed token", () => {
    expect(() => decodeLaunchSessionExchangeRequest({ launchToken: "short" })).toThrow();
  });
});

describe("decodeLaunchSessionExchange", () => {
  it("decodes the authenticated window identity and capability", () => {
    expect(decodeLaunchSessionExchange({ windowId, capability: token })).toEqual({
      windowId,
      capability: token,
    });
  });
});

describe("decodeLaunchSessionFailure", () => {
  it.each<[unknown, string]>([
    [{ category: "invalid", message: "Launch session token is invalid." }, "invalid"],
    [{ category: "unauthorized", message: "Launch session is unauthorized." }, "unauthorized"],
    [{ category: "unavailable", message: "Launch sessions are unavailable." }, "unavailable"],
  ])("decodes a %s failure", (value) => {
    expect(decodeLaunchSessionFailure(value)).toEqual(value);
  });

  it("rejects an unknown failure category", () => {
    expect(() => decodeLaunchSessionFailure({ category: "conflict", message: "nope" })).toThrow();
  });
});
