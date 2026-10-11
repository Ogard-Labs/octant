import { describe, expect, it } from "vitest";
import { decodeProviderInstanceId, type ProviderInstance } from "@octant/contracts";
import {
  assignedProviderAccountDirectory,
  CLAUDE_ACCOUNT_PROFILE,
  CODEX_ACCOUNT_PROFILE,
  defaultProviderAccountDirectory,
  formatProviderAccountSignInCommand,
  formatProviderAccountStatusCommand,
  isAssignedProviderAccountDirectory,
  providerAccountAccent,
  providerAccountProfile,
} from "./providerAccountProfile";

const instanceId = decodeProviderInstanceId("11111111-1111-4111-8111-111111111111");

describe("provider account profile", () => {
  it("declares Claude and Codex as the multi-account drivers", () => {
    expect(providerAccountProfile("claude")).toEqual(CLAUDE_ACCOUNT_PROFILE);
    expect(providerAccountProfile("codex")).toEqual(CODEX_ACCOUNT_PROFILE);
    expect(CLAUDE_ACCOUNT_PROFILE.supportsMultipleAccounts).toBe(true);
    expect(CODEX_ACCOUNT_PROFILE.supportsMultipleAccounts).toBe(true);
    expect(providerAccountProfile("opencode")).toBeUndefined();
  });

  it("assigns extra Claude accounts under ~/.claude-accounts/<instanceId>", () => {
    expect(
      assignedProviderAccountDirectory(CLAUDE_ACCOUNT_PROFILE, "/Users/example/", instanceId),
    ).toBe(`/Users/example/.claude-accounts/${instanceId}`);
    expect(defaultProviderAccountDirectory(CLAUDE_ACCOUNT_PROFILE, "/Users/example")).toBe(
      "/Users/example/.claude",
    );
  });

  it("formats the unmodified Claude sign-in and status commands", () => {
    expect(
      formatProviderAccountSignInCommand({
        profile: CLAUDE_ACCOUNT_PROFILE,
        binaryPath: "/opt/homebrew/bin/claude",
      }),
    ).toBe("'/opt/homebrew/bin/claude' auth login");
    expect(
      formatProviderAccountSignInCommand({
        profile: CLAUDE_ACCOUNT_PROFILE,
        binaryPath: "/opt/homebrew/bin/claude",
        stateDirectory: `/Users/example/.claude-accounts/${instanceId}`,
      }),
    ).toBe(
      `CLAUDE_CONFIG_DIR='/Users/example/.claude-accounts/${instanceId}' CLAUDE_SECURESTORAGE_CONFIG_DIR='/Users/example/.claude-accounts/${instanceId}' '/opt/homebrew/bin/claude' auth login`,
    );
    expect(
      formatProviderAccountStatusCommand({
        profile: CLAUDE_ACCOUNT_PROFILE,
        binaryPath: "/opt/homebrew/bin/claude",
        stateDirectory: `/Users/example/.claude-accounts/${instanceId}`,
      }),
    ).toBe(
      `CLAUDE_CONFIG_DIR='/Users/example/.claude-accounts/${instanceId}' CLAUDE_SECURESTORAGE_CONFIG_DIR='/Users/example/.claude-accounts/${instanceId}' '/opt/homebrew/bin/claude' auth status`,
    );
  });

  it("assigns extra Codex accounts under ~/.codex-accounts/<instanceId>", () => {
    expect(
      assignedProviderAccountDirectory(CODEX_ACCOUNT_PROFILE, "/Users/example/", instanceId),
    ).toBe(`/Users/example/.codex-accounts/${instanceId}`);
    expect(defaultProviderAccountDirectory(CODEX_ACCOUNT_PROFILE, "/Users/example")).toBe(
      "/Users/example/.codex",
    );
    expect(
      formatProviderAccountSignInCommand({
        profile: CODEX_ACCOUNT_PROFILE,
        binaryPath: "/opt/homebrew/bin/codex",
        stateDirectory: `/Users/example/.codex-accounts/${instanceId}`,
      }),
    ).toBe(
      `CODEX_HOME='/Users/example/.codex-accounts/${instanceId}' '/opt/homebrew/bin/codex' login`,
    );
    expect(
      formatProviderAccountStatusCommand({
        profile: CODEX_ACCOUNT_PROFILE,
        binaryPath: "/opt/homebrew/bin/codex",
        stateDirectory: `/Users/example/.codex-accounts/${instanceId}`,
      }),
    ).toBe(
      `CODEX_HOME='/Users/example/.codex-accounts/${instanceId}' '/opt/homebrew/bin/codex' login status`,
    );
  });

  it("recognizes the assigned extra-account leaf and not a custom directory", () => {
    expect(
      isAssignedProviderAccountDirectory({
        profile: CLAUDE_ACCOUNT_PROFILE,
        homeDirectory: "/Users/example",
        instanceId,
        directory: `/Users/example/.claude-accounts/${instanceId}/`,
      }),
    ).toBe(true);
    expect(
      isAssignedProviderAccountDirectory({
        profile: CLAUDE_ACCOUNT_PROFILE,
        homeDirectory: "/Users/example",
        instanceId,
        directory: "/Users/example/.claude-accounts/work",
      }),
    ).toBe(false);
  });

  it("returns no accent when a picker instance has no configuration", () => {
    expect(
      providerAccountAccent({ configuration: undefined } as unknown as ProviderInstance),
    ).toBeUndefined();
  });
});
