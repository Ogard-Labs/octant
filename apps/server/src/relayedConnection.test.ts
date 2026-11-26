import { describe, expect, it } from "vitest";
import { relayedRequestRefused } from "./relayedConnection";

describe("what a relayed request may never reach", () => {
  it("refuses pairing, hub and desktop routes, and changes to devices or the pause", () => {
    for (const [method, path] of [
      ["POST", "/api/remote/pairing/claim"],
      ["GET", "/api/remote/pairing/status"],
      ["POST", "/api/hub/join"],
      ["GET", "/api/desktop/remote/devices"],
      ["POST", "/api/remote/devices/sign-out-others"],
      ["POST", "/api/remote/access-pause"],
    ] as const) {
      expect(relayedRequestRefused(method, path), `${method} ${path}`).toBe(true);
    }
    expect(relayedRequestRefused("GET", "/api/remote/devices")).toBe(false);
    expect(relayedRequestRefused("POST", "/api/thread-message-queue")).toBe(false);
  });

  it("refuses a path that would resolve somewhere else than where it was checked", () => {
    for (const path of [
      "/api/x/../remote/pairing",
      "/api/%2e%2e/api/remote/pairing",
      "/api/%2E%2E/hub/join",
      "/api/remote/devices/a/../sign-out-others",
      "/./api/hub/join",
      "/api/..",
      "/api\\..\\hub\\join",
      "/api/%5chub",
      "https://elsewhere.example/api/remote/pairing",
      "//elsewhere.example/api/hub/join",
      "api/hub/join",
    ]) {
      expect(relayedRequestRefused("POST", path), path).toBe(true);
    }
  });
});
