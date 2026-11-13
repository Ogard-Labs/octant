import { describe, expect, it } from "vitest";
import {
  decodeCanvasNetworkAccessChanged,
  decodeCanvasNetworkAccessCommand,
  decodeCanvasNetworkAccessResult,
  decodeCanvasNetworkPageRenewalCommand,
  decodeCanvasNetworkPageRenewalResult,
} from "./canvasNetwork";

const canvasId = "11111111-1111-4111-8111-111111111111";

describe("canvas network contracts", () => {
  it("carries one Canvas and one choice, and nothing that says who is asking", () => {
    const command = {
      schemaVersion: 1,
      kind: "set-canvas-network-access",
      canvasId,
      allowed: true,
    };
    expect(decodeCanvasNetworkAccessCommand(command)).toEqual(command);
    for (const extra of [{ actor: "agent" }, { token: "x" }, { url: "https://example.com/" }]) {
      expect(() => decodeCanvasNetworkAccessCommand({ ...command, ...extra })).toThrow();
    }
    expect(() => decodeCanvasNetworkAccessCommand({ ...command, allowed: "yes" })).toThrow();
    expect(() => decodeCanvasNetworkAccessCommand({ ...command, canvasId: "all" })).toThrow();
  });

  it("answers with the switch as it stands or a refusal in words", () => {
    expect(
      decodeCanvasNetworkAccessResult({ kind: "canvas-network-access", canvasId, allowed: false }),
    ).toMatchObject({ allowed: false });
    expect(
      decodeCanvasNetworkAccessResult({
        kind: "canvas-network-access-refused",
        reason: "local-window-required",
        message: "Only a person at this machine can change a Canvas's network.",
      }),
    ).toMatchObject({ reason: "local-window-required" });
    expect(() =>
      decodeCanvasNetworkAccessResult({
        kind: "canvas-network-access-refused",
        reason: "because",
        message: "No.",
      }),
    ).toThrow();
  });

  it("journals a change as the Canvas and the choice alone", () => {
    expect(decodeCanvasNetworkAccessChanged({ canvasId, allowed: true })).toEqual({
      canvasId,
      allowed: true,
    });
    expect(() =>
      decodeCanvasNetworkAccessChanged({ canvasId, allowed: true, token: "x" }),
    ).toThrow();
  });

  it("renews a page by the ticket it was run with, and never by a token or a Canvas", () => {
    const command = {
      schemaVersion: 1,
      kind: "renew-canvas-network-page",
      ticket: "A".repeat(43),
    };
    expect(decodeCanvasNetworkPageRenewalCommand(command)).toEqual(command);
    for (const extra of [{ token: "B".repeat(43) }, { canvasId }, { ttlMs: 1 }]) {
      expect(() => decodeCanvasNetworkPageRenewalCommand({ ...command, ...extra })).toThrow();
    }
    expect(() => decodeCanvasNetworkPageRenewalCommand({ ...command, ticket: "short" })).toThrow();
    expect(decodeCanvasNetworkPageRenewalResult({ kind: "canvas-network-page-renewed" })).toEqual({
      kind: "canvas-network-page-renewed",
    });
    expect(
      decodeCanvasNetworkPageRenewalResult({
        kind: "canvas-network-page-renewal-refused",
        reason: "not-live",
      }),
    ).toMatchObject({ reason: "not-live" });
    expect(() =>
      decodeCanvasNetworkPageRenewalResult({ kind: "canvas-network-page-renewed", token: "x" }),
    ).toThrow();
  });
});
