import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { octantSettingsRegistry } from "./octantSettingsRegistry";
import { listAvailableSections, resolveDeepLink, searchSettings } from "./registry";

const capabilities = { nativeBoundsAvailable: true, sidebarVibrancySupported: true };

describe("octantSettingsRegistry", () => {
  it("registers only sections with working content, in navigation order", () => {
    expect(octantSettingsRegistry.sections.map((s) => s.id)).toEqual([
      "general",
      "profile",
      "notifications",
      "appearance",
      "sidebar",
      "keybindings",
      "chat",
      "work",
      "code",
      "providers",
      "harness",
      "voice",
      "skills",
      "computer-use",
      "device-tools",
      "github",
      "linear",
      "permissions",
      "data",
      "sync",
      "remote-access",
      "host",
      "ssh-targets",
      "usage",
    ]);
  });

  it("registers the GitHub section as a host-scoped connection destination", () => {
    const github = octantSettingsRegistry.sections.find((s) => s.id === "github");
    expect(github?.label).toBe("GitHub");
    expect(github?.scope).toBe("host");
    expect(github?.settings.map((setting) => setting.id)).toEqual([
      "github-connection",
      "github-logout",
    ]);
    expect(github?.keywords).toMatch(/authentication/);
    expect(github?.keywords).toMatch(/revoke/);
    expect(github?.keywords).toMatch(/repositories/);
  });

  it("keeps the running host on Host, what was allowed on Permissions, and stored data on Data & storage", () => {
    const section = (id: string) => octantSettingsRegistry.sections.find((s) => s.id === id);
    const ids = (id: string) => section(id)?.settings.map((setting) => setting.id);
    expect(section("host")?.scope).toBe("host");
    expect(ids("host")).toEqual([
      "reset-layout",
      "reset-window-bounds",
      "export-diagnostics",
      "journal-growth",
      "host-automatic-startup",
      "host-backup",
      "host-lifecycle",
    ]);
    expect(section("host")?.keywords).toMatch(/lifecycle/);
    expect(section("host")?.keywords).toMatch(/diagnostics/);
    expect(ids("notifications")).toEqual(["host-automation-notifications"]);
    expect(section("permissions")?.label).toBe("Permissions");
    expect(ids("permissions")).toEqual([
      "public-links",
      "public-link-service",
      "browser-site-approvals",
      "tool-approvals",
    ]);
    expect(section("data")?.label).toBe("Data & storage");
    expect(section("data")?.scope).toBe("host");
    expect(ids("data")).toEqual(["data-map", "thread-retention"]);
    expect(section("data")?.keywords).toMatch(/backup/);
    expect(section("data")?.keywords).toMatch(/retention/);
  });

  it("registers Work with the two defaults a new Work thread starts with", () => {
    const work = octantSettingsRegistry.sections.find((s) => s.id === "work");
    expect(work?.scope).toBe("host");
    expect(work?.settings.map((setting) => setting.id)).toEqual([
      "work-default-model",
      "work-default-access",
    ]);
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

  it("keeps Usage opaque and registers the Chat and Code setup destinations", () => {
    const usage = octantSettingsRegistry.sections.find((s) => s.id === "usage");
    expect(usage?.settings).toEqual([]);
    const providers = octantSettingsRegistry.sections.find((s) => s.id === "providers");
    expect(providers?.settings.map((setting) => setting.id)).toEqual([
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
    ]);
    const code = octantSettingsRegistry.sections.find((section) => section.id === "code");
    expect(code?.settings.map((setting) => setting.id)).toEqual([
      "code-require-git",
      "code-default-diff-layout",
      "code-language-services",
      "project-view-switcher",
      "code-default-access",
      "code-approval-persistence",
      "code-editor-executable",
      "code-editor-arguments",
      "open-in-applications",
    ]);
    const chat = octantSettingsRegistry.sections.find((section) => section.id === "chat");
    expect(chat?.settings.map((setting) => setting.id)).toEqual([
      "stream-replies",
      "chat-default-model",
      "chat-fallback-model",
      "chat-personality",
      "chat-research-enabled",
      "chat-research-backend",
      "chat-searxng-url",
    ]);
  });

  it("keeps the helper-agent posture with the Octant Harness it governs", () => {
    const ids = octantSettingsRegistry.sections.map((section) => String(section.id));
    expect(ids).not.toContain("agents");
    const harness = octantSettingsRegistry.sections.find((s) => s.id === "harness");
    expect(harness?.settings.map((setting) => setting.id)).toEqual([
      "model-endpoints",
      "model-roles",
      "subagent-creation-posture",
      "subagent-concurrency-on-host",
      "subagent-concurrency-per-thread",
      "default-model",
      "vision-reviewer",
    ]);
    expect(harness?.keywords).toMatch(/posture/);
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
    expect(first("telemetry")).toBe("data/data-map");
    expect(first("connector")).toBe("skills");
    expect(first("sign out github")).toBe("github/github-logout");
    expect(first("notif")).toBeDefined();
    expect(first("display name")).toBe("providers/provider-display-name");
  });
});

/**
 * Rows a person only passes through (onboarding steps, progress while a sync
 * joins or restores, placeholders shown while nothing is installed) or that
 * repeat a listed row (OpenCode's Update button sits on the listed OpenCode
 * update row). They carry a setting id so a deep link can land on them, but
 * they are not things a person looks up.
 */
const UNLISTED_SETTING_ROWS = new Set([
  "first-run-task-mode",
  "first-run-task-project",
  "managed-tools-empty",
  "opencode-managed-available",
  "opencode-managed-update-action",
  "paired-computers-claim",
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
  "provider-*-display-name": "provider-display-name",
  "provider-*-binary-path": "provider-binary-path",
  "provider-*-authentication": "provider-authentication",
  "provider-*-oauth-offer": "provider-authentication",
  "provider-*-directory-tenant": "provider-authentication",
  "provider-*-directory-client": "provider-authentication",
  "provider-*-directory-device-code": "provider-authentication",
  "provider-*-directory-issuer": "provider-authentication",
  "provider-*-directory-scope": "provider-authentication",
  "provider-*-api-key": "provider-api-key",
  "provider-*-base-url": "provider-base-url",
  "provider-*-protocol": "provider-protocol",
  "provider-*-protocol-version": "provider-protocol",
  "provider-*-manual-model-ids": "provider-manual-model-ids",
  "provider-*-deployment-ids": "provider-deployment-ids",
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
  "ssh-target-*": "ssh-targets-list",
  "ssh-remote-project-*": "ssh-remote-projects",
  "ssh-remote-worktree-*": "ssh-remote-projects",
  "sync-approver-*": "sync-members",
  "sync-join-request-*": "sync-members",
  "sync-member-*": "sync-members",
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
  const sources = readdirSync(sourceRoot, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
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
