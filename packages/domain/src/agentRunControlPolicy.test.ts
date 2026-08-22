import { describe, expect, it } from "vitest";
import type { AgentRun, AgentRunAuthority, OctantMode } from "@octant/contracts";
import {
  AgentRunPolicyRejected,
  allowedAgentRunRolesForMode,
  assertAgentRunResumeAllowed,
  assertAgentRunRetryAllowed,
  assertAgentRunRoleAllowedForMode,
  assertAgentRunSteerAllowed,
  deriveAgentRunRequestedAuthority,
  isAgentRunRoleAllowedForMode,
  selectAgentRunExecutionKind,
} from "./agentRunControlPolicy";
import { defaultAgentRunAuthorityCeilingForMode } from "./agentRunAuthorityCeiling";

const liveChat: AgentRunAuthority = defaultAgentRunAuthorityCeilingForMode("chat");
const liveWork: AgentRunAuthority = defaultAgentRunAuthorityCeilingForMode("work");
const liveCode: AgentRunAuthority = {
  ...defaultAgentRunAuthorityCeilingForMode("code"),
  executionPolicy: "approval-gated",
};

function run(status: AgentRun["lifecycleStatus"], version = 3): AgentRun {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
    parentThreadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
    depth: 0,
    role: "research",
    task: "Summarize the notes.",
    creationPosture: "automatic",
    executionKind: "octant-managed",
    lifecycleStatus: status,
    authority: liveChat,
    routingReceipt: {
      executionResolution: {
        providerInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
        modelId: "gpt-4o" as never,
        hostId: "local" as never,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
        effectivePermissions: {
          filesystem: false,
          shell: false,
          git: false,
          network: false,
          tools: true,
          subagents: true,
        },
        source: "one-off-override",
        fallbackChain: ["one-off-override"],
        downgradeReasons: [],
      },
      selectedExecutionKind: "octant-managed",
      attemptedExecutionKind: "provider-native",
      selectedProviderInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
      selectedModelId: "gpt-4o" as never,
      fallbackCandidates: [],
      capabilityDegradations: [],
      contextSnapshotId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as never,
      effectiveAuthorityDigest: "digest",
      usageQuality: "unavailable",
      hostId: "local" as never,
      mode: "chat",
    },
    workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: version as never,
    createdAt: "2026-08-01T15:00:00.000Z" as never,
    updatedAt: "2026-08-01T15:00:00.000Z" as never,
  };
}

describe("mode-valid AgentRun roles", () => {
  it("keeps Chat children research-only", () => {
    expect(allowedAgentRunRolesForMode("chat")).toEqual(["research"]);
    expect(isAgentRunRoleAllowedForMode("chat", "research")).toBe(true);
    expect(isAgentRunRoleAllowedForMode("chat", "implementation")).toBe(false);
    expect(isAgentRunRoleAllowedForMode("chat", "review")).toBe(false);
    expect(() => assertAgentRunRoleAllowedForMode("chat", "implementation")).toThrow(
      AgentRunPolicyRejected,
    );
  });

  it("offers Research, Implement, and Review inside a Work root", () => {
    expect(allowedAgentRunRolesForMode("work")).toEqual(["research", "implementation", "review"]);
    for (const role of allowedAgentRunRolesForMode("work")) {
      expect(() => assertAgentRunRoleAllowedForMode("work", role)).not.toThrow();
    }
  });

  it("limits Code children to Implement and Review so they can use isolated worktrees", () => {
    expect(allowedAgentRunRolesForMode("code")).toEqual(["implementation", "review"]);
    expect(isAgentRunRoleAllowedForMode("code", "research")).toBe(false);
    expect(() => assertAgentRunRoleAllowedForMode("code", "research")).toThrow(
      AgentRunPolicyRejected,
    );
  });
});

describe("server-derived child authority", () => {
  it("requests the live parent grant and never widens past the mode ceiling", () => {
    expect(deriveAgentRunRequestedAuthority({ mode: "chat", liveParentGrant: liveChat })).toEqual(
      liveChat,
    );
    expect(deriveAgentRunRequestedAuthority({ mode: "work", liveParentGrant: liveWork })).toEqual(
      liveWork,
    );
    expect(deriveAgentRunRequestedAuthority({ mode: "code", liveParentGrant: liveCode })).toEqual(
      liveCode,
    );
  });

  it("refuses a live grant that claims more than the mode allows", () => {
    expect(() =>
      deriveAgentRunRequestedAuthority({
        mode: "chat",
        liveParentGrant: { ...liveChat, filesystem: true },
      }),
    ).toThrow(AgentRunPolicyRejected);
  });
});

describe("provider-native child execution eligibility", () => {
  const complete = {
    claimedNativeSupport: "supported" as const,
    workspace: true,
    authority: true,
    observability: true,
    cancellation: true,
    steering: true,
    recovery: true,
  };

  it("selects provider-native only when every required capability is evidenced", () => {
    const selected = selectAgentRunExecutionKind(complete);
    expect(selected.selectedExecutionKind).toBe("provider-native");
    expect(selected.attemptedExecutionKind).toBe("provider-native");
    expect(selected.nativeFallbackReason).toBeUndefined();
    expect(selected.capabilityDegradations).toEqual([]);
  });

  it("falls back to Octant-managed with an explicit reason when native evidence is missing", () => {
    const selected = selectAgentRunExecutionKind({
      ...complete,
      claimedNativeSupport: "unsupported",
      steering: false,
      recovery: false,
    });
    expect(selected.selectedExecutionKind).toBe("octant-managed");
    expect(selected.attemptedExecutionKind).toBe("provider-native");
    expect(selected.nativeFallbackReason).toMatch(/nativeChildAgents/i);
    expect(selected.nativeFallbackReason).toMatch(/steering/);
    expect(selected.capabilityDegradations).toContain("native-child-agents-unavailable");
  });

  it("names each missing guarantee rather than silently choosing native", () => {
    const selected = selectAgentRunExecutionKind({
      claimedNativeSupport: "supported",
      workspace: false,
      authority: true,
      observability: false,
      cancellation: true,
      steering: false,
      recovery: true,
    });
    expect(selected.selectedExecutionKind).toBe("octant-managed");
    expect(selected.rejectedNativeReasons).toEqual([
      "missing-guarantee:workspace",
      "missing-guarantee:observability",
      "missing-guarantee:steering",
    ]);
  });
});

describe("steer, retry, and resume authorization", () => {
  it("allows steering a live child at the expected version and refuses a stale one", () => {
    expect(() => assertAgentRunSteerAllowed(run("running"), 3 as never)).not.toThrow();
    expect(() => assertAgentRunSteerAllowed(run("waiting"), 3 as never)).not.toThrow();
    expect(() => assertAgentRunSteerAllowed(run("running"), 2 as never)).toThrow(
      /Expected version 2/,
    );
    expect(() => assertAgentRunSteerAllowed(run("completed"), 3 as never)).toThrow(
      AgentRunPolicyRejected,
    );
  });

  it("allows retry of failed or interrupted children and refuses completed ones", () => {
    expect(() => assertAgentRunRetryAllowed(run("failed"), 3 as never)).not.toThrow();
    expect(() => assertAgentRunRetryAllowed(run("interrupted"), 3 as never)).not.toThrow();
    expect(() => assertAgentRunRetryAllowed(run("cancelled"), 3 as never)).toThrow(
      AgentRunPolicyRejected,
    );
    expect(() => assertAgentRunRetryAllowed(run("running"), 3 as never)).toThrow(
      AgentRunPolicyRejected,
    );
  });

  it("resumes a waiting child and refuses a restart interruption that has no resume evidence", () => {
    expect(() => assertAgentRunResumeAllowed(run("waiting"), 3 as never)).not.toThrow();
    expect(() =>
      assertAgentRunResumeAllowed(
        { ...run("interrupted"), recoveryReason: "provider-session-resumable" },
        3 as never,
      ),
    ).not.toThrow();
    expect(() =>
      assertAgentRunResumeAllowed(
        { ...run("interrupted"), recoveryReason: "restart-without-resumable-execution" },
        3 as never,
      ),
    ).toThrow(AgentRunPolicyRejected);
  });
});

describe("role labels the creation surface may show", () => {
  it("names Research, Implement, and Review without exposing custom in this control flow", () => {
    const modes: ReadonlyArray<OctantMode> = ["chat", "work", "code"];
    for (const mode of modes) {
      expect(allowedAgentRunRolesForMode(mode)).not.toContain("custom");
    }
  });
});
