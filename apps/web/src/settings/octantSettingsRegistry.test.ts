import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsCommandPages } from "./octantSettingsNavigation";
import { octantSettingsRegistry } from "./octantSettingsRegistry";
import {
  listAvailableSections,
  resolveDeepLink,
  searchSettings,
  withoutAbsentContributions,
} from "./registry";

const capabilities = { nativeBoundsAvailable: true, sidebarVibrancySupported: true };

describe("octantSettingsRegistry", () => {
  it.each([
    ["Chat thread titles", "automatic-model-thread-title"],
    ["ChatGPT plan title model", "automatic-model-thread-title"],
    ["API endpoint title model", "automatic-model-thread-title"],
    ["Thread title model", "automatic-model-thread-title-model"],
  ])("finds the title control for %s", (query, settingId) => {
    const results = searchSettings(
      listAvailableSections(octantSettingsRegistry, capabilities),
      capabilities,
      query,
    );
    expect(results).toContainEqual(
      expect.objectContaining({ kind: "setting", sectionId: "providers", settingId }),
    );
    if (settingId === "automatic-model-thread-title") {
      expect(results).not.toContainEqual(
        expect.objectContaining({ settingId: "automatic-model-thread-title-model" }),
      );
    }
  });

  it("finds the switch that stops this computer taking delegated work by its label", () => {
    expect(
      searchSettings(
        listAvailableSections(octantSettingsRegistry, capabilities),
        capabilities,
        "Take delegated work from other members",
      ),
    ).toContainEqual(
      expect.objectContaining({
        kind: "setting",
        sectionId: "remote-access",
        settingId: "hub-delegation-accepting",
      }),
    );
  });

  it.each([
    ["Public entrance", "hub-public-entrance"],
    ["Tailscale Funnel", "hub-public-funnel"],
    ["Serve the public entrance", "hub-public-standby"],
    ["Visitor links", "hub-visitor-links"],
    ["Webhook endpoints", "hub-webhook-endpoints"],
    ["Device relay", "hub-device-relay"],
  ])("finds the public entrance control %s by its name, first", (query, setting) => {
    expect(
      searchSettings(
        listAvailableSections(octantSettingsRegistry, capabilities),
        capabilities,
        query,
      )[0],
    ).toMatchObject({ kind: "setting", sectionId: "public-entrance", settingId: setting });
  });

  it.each(["transcribe", "transcription"])("finds the Transcribe with menu by %s", (query) => {
    expect(
      searchSettings(
        listAvailableSections(octantSettingsRegistry, capabilities),
        capabilities,
        query,
      ),
    ).toContainEqual(
      expect.objectContaining({ kind: "setting", sectionId: "voice", settingId: "transcription" }),
    );
  });

  it.each(["changed identity", "read-only check"])(
    "finds the read-only remote setup journey for %s",
    (query) => {
      expect(
        searchSettings(
          listAvailableSections(octantSettingsRegistry, capabilities),
          capabilities,
          query,
        ),
      ).toContainEqual(
        expect.objectContaining({
          kind: "setting",
          sectionId: "remote-access",
          settingId: "remote-setup-checks",
          scope: "host",
        }),
      );
    },
  );
  it.each([
    ["gcloud", "secret-store-google-cli"],
    ["service account email", "secret-store-google-cli-email"],
    ["service account JSON item", "secret-store-google-cli-reference"],
    ["Google OAuth scopes", "secret-store-google-cli-scopes"],
  ] as const)(
    "finds the Google command-line control for %s and resolves its exact host row",
    (query, setting) => {
      expect(
        searchSettings(
          listAvailableSections(octantSettingsRegistry, capabilities),
          capabilities,
          query,
        ),
      ).toContainEqual(
        expect.objectContaining({
          kind: "setting",
          sectionId: "secret-stores",
          settingId: setting,
          scope: "host",
        }),
      );
      const resolved = resolveDeepLink(octantSettingsRegistry, capabilities, {
        section: "secret-stores",
        setting,
      });
      expect(resolved?.section.id).toBe("secret-stores");
      expect(resolved?.settingId).toBe(setting);
    },
  );

  it.each(["Google Cloud project", "Google Cloud location"])(
    "finds the provider sign-in method by its Agent Platform fields, %s",
    (query) => {
      expect(
        searchSettings(
          listAvailableSections(octantSettingsRegistry, capabilities),
          capabilities,
          query,
        ),
      ).toContainEqual(
        expect.objectContaining({
          kind: "setting",
          sectionId: "providers",
          settingId: "provider-authentication",
        }),
      );
    },
  );

  it("registers only sections with working content, in navigation order", () => {
    expect(octantSettingsRegistry.sections.map((s) => s.id)).toEqual([
      "general",
      "appearance",
      "background",
      "text",
      "sidebar",
      "keybindings",
      "chat-work",
      "code",
      "providers",
      "harness",
      "voice",
      "skills",
      "computer-use",
      "integrations",
      "permissions",
      "limits",
      "memory",
      "secret-stores",
      "data",
      "sync",
      "remote-access",
      "public-entrance",
      "host",
      "usage",
    ]);
    expect(settingsCommandPages(() => true).map(({ id, label }) => ({ id, label }))).toEqual(
      octantSettingsRegistry.sections.map(({ id, label }) => ({ id, label })),
    );
  });

  it("offers the palette the pages Settings itself would list for the plugins that are on", () => {
    const sections = listAvailableSections(octantSettingsRegistry, capabilities);
    for (const off of [[], ["github"], ["linear"], ["github", "linear"]]) {
      const present = (section: string) => !off.includes(section);
      expect(
        settingsCommandPages(present).map((page) => page.id),
        `with ${off.join(" and ") || "nothing"} off`,
      ).toEqual(withoutAbsentContributions(sections, present).map((section) => section.id));
    }
    const names = (...off: ReadonlyArray<string>) =>
      settingsCommandPages((section) => !off.includes(section)).find(
        (page) => page.id === "integrations",
      )?.alsoFoundAs;
    expect(names()).toEqual(["Web search", "GitHub", "Linear"]);
    expect(names("github")).toEqual(["Web search", "Linear"]);
    // Web search is the host's own, so the page outlives both plugins.
    expect(names("github", "linear")).toEqual(["Web search"]);
  });

  // Permissions had grown to fifty settings, Appearance to forty and General
  // to thirty-eight, while GitHub, Linear, Web search, Device tools and To-dos
  // held one to three each (counted 2026-11-25).
  it("keeps a page between four and thirty settings, but for the pages that are one tool", () => {
    const ONE_TOOL = new Set(["keybindings", "usage"]);
    const outside = octantSettingsRegistry.sections
      .filter((section) => !ONE_TOOL.has(section.id))
      .filter((section) => section.settings.length < 4 || section.settings.length > 30)
      .map((section) => `${section.label}: ${section.settings.length}`);
    expect(outside).toEqual([]);
  });

  it("splits what Appearance held into the look, what is drawn behind it, and how text is set", () => {
    const ids = (id: string) =>
      octantSettingsRegistry.sections.find((s) => s.id === id)?.settings.map((s) => String(s.id));
    expect(ids("appearance")).toEqual([
      "sidebar-material",
      "glass-tint",
      "appearance.scheme.light-preset",
      "appearance.scheme.dark-preset",
      "appearance.custom",
      "appearance.density",
      "appearance.scheme.style",
      "appearance.accessibility.increased-contrast",
      "appearance.theme-import-export",
      "reset-appearance",
      "appearance.scheme.accent",
      "appearance.accessibility.reduced-motion",
      "appearance.accessibility.reduced-transparency",
    ]);
    expect(ids("background")?.every((id) => id.startsWith("app-background"))).toBe(true);
    expect(ids("background")).toHaveLength(13);
    expect(ids("text")?.filter((id) => !id.startsWith("appearance.typography."))).toEqual([
      "transcript-text-size",
      "transcript-width",
      "reply-detail",
    ]);
    expect(ids("text")).toHaveLength(14);
  });

  it("registers Integrations as a host-scoped page of web search and the rows each plugin contributes", () => {
    const integrations = octantSettingsRegistry.sections.find((s) => s.id === "integrations");
    expect(integrations?.label).toBe("Integrations");
    expect(integrations?.scope).toBe("host");
    expect(
      integrations?.settings.map((setting) => [setting.id, setting.contributedSection]),
    ).toEqual([
      ["web-search-policy", undefined],
      ["web-search-provider-search", undefined],
      ["web-search-add", undefined],
      ["github-connection", "github"],
      ["github-logout", "github"],
      ["linear-connection", "linear"],
      ["linear-projects", "linear"],
      ["linear-disconnect", "linear"],
    ]);
  });

  it("offers no row of a plugin that is switched off, and keeps web search when both are", () => {
    const sections = listAvailableSections(octantSettingsRegistry, capabilities);
    const rowsWithout = (...off: ReadonlyArray<string>) =>
      withoutAbsentContributions(sections, (section) => !off.includes(section))
        .find((section) => section.id === "integrations")
        ?.settings.map((setting) => setting.id);
    const webSearch = ["web-search-policy", "web-search-provider-search", "web-search-add"];
    expect(rowsWithout("github")).toEqual([
      ...webSearch,
      "linear-connection",
      "linear-projects",
      "linear-disconnect",
    ]);
    expect(rowsWithout("linear")).toEqual([...webSearch, "github-connection", "github-logout"]);
    expect(rowsWithout("github", "linear")).toEqual(webSearch);
    const found = (query: string, ...off: ReadonlyArray<string>) =>
      searchSettings(
        withoutAbsentContributions(sections, (section) => !off.includes(section)),
        capabilities,
        query,
      ).map((result) => (result.kind === "setting" ? result.settingId : result.sectionId));
    expect(found("github")).toContain("github-connection");
    expect(found("github", "github")).not.toContain("github-connection");
    expect(found("log out github", "github")).not.toContain("github-logout");
    // The words a person searched the two old pages by still find their rows.
    expect(found("oauth")).toContain("linear-connection");
    expect(found("revoke authorization")).toContain("github-connection");
    // Every other page is the page it was.
    expect(
      withoutAbsentContributions(sections, () => false).filter(
        (section) => section.id !== "integrations",
      ),
    ).toEqual(sections.filter((section) => section.id !== "integrations"));
  });

  it("keeps the running host on Host, what was allowed on Permissions, and stored data on Data & storage", () => {
    const section = (id: string) => octantSettingsRegistry.sections.find((s) => s.id === id);
    const ids = (id: string) => section(id)?.settings.map((setting) => setting.id);
    expect(section("host")?.scope).toBe("host");
    expect(ids("host")).toEqual([
      "resource-limits",
      "resource-maxCommands",
      "resource-maxWorkers",
      "resource-maxAgents",
      "resource-cpuTargetPercent",
      "resource-memoryReservePercent",
      "resource-save",
      "resource-pause",
      "resource-keepAwake",
      "resource-refresh",
      "reset-layout",
      "reset-window-bounds",
      "save-diagnostics",
      "export-diagnostics",
      "journal-growth",
      "host-automatic-startup",
      "host-memory-limits",
      "host-lifecycle",
    ]);
    expect(section("host")?.keywords).toMatch(/lifecycle/);
    expect(section("host")?.keywords).toMatch(/diagnostics/);
    expect(ids("general")?.slice(-6)).toEqual([
      "user-profile",
      "your-instructions",
      "orchestration-instructions",
      "host-phone-notifications",
      "host-push-gateway",
      "host-automation-notifications",
    ]);
    expect(section("permissions")?.label).toBe("Permissions");
    expect(ids("permissions")).toEqual([
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
      "browser-transfer-file-limit",
      "browser-held-download-limit",
      "browser-upload-file-count-limit",
      "tool-approvals",
      "network-limits",
      "safe-networks",
      "shield-servers-list",
      "shield-servers-add",
      "server-projects",
    ]);
    expect(section("limits")?.label).toBe("Limits");
    expect(section("limits")?.scope).toBe("host");
    expect(ids("limits")).toEqual([
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
    ]);
    expect(section("secret-stores")?.label).toBe("Secret stores");
    expect(section("secret-stores")?.scope).toBe("host");
    expect(ids("secret-stores")).toEqual([
      "secret-store-link",
      "secret-store-check",
      "secret-store-aws-cli",
      "secret-store-aws-cli-key-id",
      "secret-store-aws-cli-secret",
      "secret-store-google-cli",
      "secret-store-google-cli-email",
      "secret-store-google-cli-reference",
      "secret-store-google-cli-scopes",
      "thread-secrets-active",
      "thread-secrets-remembered",
    ]);
    expect(section("data")?.label).toBe("Data & storage");
    expect(section("data")?.scope).toBe("host");
    expect(ids("data")).toEqual([
      "data-map",
      "host-backup",
      "browser-accounts",
      "browser-profiles",
      "browser-upload-permissions",
      "browser-download-permissions",
      "browser-session-permissions",
      "persistent-browser-owner",
      "browser-flows",
      "browser-extensions",
      "thread-retention",
      "todo-list-host",
    ]);
    expect(section("data")?.keywords).toMatch(/backup/);
    expect(section("data")?.keywords).toMatch(/retention/);
  });

  it("registers Chat & Work with what a new Chat thread and a new Work thread start with", () => {
    const page = octantSettingsRegistry.sections.find((s) => s.id === "chat-work");
    expect(page?.label).toBe("Chat & Work");
    expect(page?.settings.map((setting) => [setting.id, setting.scope])).toEqual([
      ["stream-replies", "app"],
      ["chat-default-model", "app"],
      ["chat-fallback-model", "app"],
      ["chat-personality", "app"],
      ["chat-research-enabled", "app"],
      ["chat-research-backend", "app"],
      ["chat-restart-continuation", "mode"],
      ["work-default-model", "host"],
      ["work-default-access", "host"],
      ["work-strict", "host"],
      ["work-restart-continuation", "mode"],
    ]);
  });

  it("names two rows that share a page apart in search", () => {
    for (const section of octantSettingsRegistry.sections) {
      const labels = section.settings.map((setting) => setting.label);
      const repeated = labels.filter((label, index) => labels.indexOf(label) !== index);
      expect(repeated, section.label).toEqual([]);
    }
  });

  it("keeps Device tools' two rows on Computer use, found by the tools' own words", () => {
    const computerUse = octantSettingsRegistry.sections.find((s) => s.id === "computer-use");
    expect(computerUse?.settings.slice(-2).map((setting) => setting.id)).toEqual([
      "managed-tools-automatic-updates",
      "managed-tools-update-check",
    ]);
    const results = searchSettings(
      listAvailableSections(octantSettingsRegistry, capabilities),
      capabilities,
      "simulator",
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        sectionId: "computer-use",
        settingId: "managed-tools-automatic-updates",
      }),
    );
  });

  it("registers marketplace fetches with the Skills & Extensions it governs", () => {
    const skills = octantSettingsRegistry.sections.find((s) => s.id === "skills");
    const marketplace = skills?.settings.find((s) => s.id === "marketplace-fetches");
    expect(marketplace).toEqual({
      id: "marketplace-fetches",
      label: "Marketplace fetches",
      scope: "host",
      keywords:
        "marketplace fetches skills npm github registry catalog search inspect install privacy off",
    });
  });

  it("keeps keyboard shortcuts in their own Settings destination", () => {
    const general = octantSettingsRegistry.sections.find((s) => s.id === "general");
    const keybindings = octantSettingsRegistry.sections.find((s) => s.id === "keybindings");

    expect(general?.settings.some((setting) => setting.id === "keybindings")).toBe(false);
    expect(keybindings).toMatchObject({
      label: "Keybindings",
      scope: "app",
    });
    expect(keybindings?.settings.map((setting) => setting.id)).toEqual(["keybindings"]);
  });

  it("registers the Skills & Extensions section with marketplace/installed keywords", () => {
    const skills = octantSettingsRegistry.sections.find((s) => s.id === "skills");
    expect(skills?.label).toBe("Skills & Extensions");
    expect(skills?.scope).toBe("host");
    expect(skills?.keywords).toMatch(/marketplace/);
    expect(skills?.keywords).toMatch(/installed/);
  });

  it("titles the provider section Providers & Models", () => {
    const providers = octantSettingsRegistry.sections.find((s) => s.id === "providers");
    expect(providers?.label).toBe("Providers & Models");
  });

  it("does not offer retired execution-profile settings", () => {
    const ids = octantSettingsRegistry.sections.map((section) => String(section.id));
    expect(ids).not.toContain("profiles");
    expect(ids).not.toContain("advanced");
  });

  it("gates reset-window-bounds on native bounds availability", () => {
    const host = octantSettingsRegistry.sections.find((s) => s.id === "host");
    const resetBounds = host?.settings.find((s) => s.id === "reset-window-bounds");
    expect(resetBounds?.nativeRequired).toBe("nativeBoundsAvailable");
  });

  it("does not gate the Glass control on vibrancy support", () => {
    const appearance = octantSettingsRegistry.sections.find((s) => s.id === "appearance");
    const material = appearance?.settings.find((s) => s.id === "sidebar-material");
    expect(material?.nativeRequired).toBeUndefined();
  });

  it("registers the spend ceiling switch and the two usage-limit defaults in Usage, and the provider and Code setup destinations", () => {
    const usage = octantSettingsRegistry.sections.find((s) => s.id === "usage");
    expect(usage?.settings.map((setting) => setting.id)).toEqual([
      "spend-ceiling-shown",
      "usage-limit-resume-by-default",
      "usage-limit-snooze-by-default",
    ]);
    const providers = octantSettingsRegistry.sections.find((s) => s.id === "providers");
    expect(providers?.settings.map((setting) => setting.id)).toEqual([
      "automatic-model-thread-title",
      "automatic-model-thread-title-model",
      "automatic-model-judge",
      "automatic-model-memory",
      "automatic-model-decision-review",
      "stalled-turn-limit",
      "full-access-stalled-turn-limit",
      "provider-tool-call-pause-limit",
      "background-session-idle-limit",
      "provider-own-telemetry",
      "provider-self-update",
      "provider-credential-pass-through",
      "provider-credential-pass-through-add",
      "opencode-managed-update",
      "provider-display-name",
      "provider-binary-path",
      "provider-authentication",
      "provider-api-key",
      "provider-base-url",
      "provider-protocol",
      "provider-manual-model-ids",
      "provider-deployment-ids",
      "provider-claude-account",
      "provider-claude-artifacts",
      "provider-web-tools",
      "provider-native-setup",
      "provider-own-memory",
    ]);
    const code = octantSettingsRegistry.sections.find((section) => section.id === "code");
    expect(code?.settings.map((setting) => setting.id)).toEqual([
      "code-default-model",
      "code-require-git",
      "code-default-diff-layout",
      "code-restart-continuation",
      "code-language-services",
      "code-android-snapshot-boot",
      "code-coordinator-starting",
      "code-coordinator-show-workers",
      "code-coordinator-open-workers",
      "project-view-switcher",
      "code-default-access",
      "code-auto-reviewer",
      "code-strict",
      "code-terminal-shell",
      "code-worktree-branch-prefix",
      "code-worktree-branch-naming",
      "code-worktree-cleanup-archive",
      "code-worktree-cleanup-merged",
      "code-worktree-cleanup-inactivity",
      "code-worktree-cleanup-days",
      "code-editor-executable",
      "code-editor-arguments",
      "archived-worktrees",
      "cleaned-up-worktrees",
      "host-worktrees",
      "xcode-build-data",
      "open-in-applications",
    ]);
  });

  it("does not offer the worktree lists in search where the window has no such section", () => {
    const search = (caps: Parameters<typeof searchSettings>[1]) =>
      searchSettings(
        listAvailableSections(octantSettingsRegistry, caps),
        caps,
        "cleaned-up worktrees",
      )
        .map((result) => (result.kind === "setting" ? String(result.settingId) : ""))
        .filter((id) => id.endsWith("worktrees"));
    // A window with neither list client draws neither section.
    expect(search(capabilities)).toEqual([]);
    expect(search({ ...capabilities, worktreeListsAvailable: true })).toContain(
      "cleaned-up-worktrees",
    );
    expect(search({ ...capabilities, worktreeListsAvailable: true })).not.toContain(
      "host-worktrees",
    );
    const disk = searchSettings(
      listAvailableSections(octantSettingsRegistry, {
        ...capabilities,
        diskCleanupAvailable: true,
      }),
      { ...capabilities, diskCleanupAvailable: true },
      "worktrees on this computer",
    ).map((result) => (result.kind === "setting" ? String(result.settingId) : ""));
    expect(disk).toContain("host-worktrees");
  });

  it("keeps the helper-agent posture with the Octant Harness it governs", () => {
    const ids = octantSettingsRegistry.sections.map((section) => String(section.id));
    expect(ids).not.toContain("agents");
    const harness = octantSettingsRegistry.sections.find((s) => s.id === "harness");
    expect(harness?.settings.map((setting) => setting.id)).toEqual([
      "model-endpoints",
      "provider-cloud-sessions",
      "model-roles",
      "subagent-creation-posture",
      "subagent-concurrency-on-host",
      "subagent-concurrency-per-thread",
      "subagent-working-minutes",
      "subagent-no-limit-full-access",
      "subagent-provider-wait-minutes",
      "default-model",
      "vision-reviewer",
    ]);
    expect(harness?.keywords).toMatch(/posture/);
  });

  it("finds the helper working-time budget at its rendered Settings row", () => {
    expect(
      searchSettings(
        listAvailableSections(octantSettingsRegistry, capabilities),
        capabilities,
        "helper working minutes",
      ),
    ).toContainEqual(
      expect.objectContaining({ sectionId: "harness", settingId: "subagent-working-minutes" }),
    );
  });

  it("finds Model roles by the name Settings uses and by the slot names the CLI keeps", () => {
    const sections = listAvailableSections(octantSettingsRegistry, capabilities);
    for (const query of ["model roles", "main model", "advisor", "smol"]) {
      expect(searchSettings(sections, capabilities, query)).toContainEqual(
        expect.objectContaining({ sectionId: "harness", settingId: "model-roles" }),
      );
    }
  });

  it("finds API model endpoints under Octant Harness rather than Providers & Models", () => {
    const sections = listAvailableSections(octantSettingsRegistry, capabilities);
    for (const query of [
      "openai-compatible",
      "sign in with chatgpt",
      "azure ai foundry",
      "zero data retention",
      "key refused",
      "verify tools",
    ]) {
      const results = searchSettings(sections, capabilities, query);
      expect(results).toContainEqual(
        expect.objectContaining({ sectionId: "harness", settingId: "model-endpoints" }),
      );
      expect(results.map((result) => result.sectionId)).not.toContain("providers");
    }
  });

  it("finds the OpenAI image profile on Voice & images first", () => {
    const results = searchSettings(
      listAvailableSections(octantSettingsRegistry, capabilities),
      capabilities,
      "openai image",
    );
    expect(results[0]?.sectionId).toBe("voice");
  });

  it("lands a link to the model endpoints on the add-endpoint row of Octant Harness", () => {
    const resolved = resolveDeepLink(octantSettingsRegistry, capabilities, {
      section: "harness",
      setting: "model-endpoints",
    });
    expect(resolved?.section.id).toBe("harness");
    expect(resolved?.settingId).toBe("model-endpoints");
  });

  it("finds the everyday words people search Settings with", () => {
    const available = listAvailableSections(octantSettingsRegistry, capabilities);
    const first = (query: string) => {
      const result = searchSettings(available, capabilities, query)[0];
      return result === undefined
        ? undefined
        : result.kind === "setting"
          ? `${result.sectionId}/${result.settingId}`
          : result.sectionId;
    };
    expect(first("dark mode")).toBe("appearance/appearance.scheme.dark-preset");
    expect(first("password")).not.toBe("keybindings/keybindings");
    expect(first("password")).toBeDefined();
    expect(first("delete my data")).toBe("data/thread-retention");
    // "telemetry" also reaches Safe networks through its "network" synonym.
    const telemetry = searchSettings(available, capabilities, "telemetry").map((result) =>
      result.kind === "setting" ? `${result.sectionId}/${result.settingId}` : result.sectionId,
    );
    expect(telemetry).toContain("data/data-map");
    // "connector" also reaches Browser extensions through the word "extension",
    // and Access's Servers through "server", so the Skills page is among the
    // first answers rather than always the first.
    expect(
      searchSettings(available, capabilities, "connector")
        .slice(0, 4)
        .map((result) => result.sectionId),
    ).toContain("skills");
    expect(first("sign out github")).toBe("integrations/github-logout");
    expect(first("to-do")).toBe("data/todo-list-host");
    expect(first("notif")).toBeDefined();
    expect(first("display name")).toBe("providers/provider-display-name");
  });
});

/**
 * Rows a person only passes through (onboarding steps, progress while a sync
 * joins or restores, placeholders shown while nothing is installed) or that
 * repeat a listed row (OpenCode's Update button sits on the listed OpenCode
 * update row). They carry a setting id so a deep link can land on them, but
 * they are not things a person looks up. Project instructions live on a
 * Project's overview, not in Settings, so Settings search does not list them.
 */
const UNLISTED_SETTING_ROWS = new Set([
  "app-background-characters-reset",
  "agent-access-code",
  "agent-access-edit",
  "browser-hub-claim",
  "browser-hub-joined",
  "first-run-task-mode",
  "first-run-task-project",
  "managed-tools-empty",
  "opencode-managed-available",
  "opencode-managed-update-action",
  "paired-computers-claim",
  "project-instructions",
  "sync-ask-again",
  "sync-join-read",
  "sync-leave-replica",
  "sync-restore",
]);

/**
 * Rows whose id names one item (a provider, an endpoint, a synced computer),
 * written as a template in the view. Each kind is indexed once by the row
 * named here, which opens the page that lists the items.
 */
const COMPUTED_SETTING_ROWS: Readonly<Record<string, string>> = {
  "appearance.custom.*.*": "appearance.custom",
  "appearance.custom.*.contrast": "appearance.custom",
  "resource-*": "resource-limits",
  "provider-*-display-name": "provider-display-name",
  "provider-*-binary-path": "provider-binary-path",
  "provider-*-authentication": "provider-authentication",
  "provider-*-oauth-offer": "provider-authentication",
  "provider-*-directory-tenant": "provider-authentication",
  "provider-*-directory-client": "provider-authentication",
  "provider-*-directory-device-code": "provider-authentication",
  "provider-*-directory-issuer": "provider-authentication",
  "provider-*-directory-scope": "provider-authentication",
  "provider-*-google-cloud-project": "provider-authentication",
  "provider-*-google-cloud-location": "provider-authentication",
  "provider-*-bedrock-*": "provider-authentication",
  "provider-*-bedrock-models": "provider-manual-model-ids",
  "provider-*-api-key": "provider-api-key",
  "provider-*-key-header": "provider-authentication",
  "provider-*-base-url": "provider-base-url",
  "provider-*-protocol": "provider-protocol",
  "provider-*-protocol-version": "provider-protocol",
  "provider-*-manual-model-ids": "provider-manual-model-ids",
  "provider-*-deployment-ids": "provider-deployment-ids",
  "provider-*-claude-artifacts": "provider-claude-artifacts",
  "provider-*-native-setup": "provider-native-setup",
  "provider-*-web-tools": "provider-web-tools",
  "provider-*-own-memory": "provider-own-memory",
  "provider-tooling-*": "provider-tooling-configured",
  "*-config-directory": "provider-claude-account",
  "*-accent": "provider-claude-account",
  "*-auth-login": "provider-claude-account",
  "*-auth-status": "provider-claude-account",
  "opencode-managed-consent-*": "opencode-managed-update",
  "endpoint-*-key": "model-endpoints",
  "endpoint-*-name": "model-endpoints",
  "endpoint-*-remove": "model-endpoints",
  "harness-slot-*": "model-roles",
  "open-in-*": "open-in-applications",
  "managed-tool-*": "managed-tools-automatic-updates",
  "paired-computer-*": "paired-computers-code",
  "agent-grant-*": "agent-access",
  "hub-auto-apply-*": "hub-auto-apply",
  "sync-approver-*": "sync-members",
  "sync-join-request-*": "sync-members",
  "sync-member-*": "sync-members",
  "linear-account-*": "linear-connection",
  "linear-project-*": "linear-projects",
};

/** The typography rows `ThemeAppearanceEditor` builds from a surface and a field. */
const TYPOGRAPHY_ROWS = [
  "appearance.typography.ui.family",
  "appearance.typography.ui.size",
  "appearance.typography.editor.family",
  "appearance.typography.editor.size",
  "appearance.typography.editor.line-height",
  "appearance.typography.editor.ligatures",
  "appearance.typography.terminal.family",
  "appearance.typography.terminal.size",
  "appearance.typography.terminal.line-height",
  "appearance.typography.terminal.ligatures",
];

describe("Settings search coverage", () => {
  const sourceRoot = join(import.meta.dirname, "..");
  // The component gallery draws sample Settings rows to show the row's shape;
  // they are not rows of any Settings page, so search has nothing to index.
  const sources = readdirSync(sourceRoot, { recursive: true })
    .map(String)
    .filter(
      (name) => name.endsWith(".tsx") && !name.includes(".test.") && !/^gallery[\\/]/.test(name),
    )
    .map((name) => readFileSync(join(sourceRoot, name), "utf8"));
  const registered = new Set(
    octantSettingsRegistry.sections.flatMap((section) =>
      section.settings.map((setting) => String(setting.id)),
    ),
  );

  it("indexes every Settings row a person can see, so search never misses one", () => {
    const rendered = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(
        /settingId=(?:"([a-z0-9.-]+)"|\{settingId\("([a-z0-9.-]+)"\)\})/g,
      )) {
        const id = match[1] ?? match[2];
        if (id !== undefined) rendered.add(id);
      }
    }
    const missing = [...rendered].filter(
      (id) => !registered.has(id) && !UNLISTED_SETTING_ROWS.has(id),
    );
    expect(missing).toEqual([]);
  });

  it("indexes every kind of per-item Settings row by a row of its own", () => {
    const patterns = new Set<string>();
    for (const source of sources) {
      // A computed id is a template inside the attribute, which may wrap onto
      // the next line behind a condition.
      for (const match of source.matchAll(/settingId=\{[^`]{0,120}?`([^`]+)`/g)) {
        if (match[1] !== undefined) patterns.add(match[1].replace(/\$\{[^}]+\}/g, "*"));
      }
    }
    expect(patterns.size).toBeGreaterThan(0);
    const unclassified = [...patterns].filter((pattern) => !(pattern in COMPUTED_SETTING_ROWS));
    expect(unclassified).toEqual([]);
    const unindexed = Object.values(COMPUTED_SETTING_ROWS).filter((id) => !registered.has(id));
    expect(unindexed).toEqual([]);
    expect(TYPOGRAPHY_ROWS.filter((id) => !registered.has(id))).toEqual([]);
  });
});
