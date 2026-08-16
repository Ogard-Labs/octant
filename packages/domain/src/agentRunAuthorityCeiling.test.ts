import { describe, expect, it } from "vitest";
import type { OctantMode } from "@octant/contracts";
import { defaultAgentRunAuthorityCeilingForMode } from "./agentRunAuthorityCeiling";

describe("defaultAgentRunAuthorityCeilingForMode", () => {
  it("keeps chat research-only with no implicit filesystem/shell/network authority", () => {
    const ceiling = defaultAgentRunAuthorityCeilingForMode("chat");
    expect(ceiling.filesystem).toBe(false);
    expect(ceiling.shell).toBe(false);
    expect(ceiling.git).toBe(false);
    expect(ceiling.network).toBe(false);
    expect(ceiling.executionPolicy).toBe("plan");
  });

  it("confines work to the project root without shell/git authority", () => {
    const ceiling = defaultAgentRunAuthorityCeilingForMode("work");
    expect(ceiling.filesystem).toBe(true);
    expect(ceiling.shell).toBe(false);
    expect(ceiling.git).toBe(false);
    expect(ceiling.executionPolicy).toBe("approval-gated");
  });

  it("grants code the widest absolute ceiling, including full-access as the upper bound", () => {
    const ceiling = defaultAgentRunAuthorityCeilingForMode("code");
    expect(ceiling.filesystem).toBe(true);
    expect(ceiling.shell).toBe(true);
    expect(ceiling.git).toBe(true);
    expect(ceiling.network).toBe(true);
    expect(ceiling.executionPolicy).toBe("full-access");
  });

  it("never grants a persisted (project-default) permission persistence ceiling", () => {
    for (const mode of ["chat", "work", "code"] satisfies ReadonlyArray<OctantMode>) {
      expect(defaultAgentRunAuthorityCeilingForMode(mode).permissionPersistence).toBe(
        "current-session",
      );
    }
  });

  it("is a pure function returning a fresh object each call", () => {
    const a = defaultAgentRunAuthorityCeilingForMode("chat");
    const b = defaultAgentRunAuthorityCeilingForMode("chat");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
