import { describe, expect, it } from "vitest";
import {
  decodeExtensionLifecycleEvent,
  decodeExtensionToolGrantRecorded,
  decodeExtensionToolGrantRevoked,
} from "./extensionEvents";
import {
  decodeExtensionToolApproval,
  decodeExtensionToolApprovalDecision,
  decodeExtensionToolGrantRequest,
} from "./extensionRpc";

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

describe("remembered MCP tool approvals", () => {
  const grantId = `sha256:${"b".repeat(64)}`;
  const recorded = {
    grantId,
    projectId: "40000000-0000-4000-8000-000000000001",
    extensionId,
    packageId,
    componentId: "mcp-notes",
    mcpToolName: "search",
    version: "1.0.0",
    digest,
    definitionDigest: `sha256:${"c".repeat(64)}`,
  };

  it("records which tool in which Project and what the person saw, and nothing of a call", () => {
    expect(decodeExtensionToolGrantRecorded(recorded)).toEqual(recorded);
    for (const leaked of [
      { inputJson: '{"q":"plan"}' },
      { result: "notes" },
      { providerToolName: "ext_mcp_notes_search_0123456789abcdef" },
      { threadId: "50000000-0000-4000-8000-000000000001" },
    ]) {
      expect(() => decodeExtensionToolGrantRecorded({ ...recorded, ...leaked })).toThrow();
    }
    expect(() => decodeExtensionToolGrantRecorded({ ...recorded, projectId: undefined })).toThrow();
  });

  it("revokes a grant only for a named reason", () => {
    for (const reason of ["person", "plugin-uninstalled", "trust-revoked", "rolled-back"]) {
      expect(
        decodeExtensionToolGrantRevoked({ grantId, projectId: recorded.projectId, reason }).reason,
      ).toBe(reason);
    }
    expect(() =>
      decodeExtensionToolGrantRevoked({
        grantId,
        projectId: recorded.projectId,
        reason: "expired",
      }),
    ).toThrow();
  });

  it("lets only an approval be remembered", () => {
    const approvalId = "60000000-0000-4000-8000-000000000001";
    expect(decodeExtensionToolApprovalDecision({ approvalId, decision: "approved" })).toEqual({
      approvalId,
      decision: "approved",
    });
    expect(
      decodeExtensionToolApprovalDecision({ approvalId, decision: "approved", remember: true })
        .remember,
    ).toBe(true);
    expect(() =>
      decodeExtensionToolApprovalDecision({ approvalId, decision: "denied", remember: true }),
    ).toThrow();
  });

  it("tells the prompt which server asks and whether the answer may be remembered", () => {
    const approval = {
      approvalId: "60000000-0000-4000-8000-000000000001",
      threadId: "50000000-0000-4000-8000-000000000001",
      extensionId,
      packageId,
      componentId: "mcp-notes",
      serverName: "notes",
      providerToolName: "ext_mcp_notes_search_0123456789abcdef",
      mcpToolName: "search",
      inputJson: "{}",
      requestedAt: "2026-10-12T10:00:00.000Z",
      rememberable: false,
    };
    expect(decodeExtensionToolApproval(approval)).toEqual(approval);
    const { rememberable: _rememberable, ...withoutAnswerScope } = approval;
    expect(() => decodeExtensionToolApproval(withoutAnswerScope)).toThrow();
  });

  it("offers a window no request that creates a grant", () => {
    expect(decodeExtensionToolGrantRequest({ kind: "list" })).toEqual({ kind: "list" });
    expect(decodeExtensionToolGrantRequest({ kind: "revoke", grantId })).toEqual({
      kind: "revoke",
      grantId,
    });
    for (const kind of ["record", "grant", "create", "set"]) {
      expect(() => decodeExtensionToolGrantRequest({ ...recorded, kind })).toThrow();
    }
  });
});
