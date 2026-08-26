import { describe, expect, it } from "vitest";
import {
  decodeToolActionAuthority,
  decodeToolActionCapability,
  decodeToolExtensionId,
  lookupClosedToolCatalogEntry,
} from "@octant/contracts";
import {
  resolveNetworkEgressPolicy,
  resolveToolCall,
  type ToolCallPolicyInput,
} from "./toolCallPolicy";

const coreAuthority = decodeToolActionAuthority({
  hostId: "11111111-1111-4111-8111-111111111111",
  mode: "code",
  projectId: "22222222-2222-4222-8222-222222222222",
  rootId: "33333333-3333-4333-8333-333333333333",
  worktreeId: "44444444-4444-4444-8444-444444444444",
  providerInstanceId: "55555555-5555-4555-8555-555555555555",
  extension: { kind: "core" },
});

const extensionId = decodeToolExtensionId("99999999-9999-4999-8999-999999999999");

function baseInput(overrides: Partial<ToolCallPolicyInput> = {}): ToolCallPolicyInput {
  return {
    capability: decodeToolActionCapability({ id: "browser-automation", version: 1 }),
    extension: { kind: "core" },
    mode: "code",
    arguments: {
      profileMode: "isolated",
      allowedOrigins: ["https://example.com"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 1,
      sessionTimeoutMs: 300_000,
    },
    providerAppManagedTools: "supported",
    host: { computerUseEnabled: true },
    thread: {
      executionPolicy: "approval-gated",
      approvalSatisfied: true,
      // Taint hook: thread-lifetime taint once external content was ingested.
      externalContentIngested: false,
    },
    ...overrides,
  };
}

describe("closed tool catalog grounding", () => {
  it("indexes existing contract capability ids rather than inventing parallel names", () => {
    expect(
      lookupClosedToolCatalogEntry(
        decodeToolActionCapability({ id: "browser-automation", version: 1 }),
      )?.name,
    ).toBe("browser-automation");
    expect(
      lookupClosedToolCatalogEntry(decodeToolActionCapability({ id: "computer-use", version: 1 }))
        ?.name,
    ).toBe("computer-use");
    expect(
      lookupClosedToolCatalogEntry(
        decodeToolActionCapability({ id: "repository-validation", version: 1 }),
      )?.name,
    ).toBe("repository-validation");
    expect(
      lookupClosedToolCatalogEntry(
        decodeToolActionCapability({ id: "model-invented-shell", version: 1 }),
      ),
    ).toBeUndefined();
  });
});

describe("resolveToolCall fail-closed order", () => {
  it("1. denies unknown tools at tool-identity before inspecting arguments", () => {
    const decision = resolveToolCall(
      baseInput({
        capability: decodeToolActionCapability({ id: "model-invented-shell", version: 1 }),
        arguments: { __proto__: { polluted: true }, command: "rm -rf /" },
      }),
    );
    expect(decision).toMatchObject({
      kind: "deny",
      step: "tool-identity",
      reason: "unknown-tool",
    });
    expect(decision.receipt.decision).toBe("deny");
  });

  it("1. denies MCP/extension authority claiming a core catalog tool", () => {
    const decision = resolveToolCall(
      baseInput({
        extension: { kind: "trusted-extension", extensionId },
        declaredCapabilities: ["browser"],
      }),
    );
    expect(decision).toMatchObject({
      kind: "deny",
      step: "tool-identity",
      reason: "mcp-cannot-claim-core",
    });
  });

  it("1. denies extension tools that omit a declared capability class ceiling", () => {
    const decision = resolveToolCall(
      baseInput({
        capability: decodeToolActionCapability({ id: "mcp-tool", version: 1 }),
        extension: { kind: "trusted-extension", extensionId },
        arguments: {
          mcpToolName: "read_file",
          providerToolName: "read_file",
          inputJson: "{}",
          requiredCapabilityClass: "filesystem",
        },
        declaredCapabilities: ["mcp"],
      }),
    );
    expect(decision).toMatchObject({
      kind: "deny",
      step: "tool-identity",
      reason: "undeclared-capability-class",
    });
  });

  it("2. denies a profile-excluded tool before any later permissive step", () => {
    const decision = resolveToolCall(
      baseInput({
        thread: {
          executionPolicy: "full-access",
          approvalSatisfied: true,
          externalContentIngested: false,
          toolConstraints: ["computer-use"],
          profileDisplayName: "Reviewer",
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "deny",
      step: "profile-constraints",
      reason: 'Profile "Reviewer" does not permit "browser-automation".',
    });
  });

  it("2. still allows an ordinary posture-permitted tool when the snapshotted allowlist is empty", () => {
    const decision = resolveToolCall(
      baseInput({
        thread: {
          executionPolicy: "approval-gated",
          approvalSatisfied: true,
          externalContentIngested: false,
          toolConstraints: [],
          profileDisplayName: "Reviewer",
        },
      }),
    );
    expect(decision.kind).toBe("allow");
  });

  it("2. denies invalid arguments at argument-schema after identity succeeds", () => {
    const decision = resolveToolCall(
      baseInput({
        arguments: {
          profileMode: "isolated",
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
          maxConcurrentTabs: 99,
          sessionTimeoutMs: 300_000,
          unexpected: true,
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "deny",
      step: "argument-schema",
    });
  });

  it("3. denies chat mode for filesystem/shell-class tools at mode-policy", () => {
    const decision = resolveToolCall(
      baseInput({
        capability: decodeToolActionCapability({ id: "computer-use", version: 1 }),
        mode: "chat",
        arguments: {
          allowlist: [],
          sensitiveFieldProtection: true,
          visibleStopControl: true,
          maxSessionDurationMs: 60_000,
          processOwnershipRequired: true,
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "deny",
      step: "mode-policy",
      reason: "mode-capability-denied",
    });
  });

  it("4. denies when the provider does not support app-managed tools", () => {
    const decision = resolveToolCall(baseInput({ providerAppManagedTools: "unsupported" }));
    expect(decision).toMatchObject({
      kind: "deny",
      step: "provider-capability",
      reason: "provider-capability-unsupported",
    });
  });

  it("5. denies host-prohibited computer-use at host-policy", () => {
    const decision = resolveToolCall(
      baseInput({
        capability: decodeToolActionCapability({ id: "computer-use", version: 1 }),
        mode: "code",
        host: { computerUseEnabled: false },
        arguments: {
          allowlist: [],
          sensitiveFieldProtection: true,
          visibleStopControl: true,
          maxSessionDurationMs: 60_000,
          processOwnershipRequired: true,
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "deny",
      step: "host-policy",
      reason: "computer-use-disabled",
    });
  });

  it("6. denies remote actors that fail principal authorization", () => {
    const decision = resolveToolCall(
      baseInput({
        remoteActor: {
          principalKind: "remote-device",
          action: "desktop.issue-local-approval",
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "deny",
      step: "remote-actor",
      reason: "remote-cannot-mint-local-receipt",
    });
  });

  it("7. denies plan posture for irreversible classes and prompts when gated", () => {
    const planDenied = resolveToolCall(
      baseInput({
        capability: decodeToolActionCapability({ id: "computer-use", version: 1 }),
        arguments: {
          allowlist: [],
          sensitiveFieldProtection: true,
          visibleStopControl: true,
          maxSessionDurationMs: 60_000,
          processOwnershipRequired: true,
        },
        thread: {
          executionPolicy: "plan",
          approvalSatisfied: false,
          externalContentIngested: false,
        },
      }),
    );
    expect(planDenied).toMatchObject({
      kind: "deny",
      step: "thread-elevation",
      reason: "plan-mode-denied",
    });

    const prompt = resolveToolCall(
      baseInput({
        capability: decodeToolActionCapability({ id: "computer-use", version: 1 }),
        arguments: {
          allowlist: [],
          sensitiveFieldProtection: true,
          visibleStopControl: true,
          maxSessionDurationMs: 60_000,
          processOwnershipRequired: true,
        },
        thread: {
          executionPolicy: "approval-gated",
          approvalSatisfied: false,
          externalContentIngested: false,
        },
      }),
    );
    expect(prompt).toMatchObject({
      kind: "prompt",
      approvalClass: "external-application",
    });
    expect(prompt.receipt.decision).toBe("prompt");
  });

  it("7. taint hook forces fresh confirmation for irreversible classes", () => {
    const decision = resolveToolCall(
      baseInput({
        capability: decodeToolActionCapability({ id: "computer-use", version: 1 }),
        arguments: {
          allowlist: [],
          sensitiveFieldProtection: true,
          visibleStopControl: true,
          maxSessionDurationMs: 60_000,
          processOwnershipRequired: true,
        },
        thread: {
          executionPolicy: "full-access",
          approvalSatisfied: true,
          externalContentIngested: true,
        },
      }),
    );
    expect(decision).toMatchObject({
      kind: "prompt",
      reason: "taint-requires-fresh-confirmation",
    });
  });

  it("7b. auto-accept edits waives only project file writes", () => {
    const validation = (executionPolicy: "approval-gated" | "auto-accept-edits") =>
      resolveToolCall(
        baseInput({
          capability: decodeToolActionCapability({ id: "repository-validation", version: 1 }),
          arguments: {},
          thread: { executionPolicy, approvalSatisfied: false, externalContentIngested: false },
        }),
      );
    expect(validation("approval-gated").kind).toBe("prompt");
    expect(validation("auto-accept-edits").kind).toBe("allow");

    // An external application is not an edit, so it still asks.
    const computerUse = resolveToolCall(
      baseInput({
        capability: decodeToolActionCapability({ id: "computer-use", version: 1 }),
        arguments: {
          allowlist: [],
          sensitiveFieldProtection: true,
          visibleStopControl: true,
          maxSessionDurationMs: 60_000,
          processOwnershipRequired: true,
        },
        thread: {
          executionPolicy: "auto-accept-edits",
          approvalSatisfied: false,
          externalContentIngested: false,
        },
      }),
    );
    expect(computerUse).toMatchObject({ kind: "prompt", reason: "approval-required" });
    // And the posture never widens the network.
    expect(resolveNetworkEgressPolicy({ mode: "code", executionPolicy: "auto-accept-edits" })).toBe(
      "provider-endpoints-only",
    );
  });

  it("allows a fully authorized core browser tool and emits an allow receipt", () => {
    const decision = resolveToolCall(baseInput());
    expect(decision.kind).toBe("allow");
    if (decision.kind !== "allow") return;
    expect(decision.egressPolicy).toBe("provider-endpoints-only");
    expect(decision.receipt).toMatchObject({
      decision: "allow",
      capabilityId: "browser-automation",
      actorKind: "system",
    });
    expect(coreAuthority.extension.kind).toBe("core");
  });

  it("earlier denials cannot be overridden by later permissive inputs", () => {
    const decision = resolveToolCall(
      baseInput({
        capability: decodeToolActionCapability({ id: "unknown-tool", version: 1 }),
        providerAppManagedTools: "supported",
        host: { computerUseEnabled: true },
        thread: {
          executionPolicy: "full-access",
          approvalSatisfied: true,
          externalContentIngested: false,
        },
      }),
    );
    expect(decision).toMatchObject({ kind: "deny", step: "tool-identity" });
  });
});

describe("resolveNetworkEgressPolicy", () => {
  it("defaults Code approval-gated to provider-endpoints-only", () => {
    expect(resolveNetworkEgressPolicy({ mode: "code", executionPolicy: "approval-gated" })).toBe(
      "provider-endpoints-only",
    );
    expect(resolveNetworkEgressPolicy({ mode: "code", executionPolicy: "full-access" })).toBe(
      "unrestricted",
    );
    expect(resolveNetworkEgressPolicy({ mode: "code", executionPolicy: "plan" })).toBe("none");
    expect(resolveNetworkEgressPolicy({ mode: "work", executionPolicy: "full-access" })).toBe(
      "none",
    );
    expect(resolveNetworkEgressPolicy({ mode: "chat", executionPolicy: "full-access" })).toBe(
      "none",
    );
  });
});
