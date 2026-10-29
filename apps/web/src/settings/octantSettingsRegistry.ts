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
        "general enabled modes startup default chat work updates version release threads completed put away archive snooze",
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
          label: "Archive put-away threads",
          scope: "host",
          keywords:
            "put away complete completed threads archive automatically days never snooze snoozed shelf sidebar",
        },
        {
          id: settingId("app-update-automatic-checks"),
          label: "Automatic update checks",
          scope: "app",
          keywords: "automatic checks update updates service daily contact",
        },
        {
          id: settingId("app-update-ring"),
          label: "Release ring",
          scope: "app",
          keywords: "release ring stable preview candidate nightly beta channel updates",
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
      id: "notifications",
      label: "Notifications",
      scope: "host",
      keywords:
        "notifications notify alerts push phone waiting approval failure completion automation routines",
      settings: [
        {
          id: settingId("host-phone-notifications"),
          label: "Phone notifications",
          scope: "host",
          keywords:
            "phone notifications push paired phone mobile lock screen sealed gateway apns fcm",
        },
        {
          id: settingId("host-push-gateway"),
          label: "Push gateway",
          scope: "host",
          keywords: "push gateway address url self-host phone notifications delivery",
        },
        {
          id: settingId("host-automation-notifications"),
          label: "Automation notifications",
          scope: "host",
          keywords:
            "automation notifications push waiting approval failure completion opt-in redacted destinations receipts apns fcm unavailable",
        },
      ],
    },
    {
      id: "appearance",
      label: "Appearance",
      scope: "app",
      keywords:
        "appearance theme glass translucency material background typography font reading transcript accessibility",
      settings: [
        {
          id: settingId("sidebar-material"),
          label: "Glass",
          scope: "app",
          keywords:
            "glass translucent translucency window sidebar material vibrancy subtle strong frosted system opaque",
        },
        {
          id: settingId("glass-tint"),
          label: "Glass tint",
          scope: "app",
          keywords: "glass tint opacity transparency see-through darkness window vibrancy",
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
          id: settingId("thread-stats"),
          label: "Stats line under the composer",
          scope: "app",
          keywords:
            "thread stats line tokens cache hit speed tok/s first token latency cost usage composer show hide",
        },
        {
          id: settingId("usage-bars"),
          label: "Usage bars",
          scope: "app",
          keywords:
            "usage bars plan limits meters remaining left 5h week composer smooth pixelated pixel cells dither",
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
          id: settingId("appearance.scheme.style"),
          label: "Style",
          scope: "app",
          keywords: "style vivid colour color colourful default monochrome tiles accent",
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
        {
          id: settingId("appearance.scheme.accent"),
          label: "Accent colour",
          scope: "app",
          keywords: "accent colour color highlight theme",
        },
        {
          id: settingId("appearance.accessibility.reduced-motion"),
          label: "Reduce motion",
          scope: "app",
          keywords: "reduce reduced motion animation accessibility",
        },
        {
          id: settingId("appearance.accessibility.reduced-transparency"),
          label: "Reduce transparency",
          scope: "app",
          keywords: "reduce reduced transparency glass opaque accessibility",
        },
        {
          id: settingId("app-background-motion"),
          label: "Background motion",
          scope: "app",
          keywords: "background motion still wave animate animated move click ripple bounce pixels",
        },
        {
          id: settingId("app-background-effect"),
          label: "Background effect",
          scope: "app",
          keywords: "background effect pixels pixelated dithered dither picture photo",
        },
        {
          id: settingId("app-background-effect-cell"),
          label: "Pixel size",
          scope: "app",
          keywords: "background pixel size square cell dither",
        },
        {
          id: settingId("app-background-effect-tones"),
          label: "Background colours",
          scope: "app",
          keywords: "background colours colors tones shades dither bold",
        },
        {
          id: settingId("app-background-photo"),
          label: "Background photo",
          scope: "app",
          keywords: "background photo picture image library wallpaper",
        },
        {
          id: settingId("app-background-photo-opacity"),
          label: "Photo strength",
          scope: "app",
          keywords: "background photo strength opacity show through",
        },
        {
          id: settingId("app-background-scope"),
          label: "Show the background behind",
          scope: "app",
          keywords: "background show behind start screens every page everywhere",
        },
        {
          id: settingId("app-background-sidebar"),
          label: "Background under the sidebar",
          scope: "app",
          keywords: "background cover sidebar under",
        },
        {
          id: settingId("appearance.typography.ui.size"),
          label: "Interface text size",
          scope: "app",
          keywords: "interface text font size typography",
        },
        {
          id: settingId("appearance.typography.editor.size"),
          label: "Code font size",
          scope: "app",
          keywords: "code editor font size typography",
        },
        {
          id: settingId("appearance.typography.editor.line-height"),
          label: "Code line height",
          scope: "app",
          keywords: "code editor line height spacing typography",
        },
        {
          id: settingId("appearance.typography.editor.ligatures"),
          label: "Code ligatures",
          scope: "app",
          keywords: "code editor ligatures typography",
        },
        {
          id: settingId("appearance.typography.terminal.size"),
          label: "Terminal font size",
          scope: "app",
          keywords: "terminal font size typography",
        },
        {
          id: settingId("appearance.typography.terminal.line-height"),
          label: "Terminal line height",
          scope: "app",
          keywords: "terminal line height spacing typography",
        },
        {
          id: settingId("appearance.typography.terminal.ligatures"),
          label: "Terminal ligatures",
          scope: "app",
          keywords: "terminal ligatures typography",
        },
      ],
    },
    {
      id: "sidebar",
      label: "Sidebar",
      scope: "app",
      keywords:
        "sidebar width destinations more row mode switcher provider icons thread rows background layout",
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
          id: settingId("sidebar-count-tiles"),
          label: "Count tiles",
          scope: "app",
          keywords: "sidebar count tiles inbox running review done today cards counts",
        },
        {
          id: settingId("sidebar-search"),
          label: "Thread filter",
          scope: "app",
          keywords: "sidebar search filter field icon always shown threads find",
        },
        {
          id: settingId("sidebar-collapsed"),
          label: "When collapsed",
          scope: "app",
          keywords: "sidebar collapse collapsed hide rail icons narrow hidden",
        },
        {
          id: settingId("mode-switcher"),
          label: "Mode switcher",
          scope: "app",
          keywords: "mode switcher compact buttons icons dropdown sidebar navigation",
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
        {
          id: settingId("chat-default-model"),
          label: "Default Chat model",
          scope: "app",
          keywords: "default provider model new chat thread",
        },
        {
          id: settingId("chat-fallback-model"),
          label: "Chat fallback model",
          scope: "app",
          keywords: "fallback backup provider model chat",
        },
        {
          id: settingId("chat-personality"),
          label: "Instructions for new Chat threads",
          scope: "app",
          keywords: "instructions personality custom system prompt chat",
        },
        {
          id: settingId("chat-research-enabled"),
          label: "Research by default",
          scope: "app",
          keywords: "research web search default chat",
        },
        {
          id: settingId("chat-research-backend"),
          label: "Default research backend",
          scope: "app",
          keywords: "research backend web search searxng",
        },
        {
          id: settingId("chat-searxng-url"),
          label: "SearXNG base URL",
          scope: "app",
          keywords: "searxng url address search engine research",
        },
      ],
    },
    {
      id: "work",
      label: "Work",
      scope: "host",
      keywords:
        "work defaults provider model access ask first auto-accept edits approvals files project folder new threads",
      settings: [
        {
          id: settingId("work-default-model"),
          label: "Default Work model",
          scope: "host",
          keywords: "work default provider model new threads",
        },
        {
          id: settingId("work-default-access"),
          label: "Work access",
          scope: "host",
          keywords: "work access ask first auto-accept accept edits approvals files permissions",
        },
      ],
    },
    {
      id: "code",
      label: "Code",
      scope: "app",
      keywords:
        "code defaults access approvals plan read-only full access permission persistence current session external editor executable arguments new threads open in applications vscode cursor zed finder terminal ghostty xcode detected installed diff layout unified side by side review language services type errors go to definition",
      settings: [
        {
          id: settingId("code-require-git"),
          label: "Code needs a Git repository",
          scope: "mode",
          keywords:
            "git repository require plain folder default folder projectless no project threads without a project",
        },
        {
          id: settingId("code-default-diff-layout"),
          label: "Default diff layout",
          scope: "mode",
          keywords: "diff layout unified side by side review checkout",
        },
        {
          id: settingId("code-language-services"),
          label: "Language services",
          scope: "mode",
          keywords:
            "language services language server typescript javascript type errors diagnostics problems go to definition lsp editor bundled",
        },
        {
          id: settingId("project-view-switcher"),
          label: "Project view switcher",
          scope: "app",
          keywords: "project view switcher icons dropdown sidebar code",
        },
        {
          id: settingId("code-default-access"),
          label: "Default Code access",
          scope: "app",
          keywords: "access authority approval approvals full access ask read only new code thread",
        },
        {
          id: settingId("code-approval-persistence"),
          label: "Default approval persistence",
          scope: "app",
          keywords: "approval approvals persistence remember session project",
        },
        {
          id: settingId("code-editor-executable"),
          label: "External editor",
          scope: "app",
          keywords: "external editor executable path open files vscode cursor zed",
        },
        {
          id: settingId("code-editor-arguments"),
          label: "External editor arguments",
          scope: "app",
          keywords: "external editor arguments flags open files",
        },
        {
          id: settingId("open-in-applications"),
          label: "Open in applications",
          scope: "app",
          keywords: "open in applications editor finder terminal ide external",
        },
      ],
    },
    {
      id: "providers",
      label: "Providers & Models",
      scope: "app",
      keywords:
        "providers models agent runtimes provider type opencode codex kimi code acp cli login claude agent sdk subscription gemini qwen cline mistral vibe grok glm fx goose copilot devin kilo pi binary path permissions permission persistence runtime capabilities connection detected installed scan opencode update managed cli version provider catalog drivers bundled installed trusted available enabled authenticated signed in ready set up setup guided add runtime endpoint find look on this host install modes chat work code agent loop harness capabilities",
      settings: [
        {
          id: settingId("opencode-managed-update"),
          label: "OpenCode update",
          scope: "host",
          keywords: "opencode update version managed cli installed available",
        },
        {
          id: settingId("provider-display-name"),
          label: "Provider display name",
          scope: "host",
          keywords: "provider display name rename label",
        },
        {
          id: settingId("provider-binary-path"),
          label: "Provider executable path",
          scope: "host",
          keywords: "provider binary executable path location cli install",
        },
        {
          id: settingId("provider-authentication"),
          label: "Provider sign-in method",
          scope: "host",
          keywords:
            "provider authentication sign in login subscription oauth organization single sign-on access portal account role region",
        },
        {
          id: settingId("provider-api-key"),
          label: "Provider API key",
          scope: "host",
          keywords: "provider api key credential secret",
        },
        {
          id: settingId("provider-base-url"),
          label: "Provider base URL",
          scope: "host",
          keywords: "provider base url address endpoint",
        },
        {
          id: settingId("provider-protocol"),
          label: "Provider protocol",
          scope: "host",
          keywords: "provider protocol version api",
        },
        {
          id: settingId("provider-manual-model-ids"),
          label: "Manual model IDs",
          scope: "host",
          keywords: "manual model ids list provider",
        },
        {
          id: settingId("provider-deployment-ids"),
          label: "Deployment IDs",
          scope: "host",
          keywords: "azure deployment ids provider",
        },
        {
          id: settingId("provider-claude-account"),
          label: "Claude account",
          scope: "host",
          keywords: "claude account config directory folder accent sign in login status",
        },
        {
          id: settingId("provider-claude-artifacts"),
          label: "Enable Claude artifacts",
          scope: "host",
          keywords:
            "claude artifacts artifact tool publish published page claude.ai link documents reports pages canvas delivery upload leaves this computer telemetry usage anthropic privacy",
        },
      ],
    },
    {
      id: "harness",
      label: "Octant Harness",
      scope: "app",
      keywords:
        "octant harness native agent loop model endpoints endpoint api openai-compatible anthropic-compatible ollama azure ai foundry deployment base url api key bearer protocol manual model ids sign in with chatgpt plan openrouter subscription model roles main model backup model slots default plan slow task smol vision advisor routing fallback cooldown delegate children follow-ups chips agents subagents helper agents child creation posture off on automatic bounded hierarchy navigator assistant default model provider vision reviewer image screenshot dock help",
      settings: [
        {
          id: settingId("model-endpoints"),
          label: "Model endpoints",
          scope: "host",
          keywords:
            "model endpoints add endpoint api openai-compatible anthropic-compatible ollama azure ai foundry amazon bedrock base url address api key replace key sign in with chatgpt plan openrouter subscription sign out check now try again can't connect not working key refused no models diagnostics remove endpoint where your data goes eu zero data retention models shown hidden reads images chat only verify tools",
        },
        {
          id: settingId("model-roles"),
          label: "Model roles",
          scope: "host",
          keywords:
            "model roles main model planning careful review research lookups quick jobs reading images vision advisor backup fallback which job uses which role slots default plan slow task smol",
        },
        {
          id: settingId("subagent-creation-posture"),
          label: "Helper agents",
          scope: "app",
          keywords: "helper agents subagents child runs creation posture off on automatic delegate",
        },
        {
          id: settingId("subagent-concurrency-on-host"),
          label: "Helper agents at once across Octant",
          scope: "app",
          keywords: "helper agents subagents concurrency at once limit parallel",
        },
        {
          id: settingId("subagent-concurrency-per-thread"),
          label: "Helper agents at once in one thread",
          scope: "app",
          keywords: "helper agents subagents concurrency at once limit parallel thread",
        },
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
      label: "Voice & images",
      scope: "app",
      keywords:
        "voice speech microphone dictation transcription speech to text text to speech read aloud whisper tts stt image generation image provider profiles openai image gpt-image gemini image black forest labs flux ideogram custom image sources provider api key recraft openai-compatible bring your own endpoint",
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
        {
          id: settingId("custom-image-sources"),
          label: "Custom image sources",
          scope: "app",
          keywords: "custom image sources provider endpoint",
        },
        {
          id: settingId("default-model"),
          label: "Default image model",
          scope: "app",
          keywords: "default image model provider",
        },
        {
          id: settingId("model-allowlist"),
          label: "Image models offered",
          scope: "app",
          keywords: "image model allowlist models offered",
        },
        {
          id: settingId("quality"),
          label: "Image quality",
          scope: "app",
          keywords: "image quality",
        },
        {
          id: settingId("size"),
          label: "Image size",
          scope: "app",
          keywords: "image size dimensions",
        },
        {
          id: settingId("aspect-ratio"),
          label: "Image aspect ratio",
          scope: "app",
          keywords: "image aspect ratio",
        },
        {
          id: settingId("resolution"),
          label: "Image resolution",
          scope: "app",
          keywords: "image resolution",
        },
        {
          id: settingId("api-key"),
          label: "Image provider API key",
          scope: "app",
          keywords: "image provider api key credential",
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
        {
          id: settingId("computer-use-permission-actions"),
          label: "Computer use permissions",
          scope: "app",
          keywords: "permission permissions accessibility screen recording system settings macos",
        },
        {
          id: settingId("computer-use-update-check"),
          label: "Computer use driver update check",
          scope: "app",
          keywords: "driver update check daily",
        },
      ],
    },
    {
      id: "device-tools",
      label: "Device tools",
      scope: "host",
      keywords:
        "device tools simulator emulator serve-sim serve-avd ios android stream updates upgrade bundled app store connect distribution",
      settings: [
        {
          id: settingId("managed-tools-automatic-updates"),
          label: "Automatic updates",
          scope: "host",
          keywords: "automatic updates upgrade device tools",
        },
        {
          id: settingId("managed-tools-update-check"),
          label: "Update check",
          scope: "host",
          keywords: "check updates device tools",
        },
        // The App Store Connect key is entered only from a desktop window, so
        // search offers these rows only where the section can appear.
        {
          id: settingId("app-store-connect-key-state"),
          label: "App Store Connect API key",
          scope: "host",
          keywords:
            "app store connect api key apple distribution upload testflight remove replace keychain",
          nativeRequired: "nativeBoundsAvailable",
        },
        {
          id: settingId("app-store-connect-issuer"),
          label: "App Store Connect issuer ID",
          scope: "host",
          keywords: "app store connect issuer id api key apple distribution",
          nativeRequired: "nativeBoundsAvailable",
        },
        {
          id: settingId("app-store-connect-key-id"),
          label: "App Store Connect key ID",
          scope: "host",
          keywords: "app store connect key id api key apple distribution",
          nativeRequired: "nativeBoundsAvailable",
        },
        {
          id: settingId("app-store-connect-private-key"),
          label: "App Store Connect private key",
          scope: "host",
          keywords: "app store connect private key p8 authkey api key apple distribution",
          nativeRequired: "nativeBoundsAvailable",
        },
        {
          id: settingId("app-store-connect-key-source"),
          label: "App Store Connect private key from",
          scope: "host",
          keywords: "app store connect private key source keychain 1password op reference",
          nativeRequired: "nativeBoundsAvailable",
        },
        {
          id: settingId("app-store-connect-1password-reference"),
          label: "App Store Connect 1Password reference",
          scope: "host",
          keywords: "app store connect 1password op reference secret vault item field private key",
          nativeRequired: "nativeBoundsAvailable",
        },
      ],
    },
    {
      id: "github",
      label: "GitHub",
      scope: "host",
      keywords:
        "github account gh cli authentication connection setup sign in refresh scopes read:project logout revoke authorization repositories issues pull requests projects capability credential storage device code insecure external token rate limited diagnostics",
      settings: [
        {
          id: settingId("github-connection"),
          label: "GitHub connection",
          scope: "host",
          keywords: "connection scopes refresh credential token secure storage sign in login",
        },
        {
          id: settingId("github-logout"),
          label: "Log out of GitHub",
          scope: "host",
          keywords: "log out logout sign out disconnect remove credential",
        },
      ],
    },
    {
      id: "linear",
      label: "Linear",
      scope: "host",
      keywords:
        "linear workspace authentication connection setup oauth connect disconnect reconnect issues personal api key",
      settings: [
        {
          id: settingId("linear-connection"),
          label: "Linear connection",
          scope: "host",
          keywords: "connect reconnect refresh connection sign in login",
        },
        {
          id: settingId("linear-disconnect"),
          label: "Disconnect Linear",
          scope: "host",
          keywords: "disconnect log out logout sign out remove credentials",
        },
      ],
    },
    {
      id: "permissions",
      label: "Permissions",
      scope: "host",
      keywords:
        "permissions remembered websites sites origins browser always allow forget public links share sharing remembered tool approvals extension tools revoke trust allowed",
      settings: [
        {
          id: settingId("public-links"),
          label: "Public links",
          scope: "host",
          keywords:
            "public links canvas publish share anyone with the link service stores can read switch off on",
        },
        {
          id: settingId("public-link-service"),
          label: "Service address",
          scope: "host",
          keywords: "public links service address url canvas.octant.sh self-hosted publish",
        },
        {
          id: settingId("browser-site-approvals"),
          label: "Remembered websites",
          scope: "host",
          keywords:
            "remembered websites browser origin site approval allow always forget revoke open page permission",
        },
        {
          id: settingId("tool-approvals"),
          label: "Remembered tool approvals",
          scope: "host",
          keywords:
            "remembered tool approvals mcp plugin extension server project allow always revoke ask again permission",
        },
      ],
    },
    {
      id: "data",
      label: "Data & storage",
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
      id: "sync",
      label: "Sync",
      scope: "host",
      keywords:
        "sync artifacts replica store synced folder dropbox icloud onedrive s3 bucket endpoint region prefix access key secret keychain test connection probe other computers",
      settings: [
        {
          id: settingId("sync-store"),
          label: "Store",
          scope: "host",
          keywords:
            "store synced folder s3 bucket endpoint region prefix addressing access key secret",
        },
        {
          id: settingId("sync-enabled"),
          label: "Sync artifacts",
          scope: "host",
          keywords: "sync on off switch artifacts storage provider readable signed not encrypted",
        },
        {
          id: settingId("sync-test-connection"),
          label: "Test connection",
          scope: "host",
          keywords: "test connection probe file store bucket folder",
        },
        {
          id: settingId("sync-folder"),
          label: "Sync folder",
          scope: "app",
          keywords: "sync folder synced icloud dropbox store",
        },
        {
          id: settingId("sync-bucket"),
          label: "Sync bucket",
          scope: "app",
          keywords: "sync bucket s3 access key secret store",
        },
        {
          id: settingId("sync-computer-name"),
          label: "Computer name",
          scope: "app",
          keywords: "computer name device sync",
        },
        {
          id: settingId("sync-create-replica"),
          label: "Set up sync",
          scope: "app",
          keywords: "set up sync start create",
        },
        {
          id: settingId("sync-join-replica"),
          label: "Join another computer",
          scope: "app",
          keywords: "join another computer sync",
        },
        {
          id: settingId("sync-leave-without-store"),
          label: "Leave sync without telling the others",
          scope: "app",
          keywords: "leave sync stop without store",
        },
        {
          id: settingId("sync-members"),
          label: "Sync members and requests",
          scope: "app",
          keywords: "sync members computers approvers join requests",
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
        {
          id: settingId("remote-pairing-code"),
          label: "Pairing code",
          scope: "host",
          keywords: "pairing code pair phone device single use",
        },
        {
          id: settingId("hub-role"),
          label: "Act as hub",
          scope: "host",
          keywords: "hub act as hub role roster members spokes add device join code tailscale",
        },
        {
          id: settingId("hub-join"),
          label: "Join a hub",
          scope: "host",
          keywords: "hub join spoke code comparison grant leave roster introduce owners",
        },
        {
          id: settingId("paired-computers-code"),
          label: "Pair with another computer",
          scope: "host",
          keywords: "pair pairing another computer code",
        },
      ],
    },
    {
      id: "host",
      label: "Host",
      scope: "host",
      keywords:
        "host service lifecycle stop restart enable disable startup policy identity owner mode versions readiness store replay clients uptime capabilities headless automation notifications push waiting approval failure completion apns fcm federated hosts maintenance reset layout window bounds diagnostics export support",
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
        {
          id: settingId("journal-growth"),
          label: "Journal growth",
          scope: "host",
          keywords: "journal growth events per day kind rows database size diagnostics",
        },
        {
          id: settingId("host-automatic-startup"),
          label: "Automatic startup",
          scope: "host",
          keywords: "automatic startup launch at login start",
        },
        {
          id: settingId("host-backup"),
          label: "Host snapshot",
          scope: "host",
          keywords: "snapshot backup restore before risky changes",
        },
        {
          id: settingId("host-lifecycle"),
          label: "Host process",
          scope: "host",
          keywords: "host process stop restart",
        },
      ],
    },
    {
      id: "ssh-targets",
      label: "SSH targets",
      scope: "host",
      // Shown only in a desktop window: a paired browser cannot administer targets.
      keywords:
        "ssh target remote machine server devbox host key fingerprint pin executor attest confinement bubblewrap connect remote folder project worktree terminal shell",
      settings: [
        {
          id: settingId("ssh-target-add"),
          label: "Add an SSH target",
          scope: "host",
          keywords: "add register ssh target destination host key fingerprint pin executor",
        },
        {
          id: settingId("ssh-targets-list"),
          label: "SSH targets",
          scope: "host",
          keywords: "connect reconnect re-pin repin remove attestation admitted refused recovery",
        },
        {
          id: settingId("ssh-remote-project-bind"),
          label: "Bind a remote folder",
          scope: "host",
          keywords: "bind remote folder project code root on target",
        },
        {
          id: settingId("ssh-remote-projects"),
          label: "Remote Projects",
          scope: "host",
          keywords: "remote project terminal shell worktree branch open remove",
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
