import { describe, expect, it } from "vitest";
import { providerNativeSetupIsOn, resolveProviderNativeSetup } from "./providerNativeSetupPolicy";

const everything = {
  subagents: true,
  webTools: true,
  skills: true,
  toolServers: true,
  hooks: true,
  projectCode: true,
} as const;

describe("a key provider running as itself", () => {
  it("keeps every feature off at Guarded and Reviewed until the person turns it on", () => {
    for (const executionPolicy of ["approval-gated", "auto-accept-edits", "plan"] as const) {
      expect(
        resolveProviderNativeSetup({
          driverKind: "claude",
          mode: "code",
          executionPolicy,
          accountAllows: false,
          projectTrusts: false,
        }),
      ).toBeUndefined();
    }
  });

  it("turns its own setup on at Full access, with a Project's code only where the Project is trusted", () => {
    expect(
      resolveProviderNativeSetup({
        driverKind: "codex",
        mode: "work",
        executionPolicy: "full-access",
        accountAllows: false,
        projectTrusts: false,
      }),
    ).toEqual({ ...everything, projectCode: false });
    expect(
      resolveProviderNativeSetup({
        driverKind: "codex",
        mode: "code",
        executionPolicy: "full-access",
        accountAllows: false,
        projectTrusts: true,
      }),
    ).toEqual(everything);
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
    ).toEqual(everything);
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
    for (const driverKind of ["pi", "kimi-code", "ollama", "openai-compatible"] as const) {
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

  it("loads a thread's setup as the account switch would when the thread turned it on", () => {
    expect(
      resolveProviderNativeSetup({
        driverKind: "opencode",
        mode: "work",
        executionPolicy: "approval-gated",
        accountAllows: false,
        projectTrusts: false,
        threadChoice: "on",
      }),
    ).toEqual({ ...everything, projectCode: false });
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
