import { describe, expect, it } from "vitest";
import {
  accountKeepsOwnMemory,
  providerNativeSetupIsOn,
  planReadOnlyToolServers,
  providerOwnMemoryLaunches,
  resolveProviderNativeSetup,
  providerRunsAsItself,
} from "./providerNativeSetupPolicy";

const everything = {
  subagents: true,
  webTools: true,
  skills: true,
  toolServers: true,
  hooks: true,
  projectCode: true,
} as const;

describe("a key provider running as itself", () => {
  it("keeps the runtime's own web search and fetch off in Work and Code for an account the person turned off", () => {
    for (const mode of ["work", "code"] as const) {
      for (const executionPolicy of ["approval-gated", "auto-accept-edits", "plan"] as const) {
        expect(
          resolveProviderNativeSetup({
            driverKind: "claude",
            mode,
            executionPolicy,
            accountAllows: false,
            projectTrusts: false,
          }),
        ).toBeUndefined();
      }
    }
    expect(
      resolveProviderNativeSetup({
        driverKind: "codex",
        mode: "chat",
        executionPolicy: "approval-gated",
        accountAllows: false,
        projectTrusts: false,
      }),
    ).toBeUndefined();
  });

  it("keeps the runtime's own web search and fetch on in Work and Code for an account running as itself", () => {
    for (const mode of ["work", "code"] as const) {
      for (const executionPolicy of [
        "approval-gated",
        "auto-accept-edits",
        "full-access",
      ] as const) {
        const setup = resolveProviderNativeSetup({
          driverKind: "claude",
          mode,
          executionPolicy,
          accountAllows: true,
          projectTrusts: false,
        });
        expect(setup?.webTools).toBe(true);
      }
    }
  });

  it("turns the rest of its own setup on at Full access, with a Project's code only where the Project is trusted", () => {
    expect(
      resolveProviderNativeSetup({
        driverKind: "codex",
        mode: "work",
        executionPolicy: "full-access",
        accountAllows: false,
        projectTrusts: false,
      }),
    ).toEqual({ ...everything, webTools: false, projectCode: false });
    expect(
      resolveProviderNativeSetup({
        driverKind: "codex",
        mode: "code",
        executionPolicy: "full-access",
        accountAllows: false,
        projectTrusts: true,
      }),
    ).toEqual({ ...everything, webTools: false });
  });

  it("loads the account's setup when the account allows it and the Project's code only when trusted", () => {
    expect(
      resolveProviderNativeSetup({
        driverKind: "opencode",
        mode: "code",
        executionPolicy: "approval-gated",
        accountAllows: true,
        projectTrusts: false,
      }),
    ).toEqual({ ...everything, projectCode: false });
    expect(
      resolveProviderNativeSetup({
        driverKind: "mistral-vibe",
        mode: "code",
        executionPolicy: "approval-gated",
        accountAllows: false,
        projectTrusts: true,
      }),
    ).toEqual({ ...everything, webTools: false });
  });

  it("loads an added Project's code outside Strict without turning on an account the person turned off", () => {
    expect(
      resolveProviderNativeSetup({
        driverKind: "claude",
        mode: "code",
        executionPolicy: "approval-gated",
        accountAllows: true,
        projectTrusts: false,
        projectAddedTrusts: true,
      }),
    ).toEqual(everything);
    expect(
      resolveProviderNativeSetup({
        driverKind: "claude",
        mode: "work",
        executionPolicy: "approval-gated",
        accountAllows: false,
        projectTrusts: false,
        projectAddedTrusts: true,
      }),
    ).toBeUndefined();
    expect(
      resolveProviderNativeSetup({
        driverKind: "codex",
        mode: "code",
        executionPolicy: "plan",
        accountAllows: true,
        projectTrusts: false,
        projectAddedTrusts: true,
      })?.projectCode,
    ).toBe(false);
    expect(
      resolveProviderNativeSetup({
        driverKind: "codex",
        mode: "chat",
        executionPolicy: "approval-gated",
        accountAllows: true,
        projectTrusts: false,
        projectAddedTrusts: true,
      })?.projectCode,
    ).toBe(false);
  });

  it("never runs hooks, tool servers, or a Project's code in Plan, which stays read-only", () => {
    expect(
      resolveProviderNativeSetup({
        driverKind: "claude",
        mode: "code",
        executionPolicy: "plan",
        accountAllows: true,
        projectTrusts: true,
      }),
    ).toEqual({
      subagents: true,
      webTools: true,
      skills: true,
      toolServers: false,
      hooks: false,
      projectCode: false,
    });
  });

  it("keeps Chat's filesystem and shell withheld: tool servers yes, hooks and Project code never", () => {
    expect(
      resolveProviderNativeSetup({
        driverKind: "codex",
        mode: "chat",
        executionPolicy: "approval-gated",
        accountAllows: true,
        projectTrusts: true,
      }),
    ).toEqual({
      subagents: true,
      webTools: true,
      skills: true,
      toolServers: true,
      hooks: false,
      projectCode: false,
    });
    // A Chat thread is never Full access, and a Project's trust does not reach it.
    expect(
      resolveProviderNativeSetup({
        driverKind: "codex",
        mode: "chat",
        executionPolicy: "full-access",
        accountAllows: false,
        projectTrusts: true,
      }),
    ).toBeUndefined();
  });

  it("gives every provider that is not a key provider nothing, at every level", () => {
    for (const driverKind of ["pi", "ollama", "openai-compatible"] as const) {
      expect(
        resolveProviderNativeSetup({
          driverKind,
          mode: "code",
          executionPolicy: "full-access",
          accountAllows: true,
          projectTrusts: true,
        }),
      ).toBeUndefined();
    }
    expect(providerNativeSetupIsOn(undefined)).toBe(false);
    expect(providerNativeSetupIsOn(everything)).toBe(true);
  });

  it("keeps everything unloaded for a thread that turned it off, even at Full access", () => {
    expect(
      resolveProviderNativeSetup({
        driverKind: "claude",
        mode: "code",
        executionPolicy: "full-access",
        accountAllows: true,
        projectTrusts: true,
        threadChoice: "off",
      }),
    ).toBeUndefined();
  });

  it("keeps the web tools off for a thread that turned them off while its account runs as itself", () => {
    for (const mode of ["work", "code"] as const) {
      expect(
        resolveProviderNativeSetup({
          driverKind: "claude",
          mode,
          executionPolicy: "approval-gated",
          accountAllows: true,
          projectTrusts: false,
          threadChoice: "off",
        }),
      ).toBeUndefined();
    }
  });

  it("loads a thread's setup as the account switch would when the thread turned it on, without the web tools of an account turned off", () => {
    expect(
      resolveProviderNativeSetup({
        driverKind: "opencode",
        mode: "work",
        executionPolicy: "approval-gated",
        accountAllows: false,
        projectTrusts: false,
        threadChoice: "on",
      }),
    ).toEqual({ ...everything, webTools: false, projectCode: false });
  });

  it("never loads a Project's own code for a thread that turned it on in an untrusted Project", () => {
    const setup = resolveProviderNativeSetup({
      driverKind: "mistral-vibe",
      mode: "code",
      executionPolicy: "full-access",
      accountAllows: false,
      projectTrusts: false,
      threadChoice: "on",
    });
    expect(setup?.projectCode).toBe(false);
  });

  it("does not let a thread turn on another provider's setup", () => {
    expect(
      resolveProviderNativeSetup({
        driverKind: "pi",
        mode: "code",
        executionPolicy: "approval-gated",
        accountAllows: false,
        projectTrusts: false,
        threadChoice: "on",
      }),
    ).toBeUndefined();
  });
});

describe("a provider's own memory", () => {
  it("is on for an account the person never turned off, and off once they did", () => {
    expect(accountKeepsOwnMemory({})).toBe(true);
    // An earlier default stored the person's on as `true`.
    expect(accountKeepsOwnMemory({ ownMemory: true })).toBe(true);
    expect(accountKeepsOwnMemory({ ownMemory: false })).toBe(false);
  });

  it("launches in Work and Code unless the person turned the account's setting off", () => {
    for (const memoryWrites of ["session-tools", "background"] as const) {
      for (const mode of ["work", "code"] as const) {
        for (const executionPolicy of [
          "approval-gated",
          "auto-accept-edits",
          "full-access",
        ] as const) {
          expect(
            providerOwnMemoryLaunches({ accountAllows: true, mode, executionPolicy, memoryWrites }),
          ).toBe(true);
          // Full access turns the provider's own setup on, never its memory.
          expect(
            providerOwnMemoryLaunches({
              accountAllows: false,
              mode,
              executionPolicy,
              memoryWrites,
            }),
          ).toBe(false);
        }
      }
    }
  });

  it("loads a memory only its session tools write in Plan and Chat, read-only", () => {
    const memoryWrites = "session-tools";
    for (const mode of ["chat", "work", "code"] as const) {
      expect(
        providerOwnMemoryLaunches({
          accountAllows: true,
          mode,
          executionPolicy: "plan",
          memoryWrites,
        }),
      ).toBe(true);
    }
    expect(
      providerOwnMemoryLaunches({
        accountAllows: true,
        mode: "chat",
        executionPolicy: "approval-gated",
        memoryWrites,
      }),
    ).toBe(true);
    // The person's own switch still decides there.
    expect(
      providerOwnMemoryLaunches({
        accountAllows: false,
        mode: "chat",
        executionPolicy: "approval-gated",
        memoryWrites,
      }),
    ).toBe(false);
  });

  it("keeps a memory the runtime writes in the background off in Plan and Chat, and for a session that names no mode", () => {
    const memoryWrites = "background";
    expect(
      providerOwnMemoryLaunches({
        accountAllows: true,
        mode: "code",
        executionPolicy: "plan",
        memoryWrites,
      }),
    ).toBe(false);
    expect(
      providerOwnMemoryLaunches({
        accountAllows: true,
        mode: "chat",
        executionPolicy: "approval-gated",
        memoryWrites,
      }),
    ).toBe(false);
    for (const writes of ["session-tools", "background"] as const) {
      expect(
        providerOwnMemoryLaunches({
          accountAllows: true,
          mode: undefined,
          executionPolicy: "approval-gated",
          memoryWrites: writes,
        }),
      ).toBe(false);
    }
  });
});

describe("the provider's own MCP servers in Plan", () => {
  it("starts only the servers the person marked, and none where the account runs nothing of its own", () => {
    const planSetup = resolveProviderNativeSetup({
      driverKind: "claude",
      mode: "code",
      executionPolicy: "plan",
      accountAllows: true,
      projectTrusts: false,
    });
    // Plan leaves the account's tool servers off; the mark lets one back in.
    expect(planSetup?.toolServers).toBe(false);
    expect(
      planReadOnlyToolServers({
        executionPolicy: "plan",
        setup: planSetup,
        marked: ["docs-search", "docs-search"],
      }),
    ).toEqual(["docs-search"]);
    // An unmarked server stays withheld: nothing marked, nothing started.
    expect(
      planReadOnlyToolServers({ executionPolicy: "plan", setup: planSetup, marked: [] }),
    ).toEqual([]);
    // An account turned off loads none of its setup, marks included.
    expect(
      planReadOnlyToolServers({
        executionPolicy: "plan",
        setup: undefined,
        marked: ["docs-search"],
      }),
    ).toEqual([]);
    // Outside Plan the setup decides as before.
    expect(
      planReadOnlyToolServers({
        executionPolicy: "approval-gated",
        setup: everything,
        marked: ["docs-search"],
      }),
    ).toEqual([]);
  });
});
