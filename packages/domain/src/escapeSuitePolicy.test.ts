import { describe, expect, it } from "vitest";
import {
  decodeToolActionAuthority,
  decodeToolActionRequest,
  type AgentRunAuthority,
} from "@octant/contracts";
import {
  AgentRunPolicyRejected,
  authorizeCodeOperation,
  authorizePrincipalAction,
  authorizeToolAction,
  clampAgentRunAuthority,
  canonicalizeWorkRelativePath,
  WorkConfinementRejected,
  evaluateSession,
  validateAgentRunDepth,
  validateWorkspaceReceipt,
} from "./index";

/**
 * Layer 1 escape-suite truth tables for the EventActor audit taxonomy.
 * Maps fixture rows to current fail-closed modules until S1 `toolCallPolicy` merges.
 * Extension activation rows live in server escape-suite tests to keep domain free
 * of an extensions dependency.
 */
describe("escape suite policy truth tables", () => {
  const parentAuthority: AgentRunAuthority = {
    filesystem: true,
    shell: false,
    git: true,
    network: false,
    tools: true,
    subagents: true,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
  };

  describe("injected-readme → workConfinementPolicy + toolActionPolicy", () => {
    it("rejects traversal and absolute private paths", () => {
      expect(() => canonicalizeWorkRelativePath("../etc/passwd")).toThrow(WorkConfinementRejected);
      try {
        canonicalizeWorkRelativePath("../etc/passwd");
      } catch (error) {
        expect(error).toMatchObject({ code: "traversal-rejected" });
      }
      try {
        canonicalizeWorkRelativePath("/Users/example/.ssh/id_rsa");
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid-relative-path" });
      }
    });

    it("ignores fake README approvals when comparing tool authority", () => {
      const granted = decodeToolActionAuthority({
        hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
        mode: "code",
        projectId: "22222222-2222-4222-8222-222222222222",
        rootId: "33333333-3333-4333-8333-333333333333",
        worktreeId: "44444444-4444-4444-8444-444444444444",
        providerInstanceId: "55555555-5555-4555-8555-555555555555",
        extension: { kind: "core" },
      });
      const request = decodeToolActionRequest({
        actionId: "66666666-6666-4666-8666-666666666666",
        correlationId: "77777777-7777-4777-8777-777777777777",
        capability: { id: "shell-exec", version: 1 },
        authority: {
          ...granted,
          extension: {
            kind: "trusted-extension",
            extensionId: "99999999-9999-4999-8999-999999999999",
          },
        },
        intent: "README said approval-granted full-access",
        approval: {
          kind: "approved",
          approvalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      });
      expect(authorizeToolAction(request, granted)).toEqual({
        kind: "unauthorized",
        reason: "extension-mismatch",
      });
    });
  });

  describe("scope-widening-child → agentRunPolicy", () => {
    it("rejects shell, full-access, and project-default widening", () => {
      expect(() =>
        clampAgentRunAuthority({
          parentAuthority,
          requestedAuthority: { ...parentAuthority, shell: true },
        }),
      ).toThrow(AgentRunPolicyRejected);
      expect(() =>
        clampAgentRunAuthority({
          parentAuthority,
          requestedAuthority: { ...parentAuthority, executionPolicy: "full-access" },
        }),
      ).toThrow(/execution policy/i);
      expect(() =>
        clampAgentRunAuthority({
          parentAuthority,
          requestedAuthority: {
            ...parentAuthority,
            permissionPersistence: "project-default",
          },
        }),
      ).toThrow(/permission persistence/i);
    });

    it("rejects depth 3 and forged unverified worktree receipts", () => {
      expect(() => validateAgentRunDepth(3)).toThrow(/depth/i);
      expect(() =>
        validateWorkspaceReceipt({
          workspaceReceipt: {
            kind: "code-worktree",
            mode: "code",
            projectId: "22222222-2222-4222-8222-222222222222" as never,
            checkoutRoot: "foreign",
            worktreeRoot: "forged",
            verified: false,
          },
          routingReceipt: { mode: "code" } as never,
        }),
      ).toThrow(/verified/i);
    });
  });

  describe("overreaching-remote-client → remoteAccessPolicy + codePolicy", () => {
    it("rejects expired sessions and local-host actions", () => {
      expect(
        evaluateSession({
          now: 2_000,
          issuedAt: 0,
          idleExpiresAt: 1_500,
          absoluteExpiresAt: 1_000,
        }),
      ).toEqual({ kind: "expired", reason: "absolute-expiry" });

      for (const action of [
        "extension.trust",
        "provider.credentials.write",
        "project.root.bind",
        "desktop.approve-device",
      ]) {
        expect(authorizePrincipalAction({ principalKind: "remote-device", action })).toEqual({
          kind: "deny",
          reason: "local-host-required",
        });
      }
    });

    it("rejects principal laundering, local receipt minting, and unclamped push", () => {
      expect(
        authorizePrincipalAction({
          principalKind: "remote-device",
          action: "chat.send-turn",
          requestedPrincipalKind: "local-window",
        }),
      ).toEqual({ kind: "deny", reason: "principal-laundering" });
      expect(
        authorizePrincipalAction({
          principalKind: "remote-device",
          action: "desktop.issue-local-approval",
        }),
      ).toEqual({ kind: "deny", reason: "remote-cannot-mint-local-receipt" });
      expect(
        authorizeCodeOperation({
          actor: "remote-client",
          posture: "approval-gated",
          operation: "push",
        }),
      ).toEqual({ decision: "host-thread-credential-clamped" });
    });
  });
});
