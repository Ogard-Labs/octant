import { describe, expect, it } from "vitest";
import { octantSettingsRegistry } from "./octantSettingsRegistry";

describe("octantSettingsRegistry", () => {
  it("registers only sections with working content, in IA order", () => {
    expect(octantSettingsRegistry.sections.map((s) => s.id)).toEqual([
      "general",
      "appearance",
      "keybindings",
      "chat",
      "code",
      "navigator-assistant",
      "voice",
      "providers",
      "profiles",
      "agents",
      "harness",
      "skills",
      "usage",
      "host",
      "github",
      "linear",
      "advanced",
    ]);
  });

  it("registers the GitHub section as an opaque host-scoped connection destination", () => {
    const github = octantSettingsRegistry.sections.find((s) => s.id === "github");
    expect(github?.label).toBe("GitHub");
    expect(github?.scope).toBe("host");
    expect(github?.settings).toEqual([]);
    expect(github?.keywords).toMatch(/authentication/);
    expect(github?.keywords).toMatch(/revoke/);
    expect(github?.keywords).toMatch(/repositories/);
  });

  it("registers the Host section as a host-scoped operational destination with notifications", () => {
    const host = octantSettingsRegistry.sections.find((s) => s.id === "host");
    expect(host?.label).toBe("Host");
    expect(host?.scope).toBe("host");
    expect(host?.settings).toEqual([
      {
        id: "data-map",
        label: "Data map",
        scope: "host",
        keywords:
          "data map privacy stored location journal projections artifacts credentials keychain secret-service caches provider calls update checks marketplace",
      },
      {
        id: "automation-notifications",
        label: "Automation notifications",
        scope: "host",
        keywords:
          "automation notifications push waiting approval failure completion opt-in redacted destinations receipts apns fcm unavailable",
      },
      {
        id: "thread-retention",
        label: "Thread retention",
        scope: "host",
        keywords: "thread retention window purge journal erase delete history",
      },
    ]);
    expect(host?.keywords).toMatch(/lifecycle/);
    expect(host?.keywords).toMatch(/backup/);
    expect(host?.keywords).toMatch(/service/);
    expect(host?.keywords).toMatch(/notifications/);
  });

  it("does not register placeholder sections for future work", () => {
    const ids = octantSettingsRegistry.sections.map((s) => s.id);
    expect(ids).not.toContain("work");
  });

  it("registers marketplace fetches next to Updates under General", () => {
    const general = octantSettingsRegistry.sections.find((s) => s.id === "general");
    const marketplace = general?.settings.find((s) => s.id === "marketplace-fetches");
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
    expect(skills?.settings).toEqual([]);
  });

  it("titles the provider section Providers & Models", () => {
    const providers = octantSettingsRegistry.sections.find((s) => s.id === "providers");
    expect(providers?.label).toBe("Providers & Models");
  });

  it("registers execution profiles as their own Settings destination", () => {
    const profiles = octantSettingsRegistry.sections.find((s) => s.id === "profiles");
    expect(profiles?.label).toBe("Profiles");
    expect(profiles?.settings).toEqual([]);
  });

  it("gates reset-window-bounds on native bounds availability", () => {
    const advanced = octantSettingsRegistry.sections.find((s) => s.id === "advanced");
    const resetBounds = advanced?.settings.find((s) => s.id === "reset-window-bounds");
    expect(resetBounds?.nativeRequired).toBe("nativeBoundsAvailable");
  });

  it("does not gate the translucent sidebar toggle on vibrancy support", () => {
    const appearance = octantSettingsRegistry.sections.find((s) => s.id === "appearance");
    const material = appearance?.settings.find((s) => s.id === "sidebar-material");
    expect(material?.nativeRequired).toBeUndefined();
  });

  it("registers the translucent workspace toggle beside the sidebar toggle, ungated", () => {
    const appearance = octantSettingsRegistry.sections.find((s) => s.id === "appearance");
    const material = appearance?.settings.find((s) => s.id === "workspace-material");
    expect(material?.label).toBe("Translucent workspace");
    expect(material?.nativeRequired).toBeUndefined();
  });

  it("keeps opaque sections without individual settings and registers the Code app launcher", () => {
    for (const id of ["chat", "providers", "skills", "usage"] as const) {
      const section = octantSettingsRegistry.sections.find((s) => s.id === id);
      expect(section?.settings).toEqual([]);
    }
    const code = octantSettingsRegistry.sections.find((section) => section.id === "code");
    expect(code?.settings.map((setting) => setting.id)).toEqual(["open-in-applications"]);
  });

  it("registers the Agents section as an opaque destination for the creation-posture policy", () => {
    const agents = octantSettingsRegistry.sections.find((s) => s.id === "agents");
    expect(agents?.label).toBe("Agents");
    expect(agents?.settings).toEqual([]);
    expect(agents?.keywords).toMatch(/posture/);
  });
});
