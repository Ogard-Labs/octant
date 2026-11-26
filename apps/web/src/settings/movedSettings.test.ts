import type { SettingsSectionId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { currentSettingsLink } from "./movedSettings";
import { octantSettingsRegistry } from "./octantSettingsRegistry";
import { resolveDeepLink, settingId } from "./registry";

const capabilities = { nativeBoundsAvailable: true, sidebarVibrancySupported: true };

/**
 * The pages that were folded or split, with the settings each held the day
 * before (2026-11-25). A link written against that layout names one of these
 * pairs: an empty state, a doc, a paired device on an earlier build.
 */
const PAGES_BEFORE_THE_REGROUPING: Readonly<
  Partial<Record<SettingsSectionId, ReadonlyArray<string>>>
> = {
  chat: [
    "stream-replies",
    "chat-default-model",
    "chat-fallback-model",
    "chat-personality",
    "chat-research-enabled",
    "chat-research-backend",
    "chat-restart-continuation",
  ],
  work: ["work-default-model", "work-default-access", "work-strict", "work-restart-continuation"],
  "device-tools": ["managed-tools-automatic-updates", "managed-tools-update-check"],
  github: ["github-connection", "github-logout"],
  linear: ["linear-connection", "linear-projects", "linear-disconnect"],
  todos: ["todo-list-host"],
  permissions: [
    "sandbox-restrictions",
    "sandbox-policy-summary",
    "sandbox-policy-folders",
    "sandbox-policy-add-folder",
    "sandbox-policy-blocked-actions",
    "sandbox-policy-network",
    "sandbox-policy-services",
    "sandbox-policy-local-services",
    "sandbox-policy-credentials",
    "protected-files",
    "protected-files-add",
    "blocked-tools",
    "blocked-tools-add",
    "public-links",
    "public-link-service",
    "public-link-setup",
    "browser-site-approvals",
    "browser-agent-downloads",
    "browser-captures-per-thread",
    "tool-call-records",
    "tool-steps-per-turn",
    "tool-steps-per-turn-full-access",
    "runtime-turns-per-turn",
    "browser-transfer-file-limit",
    "browser-held-download-limit",
    "browser-upload-file-count-limit",
    "thread-wakeups-waiting",
    "thread-wakeups-run-missed",
    "message-wakes-per-hour",
    "message-wake-rounds",
    "thread-messages-per-turn",
    "sibling-thread-reads-per-turn",
    "sibling-thread-waits-per-turn",
    "coordinators-per-project",
    "pull-request-watch-wakes",
    "pull-request-watch-days",
    "auto-fix-attempts",
    "browser-wait-limit",
    "child-run-wait-limit",
    "shield-denials-in-a-row",
    "shield-denials-per-thread",
    "follow-up-lateness-limit",
    "tooling-command-confirm",
    "agent-routines-start-active",
    "tool-approvals",
    "network-limits",
    "safe-networks",
    "shield-servers-list",
    "shield-servers-add",
    "server-projects",
  ],
};

describe("a link written for an earlier Settings layout", () => {
  it("lands on the row of every setting a folded or split page held", () => {
    const lost: string[] = [];
    for (const [page, settings] of Object.entries(PAGES_BEFORE_THE_REGROUPING)) {
      for (const setting of settings) {
        const resolved = resolveDeepLink(
          octantSettingsRegistry,
          capabilities,
          currentSettingsLink({ section: page as SettingsSectionId, setting: settingId(setting) }),
        );
        if (resolved?.settingId !== setting) lost.push(`${page}/${setting}`);
      }
    }
    expect(lost).toEqual([]);
  });

  it.each([
    ["chat", "chat-work"],
    ["work", "chat-work"],
    ["device-tools", "computer-use"],
    ["github", "integrations"],
    ["linear", "integrations"],
    ["todos", "data"],
  ] as const)("opens the page that took %s in when it names no setting", (page, holder) => {
    expect(currentSettingsLink({ section: page })).toEqual({ section: holder });
    expect(
      resolveDeepLink(octantSettingsRegistry, capabilities, currentSettingsLink({ section: page }))
        ?.section.id,
    ).toBe(holder);
  });

  it("sends a limit's old Permissions link to Limits and leaves a permission's alone", () => {
    expect(
      currentSettingsLink({ section: "permissions", setting: settingId("tool-steps-per-turn") }),
    ).toEqual({ section: "limits", setting: "tool-steps-per-turn" });
    const stays = { section: "permissions", setting: settingId("protected-files") } as const;
    expect(currentSettingsLink(stays)).toBe(stays);
  });

  it("keeps a sandbox scope the link carried", () => {
    expect(
      currentSettingsLink({
        section: "access",
        setting: settingId("safe-networks"),
        sandboxScope: { kind: "settings", mode: "work" },
      }),
    ).toEqual({
      section: "permissions",
      setting: "safe-networks",
      sandboxScope: { kind: "settings", mode: "work" },
    });
  });
});
