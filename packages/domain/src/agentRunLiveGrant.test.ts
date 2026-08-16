import { describe, expect, it } from "vitest";
import type { AgentRunAuthority } from "@octant/contracts";
import { AgentRunPolicyRejected } from "./agentRunPolicy";
import {
  clampAgentRunAuthorityFromLiveGrantFacts,
  resolveAgentRunLiveParentGrant,
} from "./agentRunLiveGrant";

const chatLiveFacts = {
  mode: "chat" as const,
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: true,
  executionPolicy: "plan" as const,
  permissionPersistence: "current-session" as const,
};

describe("resolveAgentRunLiveParentGrant", () => {
  it("returns the mode ceiling when live facts match it", () => {
    const grant = resolveAgentRunLiveParentGrant(chatLiveFacts);
    expect(grant).toEqual({
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: true,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    });
  });

  it("narrows below the mode ceiling when live facts revoke a capability", () => {
    const grant = resolveAgentRunLiveParentGrant({
      ...chatLiveFacts,
      tools: false,
      subagents: false,
    });
    expect(grant.tools).toBe(false);
    expect(grant.subagents).toBe(false);
  });

  it("rejects live facts that claim shell under Chat", () => {
    expect(() =>
      resolveAgentRunLiveParentGrant({
        ...chatLiveFacts,
        shell: true,
      }),
    ).toThrow(AgentRunPolicyRejected);
  });
});

describe("clampAgentRunAuthorityFromLiveGrantFacts", () => {
  const requested: AgentRunAuthority = {
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: true,
    subagents: false,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  };

  it("admits a request inside the live grant", () => {
    const clamped = clampAgentRunAuthorityFromLiveGrantFacts({
      facts: chatLiveFacts,
      requestedAuthority: requested,
    });
    expect(clamped.tools).toBe(true);
    expect(clamped.network).toBe(false);
  });

  it("rejects a request that exceeds a narrowed live grant even when under the mode ceiling", () => {
    expect(() =>
      clampAgentRunAuthorityFromLiveGrantFacts({
        facts: { ...chatLiveFacts, tools: false },
        requestedAuthority: requested,
      }),
    ).toThrow(/tools|authority-widening/i);
  });

  it("keeps Code live grants approval-gated unless full-access is the live fact", () => {
    const codeFacts = {
      mode: "code" as const,
      filesystem: true,
      shell: true,
      git: true,
      network: true,
      tools: true,
      subagents: true,
      executionPolicy: "approval-gated" as const,
      permissionPersistence: "current-session" as const,
    };
    const clamped = clampAgentRunAuthorityFromLiveGrantFacts({
      facts: codeFacts,
      requestedAuthority: {
        filesystem: true,
        shell: true,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
      },
    });
    expect(clamped.executionPolicy).toBe("approval-gated");
    expect(clamped.git).toBe(false);
  });
});
