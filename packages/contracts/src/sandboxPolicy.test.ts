import { describe, expect, it } from "vitest";
import { decodeSandboxPolicy } from "./sandboxPolicy";

export const policy = {
  schemaVersion: 1,
  revision: 1,
  filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
  network: "existing-policy",
  credentials: "existing-policy",
  hostServices: "existing-policy",
} as const;

describe("sandbox policy contract", () => {
  it("requires a complete versioned policy without changing old settings", () => {
    expect(decodeSandboxPolicy(policy)).toEqual(policy);
    expect(() => decodeSandboxPolicy({ ...policy, schemaVersion: 2 })).toThrow();
    expect(() => decodeSandboxPolicy({ ...policy, revision: -1 })).toThrow();
    expect(() => decodeSandboxPolicy({ schemaVersion: 1 })).toThrow();
    expect(() => decodeSandboxPolicy({ ...policy, enabled: false })).toThrow();
  });

  it("refuses relative, ambiguous and control-bearing paths", () => {
    for (const path of [
      "/",
      "~/work",
      "../work",
      "/work/../secret",
      "/work//src",
      "/work/",
      "/work/\nsecret",
      "/work/\0secret",
    ]) {
      expect(() =>
        decodeSandboxPolicy({
          ...policy,
          filesystem: { ...policy.filesystem, readOnlyRoots: [path] },
        }),
      ).toThrow();
    }
    expect(
      decodeSandboxPolicy({
        ...policy,
        filesystem: { ...policy.filesystem, readOnlyRoots: ["/home/person/shared library"] },
      }).filesystem.readOnlyRoots,
    ).toEqual(["/home/person/shared library"]);
  });

  it("rejects unknown nested requirements instead of discarding them", () => {
    expect(() =>
      decodeSandboxPolicy({
        ...policy,
        filesystem: { ...policy.filesystem, preventPublishing: true },
      }),
    ).toThrow();
    expect(() =>
      decodeSandboxPolicy({
        ...policy,
        filesystem: {
          ...policy.filesystem,
          protectedPaths: [{ path: "/work/secret", mode: "deny", expires: 1 }],
        },
      }),
    ).toThrow();
  });
});
