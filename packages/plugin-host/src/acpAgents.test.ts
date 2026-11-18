import { describe, expect, it } from "vitest";
import {
  ACP_AGENT_DISCOVERED,
  ACP_REGISTRY_AGENTS,
  acpAgentCommandRefusal,
  acpAgentEnableRefusal,
  addRegistryAcpAgent,
  decideAcpAgentLaunch,
} from "./acpAgents";

const levels = ["approval-gated", "auto-accept-edits", "plan", "full-access"] as const;

describe("adding any ACP agent", () => {
  it("lets an agent found in the registry start nothing until the person installs and enables it", () => {
    for (const executionPolicy of levels) {
      for (const strict of [true, false]) {
        expect(
          decideAcpAgentLaunch({ steps: ACP_AGENT_DISCOVERED, executionPolicy, strict }),
        ).toEqual({ status: "refused", reason: "not-installed" });
      }
    }
    const cursor = ACP_REGISTRY_AGENTS.find((agent) => agent.registryId === "cursor");
    const added = addRegistryAcpAgent(cursor!, "/Users/me/.local/bin/cursor-agent");
    expect(added).toMatchObject({
      status: "added",
      steps: { installed: true, trusted: false, enabled: false },
    });
    if (added.status !== "added") return;
    expect(
      decideAcpAgentLaunch({ steps: added.steps, executionPolicy: "full-access", strict: false }),
    ).toEqual({ status: "refused", reason: "disabled" });
  });

  it("starts an enabled agent the person has not trusted in Octant's sandbox at every level, remembering nothing", () => {
    const steps = { installed: true, trusted: false, enabled: true };
    for (const executionPolicy of levels) {
      for (const strict of [true, false]) {
        expect(decideAcpAgentLaunch({ steps, executionPolicy, strict })).toEqual({
          status: "starts",
          sandbox: "octant",
          remembers: false,
        });
      }
    }
  });

  it("lifts Octant's sandbox from a trusted agent outside Strict below Full access, and keeps it under Strict and in Plan", () => {
    const steps = { installed: true, trusted: true, enabled: true };
    expect(
      decideAcpAgentLaunch({ steps, executionPolicy: "approval-gated", strict: false }),
    ).toEqual({ status: "starts", sandbox: "own", remembers: true });
    expect(
      decideAcpAgentLaunch({ steps, executionPolicy: "approval-gated", strict: true }),
    ).toEqual({ status: "starts", sandbox: "octant", remembers: true });
    // A launch that never resolved Strict keeps Octant's sandbox.
    expect(decideAcpAgentLaunch({ steps, executionPolicy: "auto-accept-edits" })).toMatchObject({
      sandbox: "octant",
    });
    expect(decideAcpAgentLaunch({ steps, executionPolicy: "plan", strict: false })).toMatchObject({
      sandbox: "octant",
    });
    expect(decideAcpAgentLaunch({ steps, executionPolicy: "full-access", strict: true })).toEqual({
      status: "starts",
      sandbox: "none",
      remembers: true,
    });
  });

  it("refuses to enable an agent before it is installed and trusted", () => {
    expect(acpAgentEnableRefusal(ACP_AGENT_DISCOVERED)).toBe("not-installed");
    expect(acpAgentEnableRefusal({ installed: true, trusted: false, enabled: false })).toBe(
      "not-trusted",
    );
    expect(
      acpAgentEnableRefusal({ installed: true, trusted: true, enabled: false }),
    ).toBeUndefined();
  });

  it("lists every registry distribution at an exact release, binaries over HTTPS only", () => {
    for (const agent of ACP_REGISTRY_AGENTS) {
      const distribution = agent.distribution;
      if (distribution.kind === "binary") {
        expect(new URL(distribution.archive).protocol).toBe("https:");
        expect(distribution.command.startsWith("/")).toBe(false);
        if (distribution.sha256 !== undefined)
          expect(distribution.sha256).toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(distribution.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(distribution.package).not.toContain("@" + distribution.version);
      }
    }
  });

  it("refuses a command that is not an absolute path or carries control characters", () => {
    expect(acpAgentCommandRefusal({ command: "my-agent", args: [] })).toBe("not-absolute");
    expect(acpAgentCommandRefusal({ command: "/opt/agent", args: ["acp\n--yolo"] })).toBe(
      "control-character",
    );
    expect(acpAgentCommandRefusal({ command: "/opt/agent", args: ["acp"] })).toBeUndefined();
    for (const secret of ["--api-key=sk-1", "--token", "-password", "OPENAI_API_KEY=sk-1"]) {
      expect(acpAgentCommandRefusal({ command: "/opt/agent", args: ["acp", secret] })).toBe(
        "secret-argument",
      );
    }
    expect(
      acpAgentCommandRefusal({ command: "/opt/agent", args: ["--agent-engine=v3", "--acp=true"] }),
    ).toBeUndefined();
    const auggie = ACP_REGISTRY_AGENTS.find((agent) => agent.registryId === "auggie");
    expect(addRegistryAcpAgent(auggie!, "auggie")).toEqual({
      status: "refused",
      reason: "not-absolute",
    });
  });
});
