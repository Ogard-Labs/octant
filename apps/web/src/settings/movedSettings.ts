import type { SettingsDeepLink, SettingsSectionId } from "@octant/contracts";

/**
 * Settings that moved to another page keep answering the links that name
 * their old one: an empty state, a doc, or a remote client built against the
 * earlier layout still lands on the control.
 */
const MOVED_SETTINGS: ReadonlyArray<{
  readonly from: SettingsSectionId;
  readonly setting: string;
  readonly to: SettingsSectionId;
}> = [
  { from: "host", setting: "host-automation-notifications", to: "general" },
  ...["public-links", "public-link-service", "browser-site-approvals", "tool-approvals"].map(
    (setting) => ({ from: "data" as const, setting, to: "permissions" as const }),
  ),
  { from: "general", setting: "marketplace-fetches", to: "skills" },
  { from: "chat", setting: "chat-searxng-url", to: "web-search" },
  { from: "appearance", setting: "stream-replies", to: "chat-work" },
  { from: "appearance", setting: "project-view-switcher", to: "code" },
  ...[
    "sidebar-width",
    "sidebar-destinations",
    "sidebar-more",
    "mode-switcher",
    "thread-provider-icons",
    "sidebar-background",
    "sidebar-projects-branch",
    "sidebar-projects-pull-request",
    "sidebar-projects-last-updated",
    "sidebar-projects-status",
    "sidebar-activity-project",
    "sidebar-activity-branch",
    "sidebar-activity-pull-request",
    "sidebar-activity-last-updated",
    "sidebar-activity-status",
  ].map((setting) => ({ from: "appearance" as const, setting, to: "sidebar" as const })),
  { from: "host", setting: "data-map", to: "data" },
  { from: "host", setting: "thread-retention", to: "data" },
  // Permissions held fifty settings; the counts and waits that bound what an
  // agent does unattended became a page of their own.
  ...[
    "tool-steps-per-turn",
    "tool-steps-per-turn-full-access",
    "runtime-turns-per-turn",
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
  ].map((setting) => ({ from: "permissions" as const, setting, to: "limits" as const })),
];

/**
 * Pages that were folded into another keep answering their own links, with
 * or without a setting. Profile and Notifications each held one or two
 * controls and Access was the other half of what an agent may touch and
 * reach, so the sidebar listed three pages a person rarely needed alone.
 * Device tools, GitHub, Linear and To-dos held one to three settings each,
 * and Chat and Work each held a single section of defaults.
 */
const MERGED_PAGES: Readonly<Partial<Record<SettingsSectionId, SettingsSectionId>>> = {
  profile: "general",
  notifications: "general",
  access: "permissions",
  chat: "chat-work",
  work: "chat-work",
  "device-tools": "computer-use",
  github: "integrations",
  linear: "integrations",
  todos: "data",
};

/** The link as today's pages answer it, whichever layout it was written for. */
export function currentSettingsLink(link: SettingsDeepLink): SettingsDeepLink {
  const moved = MOVED_SETTINGS.find(
    (entry) => entry.from === link.section && entry.setting === link.setting,
  );
  const section = moved === undefined ? link.section : moved.to;
  const merged = MERGED_PAGES[section] ?? section;
  return merged === link.section ? link : { ...link, section: merged };
}
