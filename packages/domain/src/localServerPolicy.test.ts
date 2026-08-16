import { describe, expect, it } from "vitest";
import {
  authorizeLocalServerAction,
  classifyLocalListener,
  describeLocalServerStopDenial,
  LOCAL_SERVER_SYSTEM_DENYLIST,
  type LocalListenerClassificationContext,
  type LocalListenerObservation,
} from "./localServerPolicy";

const context: LocalListenerClassificationContext = {
  currentCheckoutRoot: "/Users/example/code/octant",
  userProjectRoots: ["/Users/example/code/octant", "/Users/example/code/other-app"],
};

function observation(overrides: Partial<LocalListenerObservation>): LocalListenerObservation {
  return {
    processName: "node",
    ownership: "current-user",
    ...overrides,
  };
}

describe("local server classification", () => {
  it("lists a known framework even with no cwd", () => {
    const result = classifyLocalListener(
      observation({ commandName: "/usr/local/bin/vite" }),
      context,
    );
    expect(result).toMatchObject({ status: "listed", framework: "vite", attribution: "other" });
  });

  it("lists Next, Astro, Expo, and FastAPI style listeners", () => {
    for (const [command, framework] of [
      ["next-server", "next"],
      ["astro", "astro"],
      ["expo", "expo"],
      ["uvicorn", "uvicorn"],
    ] as const) {
      expect(classifyLocalListener(observation({ commandName: command }), context)).toMatchObject({
        status: "listed",
        framework,
      });
    }
  });

  it("lists an interpreter whose cwd is the current checkout and attributes it first", () => {
    const result = classifyLocalListener(
      observation({ workingDirectory: "/Users/example/code/octant/apps/web" }),
      context,
    );
    expect(result).toMatchObject({ status: "listed", attribution: "current-checkout" });
  });

  it("lists an interpreter with editor lineage as a leftover with its start source", () => {
    for (const [ancestor, startSource] of [
      ["Visual Studio Code", "vscode"],
      ["claude", "claude"],
      ["codex", "codex"],
      ["Octant", "octant"],
      ["Cursor", "other-editor"],
    ] as const) {
      expect(classifyLocalListener(observation({ lineage: [ancestor] }), context)).toMatchObject({
        status: "listed",
        startSource,
        attribution: "other",
      });
    }
  });

  it("omits an uncertain interpreter with neither project cwd nor editor parent", () => {
    expect(classifyLocalListener(observation({}), context)).toEqual({
      status: "omitted",
      reason: "unclassified",
    });
    expect(
      classifyLocalListener(observation({ workingDirectory: "/opt/homebrew/var" }), context),
    ).toEqual({ status: "omitted", reason: "unclassified" });
  });

  it("omits root, other-user, and denylisted system listeners", () => {
    expect(
      classifyLocalListener(observation({ processName: "postgres", ownership: "root" }), context),
    ).toEqual({ status: "omitted", reason: "not-current-user" });
    expect(
      classifyLocalListener(observation({ processName: "node", ownership: "other-user" }), context),
    ).toEqual({ status: "omitted", reason: "not-current-user" });
    for (const denied of ["sshd", "launchd", "Docker Desktop", "mDNSResponder"]) {
      expect(classifyLocalListener(observation({ processName: denied }), context)).toEqual({
        status: "omitted",
        reason: "system-denylisted",
      });
    }
  });

  it("keeps the documented system denylist entries", () => {
    for (const entry of ["launchd", "kernel_task", "sshd", "securityd", "Docker Desktop"]) {
      expect(LOCAL_SERVER_SYSTEM_DENYLIST.has(entry)).toBe(true);
    }
  });
});

describe("local server authority matrix", () => {
  it("lets every actor and posture list", () => {
    for (const actor of ["local-user", "agent", "remote-client"] as const) {
      for (const posture of ["plan", "approval-gated", "full-access"] as const) {
        expect(authorizeLocalServerAction({ action: "list", actor, posture })).toEqual({
          kind: "allow",
        });
      }
    }
  });

  it("lets Plan list and open but never stop", () => {
    expect(
      authorizeLocalServerAction({ action: "open", actor: "local-user", posture: "plan" }),
    ).toEqual({ kind: "allow" });
    for (const ownership of ["octant-owned", "leftover"] as const) {
      expect(
        authorizeLocalServerAction({
          action: "stop",
          actor: "local-user",
          posture: "plan",
          ownership,
        }),
      ).toEqual({ kind: "deny", reason: "plan-read-only" });
    }
  });

  it("stops an Octant-owned server without leftover confirmation", () => {
    expect(
      authorizeLocalServerAction({
        action: "stop",
        actor: "local-user",
        posture: "approval-gated",
        ownership: "octant-owned",
      }),
    ).toEqual({ kind: "allow" });
  });

  it("confirms a local-user leftover stop and prompts an agent even under full access", () => {
    expect(
      authorizeLocalServerAction({
        action: "stop",
        actor: "local-user",
        posture: "full-access",
        ownership: "leftover",
      }),
    ).toEqual({ kind: "confirm" });
    expect(
      authorizeLocalServerAction({
        action: "stop",
        actor: "agent",
        posture: "full-access",
        ownership: "leftover",
      }),
    ).toEqual({ kind: "prompt" });
  });

  it("denies a remote leftover stop as local-host-required and allows owned stop", () => {
    expect(
      authorizeLocalServerAction({
        action: "stop",
        actor: "remote-client",
        posture: "full-access",
        ownership: "leftover",
      }),
    ).toEqual({ kind: "deny", reason: "local-host-required" });
    expect(
      authorizeLocalServerAction({
        action: "stop",
        actor: "remote-client",
        posture: "full-access",
        ownership: "octant-owned",
      }),
    ).toEqual({ kind: "allow" });
  });

  it("fails closed for an unclassified target before any ownership question", () => {
    expect(
      authorizeLocalServerAction({
        action: "stop",
        actor: "local-user",
        posture: "full-access",
        ownership: "octant-owned",
        classified: false,
      }),
    ).toEqual({ kind: "deny", reason: "unclassified" });
    expect(
      authorizeLocalServerAction({
        action: "open",
        actor: "local-user",
        posture: "full-access",
        classified: false,
      }),
    ).toEqual({ kind: "deny", reason: "unclassified" });
  });

  it("states every denial in words", () => {
    for (const reason of ["plan-read-only", "local-host-required", "unclassified"] as const) {
      expect(describeLocalServerStopDenial({ kind: "deny", reason }).length).toBeGreaterThan(10);
    }
  });
});
