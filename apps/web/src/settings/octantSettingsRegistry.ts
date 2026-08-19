import { createSettingsRegistry, settingId, type SettingsRegistry } from "./registry";

/**
 * Durable Octant Settings registry.
 *
 * Only sections with working content are registered — there is no placeholder
 * scaffolding for future sections (Work remains absent until it has real
 * authoritative behavior). Section ids match the {@link SettingsSectionId}
 * information architecture in `@octant/contracts`.
 *
 * Opaque sections (Chat, Code, Providers & Models) carry section-level search
 * keywords but no individual settings, because their content is composed as an
 * opaque view owned by another feature. Deep links to an
 * opaque section open the section; focusing an exact control inside it is not
 * part of this foundation.
 */
export const octantSettingsRegistry: SettingsRegistry = createSettingsRegistry({
  sections: [
    {
      id: "general",
      label: "General",
      scope: "app",
      keywords:
        "general enabled modes startup default chat work profile name email avatar keybindings keyboard shortcuts chord updates version release",
      settings: [
        {
          id: settingId("user-profile"),
          label: "Your profile",
          scope: "app",
          keywords: "profile name email avatar gravatar initials colour color picture",
        },
        {
          id: settingId("enable-chat"),
          label: "Enable Chat",
          scope: "app",
          keywords: "enable chat mode",
        },
        {
          id: settingId("enable-work"),
          label: "Enable Work",
          scope: "app",
          keywords: "enable work mode",
        },
        {
          id: settingId("keybindings"),
          label: "Keyboard shortcuts",
          scope: "app",
          keywords: "keybindings keyboard shortcut chord palette zen search rebind json",
        },
        {
          id: settingId("app-updates"),
          label: "Updates",
          scope: "app",
          keywords:
            "update updates upgrade version release automatic check download install relaunch privacy signed notarized",
        },
      ],
    },
    {
      id: "appearance",
      label: "Appearance",
      scope: "app",
      keywords:
        "appearance theme sidebar translucency layout width material background mode switcher environment panel",
      settings: [
        {
          id: settingId("sidebar-width"),
          label: "Sidebar width",
          scope: "app",
          keywords: "sidebar width",
        },
        {
          id: settingId("sidebar-material"),
          label: "Translucent sidebar",
          scope: "app",
          keywords: "translucent sidebar material vibrancy system opaque",
        },
        {
          id: settingId("mode-switcher"),
          label: "Mode switcher",
          scope: "app",
          keywords: "mode switcher compact buttons dropdown sidebar navigation",
        },
        {
          id: settingId("project-view-switcher"),
          label: "Project view switcher",
          scope: "app",
          keywords: "project view switcher icons dropdown sidebar code",
        },
        {
          id: settingId("environment-presentation"),
          label: "Environment panel",
          scope: "app",
          keywords:
            "environment panel presentation floating pinned hidden per mode default chat work code",
        },
        {
          id: settingId("sidebar-background"),
          label: "Sidebar background",
          scope: "app",
          keywords:
            "sidebar background image preset gradient custom upload overlay color opacity vibrancy",
        },
        {
          id: settingId("theme-mode"),
          label: "Theme mode",
          scope: "app",
          keywords: "system light dark theme preset octant",
        },
        {
          id: settingId("theme-preset"),
          label: "Theme preset",
          scope: "app",
          keywords: "preset octant palette",
        },
        {
          id: settingId("ui-typography"),
          label: "UI typography",
          scope: "app",
          keywords: "font family size prose interface",
        },
        {
          id: settingId("editor-typography"),
          label: "Editor typography",
          scope: "app",
          keywords: "editor font code line height ligatures",
        },
        {
          id: settingId("terminal-typography"),
          label: "Terminal typography",
          scope: "app",
          keywords: "terminal font code line height ligatures",
        },
        {
          id: settingId("theme-accessibility"),
          label: "Theme accessibility",
          scope: "app",
          keywords: "contrast motion transparency accessibility",
        },
        {
          id: settingId("theme-import-export"),
          label: "Theme import and export",
          scope: "app",
          keywords: "import export json vscode safe",
        },
      ],
    },
    {
      id: "chat",
      label: "Chat",
      scope: "app",
      keywords:
        "chat defaults provider model web research backend routing searxng base url personality instructions new threads",
      settings: [],
    },
    {
      id: "code",
      label: "Code",
      scope: "app",
      keywords:
        "code defaults access approvals plan read-only full access permission persistence current session external editor executable arguments new threads",
      settings: [],
    },
    {
      id: "navigator-assistant",
      label: "Navigator",
      scope: "app",
      keywords:
        "navigator assistant default model provider vision reviewer image screenshot dock help",
      settings: [
        {
          id: settingId("default-model"),
          label: "Default model",
          scope: "app",
          keywords: "navigator default model provider conversation",
        },
        {
          id: settingId("vision-reviewer"),
          label: "Vision reviewer",
          scope: "app",
          keywords: "navigator vision reviewer image screenshot describe",
        },
      ],
    },
    {
      id: "providers",
      label: "Providers & Models",
      scope: "app",
      keywords:
        "providers models provider type opencode codex kimi code acp login claude agent sdk subscription anthropic openai-compatible http api-key api key base url endpoint authentication bearer protocol preference manual model ids permissions permission persistence runtime capabilities connection azure ai foundry deployment",
      settings: [],
    },
    {
      id: "profiles",
      label: "Profiles",
      scope: "app",
      keywords: "profiles execution context provider model permissions defaults reusable behavior",
      settings: [],
    },
    {
      id: "agents",
      label: "Agents",
      scope: "app",
      keywords:
        "agents subagents child creation posture off ask automatic bounded hierarchy cancel authority",
      settings: [],
    },
    {
      id: "skills",
      label: "Skills & Extensions",
      scope: "host",
      keywords:
        "skills extensions marketplace installed plugin package trust enable component desired effective provenance compatibility quarantine draining broken unavailable interrupted waiting offline failure mcp skill",
      settings: [],
    },
    {
      id: "usage",
      label: "Usage",
      scope: "host",
      keywords:
        "usage operational dashboard provider model host mode project thread request shape attribution filters totals daily weekly cumulative top consumers measurement quality exact estimated reconciled stale unavailable export reset retention purge",
      settings: [],
    },
    {
      id: "host",
      label: "Host",
      scope: "host",
      keywords:
        "host service lifecycle stop restart enable disable startup policy identity owner mode versions readiness store replay clients uptime capabilities backup recovery restore snapshot diagnostics headless automation notifications push waiting approval failure completion apns fcm",
      settings: [
        {
          id: settingId("automation-notifications"),
          label: "Automation notifications",
          scope: "host",
          keywords:
            "automation notifications push waiting approval failure completion opt-in redacted destinations receipts apns fcm unavailable",
        },
      ],
    },
    {
      id: "github",
      label: "GitHub",
      scope: "host",
      keywords:
        "github account gh cli authentication connection setup sign in refresh scopes read:project logout revoke authorization repositories issues pull requests projects capability credential storage device code insecure external token rate limited diagnostics",
      settings: [],
    },
    {
      id: "advanced",
      label: "Advanced",
      scope: "app",
      keywords: "advanced recovery reset diagnostics workspace layout window bounds",
      settings: [
        {
          id: settingId("reset-layout"),
          label: "Reset active mode layout",
          scope: "app",
          keywords: "reset active mode layout workspace",
        },
        {
          id: settingId("reset-window-bounds"),
          label: "Reset native window bounds",
          scope: "app",
          keywords: "reset native window bounds",
          nativeRequired: "nativeBoundsAvailable",
        },
        {
          id: settingId("export-diagnostics"),
          label: "Export diagnostics",
          scope: "host",
          keywords:
            "export diagnostics evidence packet support redacted safe sealed receipt provider storage network remote auth migration confinement process cleanup",
        },
      ],
    },
  ],
});
