import { describe, expect, it } from "vitest";
import { decodeExtensionLifecycleEvent } from "./extensionEvents";

const extensionId = "10000000-0000-4000-8000-000000000001";
const packageId = "20000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const transactionId = "30000000-0000-4000-8000-000000000001";
const manifest = {
  manifestVersion: 1,
  extensionId,
  packageId,
  slug: "fixture",
  displayName: "Fixture",
  version: "1.0.0",
  digest,
  source: { kind: "catalog", catalogId: "octant", entryId: "fixture" },
  provenance: {
    canonicalUrl: "https://example.com/fixture",
    publisher: "Example Publisher",
    reviewed: false,
  },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
  declaredCapabilities: ["mcp"],
  components: [
    {
      id: "server",
      kind: "mcp-server",
      displayName: "Server",
      declaredCapabilities: ["mcp"],
      entryPoint: "entry:server",
    },
  ],
};

describe("extension lifecycle events", () => {
  it.each([
    { kind: "package-inspected", packageId, version: "1.0.0", digest },
    { kind: "install-requested", packageId, version: "1.0.0", digest },
    { kind: "update-requested", packageId, version: "1.1.0", digest },
    { kind: "rollback-requested", packageId, version: "1.0.0", digest },
    { kind: "install-prepared", transactionId, packageId, version: "1.0.0", digest, manifest },
    { kind: "install-committed", transactionId, packageId, version: "1.0.0", digest, manifest },
    { kind: "update-prepared", transactionId, packageId, version: "1.0.0", digest, manifest },
    { kind: "update-committed", transactionId, packageId, version: "1.0.0", digest, manifest },
    { kind: "rollback-selected", packageId, version: "1.0.0", digest, manifest },
    { kind: "disable-requested", packageId },
    { kind: "package-disabled", packageId },
    {
      kind: "disable-waiting",
      packageId,
      reason: { code: "runtime-uncertain", message: "Runtime cleanup is uncertain." },
    },
    { kind: "uninstall-requested", packageId },
    {
      kind: "uninstall-waiting",
      packageId,
      reason: { code: "residue-uncertain", message: "Package cleanup is uncertain." },
    },
    { kind: "package-uninstalled", packageId },
    {
      kind: "transaction-interrupted",
      operation: "install",
      transactionId,
      packageId,
      version: "1.0.0",
      digest,
      reason: { code: "startup-reconciled", message: "Interrupted transaction was quarantined." },
    },
    { kind: "source-trust-changed", trusted: true },
    { kind: "plugin-desired-state-changed", desired: true },
    { kind: "component-desired-state-changed", componentId: "instructions", desired: true },
    {
      kind: "package-quarantined",
      packageId,
      version: "1.0.0",
      digest,
      reason: { code: "capability-review-required", message: "Review capabilities." },
    },
    {
      kind: "runtime-state-observed",
      packageId,
      componentId: "server",
      state: "waiting",
      reason: { code: "runtime-uncertain", message: "Runtime state is uncertain." },
    },
    ...(["starting", "ready", "stopping", "stopped", "disable-pending", "crashed"] as const).map(
      (state) => ({
        kind: "runtime-state-observed" as const,
        packageId,
        componentId: "server",
        state,
      }),
    ),
  ])("decodes versioned $kind payloads", (payload) => {
    expect(
      decodeExtensionLifecycleEvent({
        eventVersion: 1,
        extensionId,
        payload,
      }).payload.kind,
    ).toBe(payload.kind);
  });

  it("rejects unversioned, excess, credential, and private-path data", () => {
    expect(() =>
      decodeExtensionLifecycleEvent({
        extensionId,
        payload: { kind: "uninstall-requested", packageId },
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionLifecycleEvent({
        eventVersion: 1,
        extensionId,
        payload: { kind: "uninstall-requested", packageId, credential: "secret" },
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionLifecycleEvent({
        eventVersion: 1,
        extensionId,
        payload: {
          kind: "package-quarantined",
          reason: { code: "invalid-path", message: "/Users/private/package" },
        },
      }),
    ).toThrow();
  });
});
