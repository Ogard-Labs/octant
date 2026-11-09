import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { RemoteSetupCheckInput, RemoteSetupCheckResult } from "./remoteSetup";
const input = { serverId: "00000000-0000-4000-8000-000000000710", runtime: "octant-harness" };
describe("read-only remote setup contracts", () => {
  it("admits only a registered identifier, supported choice shape and an optional absolute folder", () => {
    const decode = Schema.decodeUnknownSync(RemoteSetupCheckInput);
    expect(decode({ ...input, folder: "/srv/app" })).toEqual({ ...input, folder: "/srv/app" });
    for (const extra of [
      { script: "pwd" },
      { key: "credential" },
      { alias: "other" },
      { acceptHostKey: true },
    ])
      expect(() => decode({ ...input, ...extra })).toThrow();
    for (const folder of ["relative", "/srv/line\nbreak", "/srv/null\0byte"])
      expect(() => decode({ ...input, folder })).toThrow();
  });
  it("refuses contradictory success and refusal answers", () => {
    const decode = Schema.decodeUnknownSync(RemoteSetupCheckResult);
    expect(decode({ status: "connected", reason: "ready", folder: "/srv/app" })).toMatchObject({
      status: "connected",
    });
    expect(() => decode({ status: "connected", reason: "changed-identity" })).toThrow();
    expect(() => decode({ status: "disconnected", reason: "ready", folder: "/srv/app" })).toThrow();
  });
});
