import { createSettingsRegistry, settingId, type SettingsRegistry } from "./registry";

/**
 * Durable Octant Settings registry.
 *
 * Only sections with working content are registered — there is no placeholder
 * scaffolding for future sections, so a mode with nothing of its own to
 * configure (Work) has no page. Section ids match the {@link SettingsSectionId}
 * information architecture in `@octant/contracts`, and the order here is the
 * order the navigation lists them in within each group.
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
        "general enabled modes startup default chat work updates version release threads completed archive snooze",
      settings: [
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
          id: settingId("app-updates"),
          label: "Updates",
          scope: "app",
          keywords:
            "update updates upgrade version release automatic check download install relaunch privacy signed notarized what's new notes",
        },
        {
          id: settingId("default-folder"),
          label: "Default folder",
          scope: "host",
          keywords:
            "default folder documents octant projectless folderless no project quick task files artifacts location path",
        },
        {
          id: settingId("completed-thread-archive"),
          label: "Archive completed threads",
          scope: "host",
          keywords:
            "complete completed threads archive automatically days never snooze snoozed shelf sidebar",
        },
      ],
    },
    {
      id: "profile",
      label: "Profile",
      scope: "app",
      keywords: "profile name email avatar gravatar initials colour color picture identity",
      settings: [
        {
          id: settingId("user-profile"),
          label: "Your profile",
          scope: "app",
          keywords: "profile name email avatar gravatar initials colour color picture",
        },
      ],
    },
    {
      id: "appearance",
      label: "Appearance",
      scope: "app",
      keywords:
        "appearance theme sidebar glass translucency layout width material background mode switcher reading transcript",
      settings: [
        {
          id: settingId("sidebar-width"),
          label: "Sidebar width",
          scope: "app",
          keywords: "sidebar width",
        },
        {
          id: settingId("sidebar-destinations"),
          label: "Sidebar destinations",
          scope: "app",
          keywords: "sidebar destinations customize show hide rows menu reorder order",
        },
        {
          id: settingId("sidebar-more"),
          label: "More row in the sidebar",
          scope: "app",
          keywords: "sidebar more row hidden menu destinations account customize reveal expand",
        },
        {
          id: settingId("sidebar-material"),
          label: "Glass",
          scope: "app",
          keywords:
            "glass translucent translucency sidebar material vibrancy subtle strong frosted system opaque",
        },
        {
          id: settingId("workspace-material"),
          label: "Glass cards",
          scope: "app",
          keywords: "translucent workspace window material vibrancy glass system opaque",
        },
        {
          id: settingId("mode-switcher"),
          label: "Mode switcher",
          scope: "app",
          keywords: "mode switcher compact buttons dropdown sidebar navigation",
        },
        {
          id: settingId("transcript-text-size"),
          label: "Transcript text size",
          scope: "app",
          keywords: "transcript conversation text font size small medium large",
        },
        {
          id: settingId("transcript-width"),
          label: "Transcript width",
          scope: "app",
          keywords: "transcript conversation composer width narrow medium wide centered",
        },
        {
          id: settingId("thread-provider-icons"),
          label: "Provider icons in thread list",
          scope: "app",
          keywords: "thread provider icon avatar logo sidebar compact visibility",
        },
        {
          id: settingId("sidebar-projects-branch"),
          label: "Branch on Projects rows",
          scope: "app",
          keywords: "sidebar projects rows branch worktree checkout show hide metadata appearance",
        },
        {
          id: settingId("sidebar-projects-pull-request"),
          label: "Pull request on Projects rows",
          scope: "app",
          keywords:
            "sidebar projects rows pull request pr number state chip show hide metadata appearance",
        },
        {
          id: settingId("sidebar-projects-last-updated"),
          label: "Last updated on Projects rows",
          scope: "app",
          keywords:
            "sidebar projects rows last updated age timestamp show hide metadata appearance",
        },
        {
          id: settingId("sidebar-projects-status"),
          label: "Status on Projects rows",
          scope: "app",
          keywords:
            "sidebar projects rows status mark working waiting unread show hide metadata appearance",
        },
        {
          id: settingId("sidebar-activity-project"),
          label: "Project on Activity rows",
          scope: "app",
          keywords: "sidebar activity rows project name show hide metadata appearance",
        },
        {
          id: settingId("sidebar-activity-branch"),
          label: "Branch on Activity rows",
          scope: "app",
          keywords: "sidebar activity rows branch worktree checkout show hide metadata appearance",
        },
        {
          id: settingId("sidebar-activity-pull-request"),
          label: "Pull request on Activity rows",
          scope: "app",
          keywords:
            "sidebar activity rows pull request pr number state chip show hide metadata appearance",
        },
        {
          id: settingId("sidebar-activity-last-updated"),
          label: "Last updated on Activity rows",
          scope: "app",
          keywords:
            "sidebar activity rows last updated age timestamp show hide metadata appearance",
        },
        {
          id: settingId("sidebar-activity-status"),
          label: "Status on Activity rows",
          scope: "app",
          keywords:
            "sidebar activity rows status mark working waiting unread show hide metadata appearance",
        },
        {
          id: settingId("sidebar-background"),
          label: "Sidebar background",
          scope: "app",
          keywords: "sidebar background preset gradient overlay color opacity",
        },
        {
          id: settingId("app-background"),
          label: "Background",
          scope: "app",
          keywords:
            "background ground welcome start screen everywhere sidebar theme pattern dither photo image upload opacity speed intensity none",
        },
        {
          id: settingId("appearance.scheme.light-preset"),
          label: "Light preset",
          scope: "app",
          keywords: "color colour scheme system light dark theme mode preset octant palette",
        },
        {
          id: settingId("appearance.scheme.dark-preset"),
          label: "Dark preset",
          scope: "app",
          keywords: "color colour scheme system light dark theme mode preset octant palette",
        },
        {
          id: settingId("appearance.typography.ui.family"),
          label: "Interface font",
          scope: "app",
          keywords: "interface typography font family size prose ui",
        },
        {
          id: settingId("appearance.typography.editor.family"),
          label: "Code font",
          scope: "app",
          keywords: "code editor typography font line height ligatures",
        },
        {
          id: settingId("appearance.typography.terminal.family"),
          label: "Terminal font",
          scope: "app",
          keywords: "terminal typography font line height ligatures",
        },
        {
          id: settingId("appearance.accessibility.increased-contrast"),
          label: "Accessibility",
          scope: "app",
          keywords: "accessibility increased contrast reduced motion reduced transparency",
        },
        {
          id: settingId("appearance.theme-import-export"),
          label: "Import or export theme",
          scope: "app",
          keywords: "theme json import export vscode safe",
        },
        {
          id: settingId("reset-appearance"),
          label: "Reset appearance",
          scope: "app",
          keywords: "reset appearance defaults theme restore",
        },
      ],
    },
    {
      id: "keybindings",
      label: "Keybindings",
      scope: "app",
      keywords: "keybindings keyboard shortcuts chord palette zen search rebind json",
      settings: [
        {
          id: settingId("keybindings"),
          label: "Keyboard shortcuts",
          scope: "app",
          keywords: "keybindings keyboard shortcut chord palette zen search rebind json",
        },
      ],
    },
    {
      id: "chat",
      label: "Chat",
      scope: "app",
      keywords:
        "chat defaults provider model fallback backup web research backend routing searxng base url personality instructions new threads",
      settings: [
        {
          id: settingId("stream-replies"),
          label: "Stream replies",
          scope: "app",
          keywords: "stream streaming answer response finished partial",
        },
      ],
    },
    {
      id: "code",
      label: "Code",
      scope: "app",
      keywords:
        "code defaults access approvals plan read-only full access permission persistence current session external editor executable arguments new threads open in applications vscode cursor zed finder terminal ghostty xcode detected installed",
      settings: [
        {
          id: settingId("code-default-folder-threads"),
          label: "Threads without a Project",
          scope: "mode",
          keywords: "default folder projectless no project git repository",
        },
        {
          id: settingId("project-view-switcher"),
          label: "Project view switcher",
          scope: "app",
          keywords: "project view switcher icons dropdown sidebar code",
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
      id: "harness",
      label: "Octant Harness",
      scope: "app",
      keywords:
        "octant harness native agent loop model slots default plan slow task smol vision advisor routing fallback cooldown delegate children follow-ups chips endpoint openai-compatible anthropic-compatible ollama azure agents subagents helper child creation posture off ask automatic bounded hierarchy",
      settings: [
        {
          id: settingId("subagent-creation-posture"),
          label: "Helper agents",
          scope: "app",
          keywords:
            "helper agents subagents child runs creation posture off ask automatic delegate add agent dock",
        },
      ],
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
      id: "voice",
      label: "Voice",
      scope: "app",
      keywords:
        "voice speech microphone dictation transcription speech to text text to speech read aloud whisper tts stt",
      settings: [
        {
          id: settingId("transcription"),
          label: "Transcription",
          scope: "app",
          keywords: "voice transcription speech to text microphone dictation whisper stt model",
        },
        {
          id: settingId("synthesis"),
          label: "Speech",
          scope: "app",
          keywords: "voice speech text to speech read aloud tts model voice",
        },
      ],
    },
    {
      id: "image-generation",
      label: "Image generation",
      scope: "app",
      keywords:
        "image generation custom provider api key recraft openai-compatible bring your own endpoint",
      settings: [],
    },
    {
      id: "computer-use",
      label: "Computer use",
      scope: "host",
      keywords:
        "computer use computer automation cua driver permissions accessibility screen recording plugin updates upgrade",
      settings: [
        {
          id: settingId("computer-use-enabled"),
          label: "Computer use",
          scope: "host",
          keywords: "plugin enable computer control",
        },
        {
          id: settingId("computer-use-accessibility"),
          label: "Accessibility",
          scope: "host",
          keywords: "permissions accessibility",
        },
        {
          id: settingId("computer-use-screen-recording"),
          label: "Screen recording",
          scope: "host",
          keywords: "permissions screen capture",
        },
        {
          id: settingId("computer-use-version"),
          label: "Installed driver",
          scope: "host",
          keywords: "cua driver version",
        },
        {
          id: settingId("computer-use-automatic-updates"),
          label: "Automatic updates",
          scope: "host",
          keywords: "automatic updates upgrade",
        },
      ],
    },
    {
      id: "skills",
      label: "Skills & Extensions",
      scope: "host",
      keywords:
        "skills extensions marketplace installed plugin package trust enable component desired effective provenance compatibility quarantine draining broken unavailable interrupted waiting offline failure mcp skill",
      settings: [
        {
          id: settingId("marketplace-fetches"),
          label: "Marketplace fetches",
          scope: "host",
          keywords:
            "marketplace fetches skills npm github registry catalog search inspect install privacy off",
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
      id: "linear",
      label: "Linear",
      scope: "host",
      keywords:
        "linear workspace authentication connection setup oauth connect disconnect reconnect issues personal api key",
      settings: [],
    },
    {
      id: "host",
      label: "Host",
      scope: "host",
      keywords:
        "host service lifecycle stop restart enable disable startup policy identity owner mode versions readiness store replay clients uptime capabilities headless automation notifications push waiting approval failure completion apns fcm federated hosts maintenance reset layout window bounds diagnostics export support",
      settings: [
        {
          id: settingId("host-automation-notifications"),
          label: "Automation notifications",
          scope: "host",
          keywords:
            "automation notifications push waiting approval failure completion opt-in redacted destinations receipts apns fcm unavailable",
        },
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
    {
      id: "data",
      label: "Data & privacy",
      scope: "host",
      keywords:
        "data privacy backup snapshot restore recovery stored data map location journal projections artifacts credentials keychain caches what leaves this machine retention purge export erase delete history",
      settings: [
        {
          id: settingId("data-map"),
          label: "Data map",
          scope: "host",
          keywords:
            "data map privacy stored location journal projections artifacts credentials keychain secret-service caches provider calls update checks marketplace",
        },
        {
          id: settingId("thread-retention"),
          label: "Thread retention",
          scope: "host",
          keywords: "thread retention window purge journal erase delete history",
        },
      ],
    },
    {
      id: "remote-access",
      label: "Remote access",
      scope: "host",
      keywords:
        "remote access private listener lan tailscale https certificate pairing pair link ticket code approve deny device devices paired inventory browser phone revoke rename origin port exposure",
      settings: [
        {
          id: settingId("remote-listener"),
          label: "Remote listener",
          scope: "host",
          keywords:
            "remote listener enable disable restart hostname port origin certificate tls https lan tailscale exposure",
        },
        {
          id: settingId("remote-pairing"),
          label: "Pair a device",
          scope: "host",
          keywords: "pair pairing link code ticket approve deny comparison browser phone request",
        },
      ],
    },
    {
      id: "usage",
      label: "Usage",
      scope: "host",
      keywords:
        "usage operational dashboard provider model host mode project thread request shape attribution filters totals daily weekly cumulative top consumers measurement quality exact estimated reconciled stale unavailable export reset retention purge spend ceiling token budget",
      settings: [],
    },
  ],
});
