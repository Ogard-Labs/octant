import { describe, expect, it } from "vitest";
import { decodeNightlyWindowBootstrap } from "./nightlyBrowser";

const bootstrap = {
  kind: "registered",
  protocol: 1,
  windowId: "00000000-0000-4000-8000-000000000593",
  generation: 1,
  hostOrigin: "http://127.0.0.1:13773",
  hostInstance: "00000000-0000-4000-8000-000000000594",
  capability: "A".repeat(43),
  rendererIdentity: "A".repeat(43),
  leaseMs: 15_000,
};

describe("authenticated Nightly window bootstrap", () => {
  it("accepts only a closed scoped registration and literal loopback origin", () => {
    expect(decodeNightlyWindowBootstrap(bootstrap)).toEqual(bootstrap);
    for (const hostOrigin of [
      "https://example.com",
      "http://localhost:13773",
      "http://127.0.0.1:13773/path",
      "http://secret@127.0.0.1:13773",
      "http://127.0.0.1:13773#x",
    ]) {
      expect(() => decodeNightlyWindowBootstrap({ ...bootstrap, hostOrigin })).toThrow();
    }
    for (const changed of [
      { leaseMs: 86_400_000 },
      { generation: 0 },
      { desktopBridgeSecret: "private" },
      { kind: "ready" },
    ]) {
      expect(() => decodeNightlyWindowBootstrap({ ...bootstrap, ...changed })).toThrow();
    }
  });
});
