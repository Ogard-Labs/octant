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
  it("accepts exact loopback services without accepting names, ranges or ambient sockets", () => {
    const localServices = [
      { host: "127.0.0.1", port: 5173 },
      { host: "::1", port: 8080 },
    ];
    expect(
      decodeSandboxPolicy({ ...policy, hostServices: "blocked", localServices }).localServices,
    ).toEqual(localServices);
    expect(() => decodeSandboxPolicy({ ...policy, localServices })).toThrow();
    for (const service of [
      { host: "localhost", port: 5173 },
      { host: "127.0.0.2", port: 5173 },
      { host: "0.0.0.0", port: 5173 },
      { host: "::ffff:127.0.0.1", port: 5173 },
      { host: "127.0.0.1", port: 0 },
      { host: "127.0.0.1", port: 65536 },
      { host: "127.0.0.1", port: 5173, socket: "/run/docker.sock" },
    ])
      expect(() =>
        decodeSandboxPolicy({ ...policy, hostServices: "blocked", localServices: [service] }),
      ).toThrow();
  });
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
  it("accepts only exact public destination names and valid ports for narrow exceptions", () => {
    for (const host of [
      "*.example.com",
      "localhost",
      "127.0.0.1",
      "bad name",
      "example.com/path",
    ]) {
      expect(() =>
        decodeSandboxPolicy({ ...policy, approvedDestinations: [{ host, port: 443 }] }),
      ).toThrow();
    }
    expect(() =>
      decodeSandboxPolicy({
        ...policy,
        approvedDestinations: [{ host: "packages.example.com", port: 0 }],
      }),
    ).toThrow();
    expect(
      decodeSandboxPolicy({
        ...policy,
        approvedDestinations: [{ host: "packages.example.com", port: 443 }],
      }).approvedDestinations,
    ).toHaveLength(1);
  });
});
