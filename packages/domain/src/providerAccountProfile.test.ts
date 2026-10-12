import { describe, expect, it } from "vitest";
import { decodeProviderInstanceId, type ProviderInstance } from "@octant/contracts";
import {
  assignedProviderAccountDirectory,
  CLAUDE_ACCOUNT_PROFILE,
  defaultProviderAccountDirectory,
  formatProviderAccountSignInCommand,
  formatProviderAccountStatusCommand,
  isAssignedProviderAccountDirectory,
  providerAccountAccent,
  providerAccountProfile,
} from "./providerAccountProfile";

const instanceId = decodeProviderInstanceId("11111111-1111-4111-8111-111111111111");

describe("provider account profile", () => {
  it("declares Claude as the only multi-account driver", () => {
    expect(providerAccountProfile("claude")).toEqual(CLAUDE_ACCOUNT_PROFILE);
    expect(CLAUDE_ACCOUNT_PROFILE.supportsMultipleAccounts).toBe(true);
    expect(providerAccountProfile("codex")).toBeUndefined();
  });

  it("assigns extra Claude accounts under ~/.claude-accounts/<instanceId>", () => {
    expect(
      assignedProviderAccountDirectory(CLAUDE_ACCOUNT_PROFILE, "/Users/example/", instanceId),
    ).toBe(`/Users/example/.claude-accounts/${instanceId}`);
    expect(defaultProviderAccountDirectory(CLAUDE_ACCOUNT_PROFILE, "/Users/example")).toBe(
      "/Users/example/.claude",
    );
  });

  it("gives two instance ids that differ only by letter case one account folder", () => {
    const upper = decodeProviderInstanceId("ABCDEF01-1111-4111-8111-111111111111");
    const lower = decodeProviderInstanceId("abcdef01-1111-4111-8111-111111111111");
    expect(assignedProviderAccountDirectory(CLAUDE_ACCOUNT_PROFILE, "/Users/example", upper)).toBe(
      assignedProviderAccountDirectory(CLAUDE_ACCOUNT_PROFILE, "/Users/example", lower),
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
