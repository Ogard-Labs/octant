import { describe, expect, it } from "vitest";
import { octantSettingsRegistry } from "./octantSettingsRegistry";

describe("octantSettingsRegistry", () => {
  it("registers only sections with working content, in navigation order", () => {
    expect(octantSettingsRegistry.sections.map((s) => s.id)).toEqual([
      "general",
      "profile",
      "appearance",
      "keybindings",
      "chat",
      "work",
      "code",
      "providers",
      "harness",
      "navigator-assistant",
      "voice",
      "image-generation",
      "computer-use",
      "skills",
      "github",
      "linear",
      "host",
      "data",
      "remote-access",
      "usage",
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

  it("keeps the running host and its maintenance on Host, and its data on Data & privacy", () => {
    const host = octantSettingsRegistry.sections.find((s) => s.id === "host");
    const data = octantSettingsRegistry.sections.find((s) => s.id === "data");
    expect(host?.scope).toBe("host");
    expect(host?.settings.map((setting) => setting.id)).toEqual([
      "host-automation-notifications",
      "reset-layout",
      "reset-window-bounds",
      "export-diagnostics",
    ]);
    expect(host?.keywords).toMatch(/lifecycle/);
    expect(host?.keywords).toMatch(/diagnostics/);
    expect(data?.label).toBe("Data & privacy");
    expect(data?.scope).toBe("host");
    expect(data?.settings.map((setting) => setting.id)).toEqual(["data-map", "thread-retention"]);
    expect(data?.keywords).toMatch(/backup/);
    expect(data?.keywords).toMatch(/retention/);
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

  it("registers Glass cards beside Glass, ungated", () => {
    const appearance = octantSettingsRegistry.sections.find((s) => s.id === "appearance");
    const material = appearance?.settings.find((s) => s.id === "workspace-material");
    expect(material?.label).toBe("Glass cards");
    expect(material?.nativeRequired).toBeUndefined();
  });

  it("keeps opaque sections without individual settings and registers the Code setup destinations", () => {
    for (const id of ["providers", "usage"] as const) {
      const section = octantSettingsRegistry.sections.find((s) => s.id === id);
      expect(section?.settings).toEqual([]);
    }
    const code = octantSettingsRegistry.sections.find((section) => section.id === "code");
    expect(code?.settings.map((setting) => setting.id)).toEqual([
      "code-default-folder-threads",
      "project-view-switcher",
    ]);
    const chat = octantSettingsRegistry.sections.find((section) => section.id === "chat");
    expect(chat?.settings.map((setting) => setting.id)).toEqual(["stream-replies"]);
  });

  it("keeps the helper-agent posture with the Octant Harness it governs", () => {
    const ids = octantSettingsRegistry.sections.map((section) => String(section.id));
    expect(ids).not.toContain("agents");
    const harness = octantSettingsRegistry.sections.find((s) => s.id === "harness");
    expect(harness?.settings.map((setting) => setting.id)).toEqual(["subagent-creation-posture"]);
    expect(harness?.keywords).toMatch(/posture/);
  });
});
