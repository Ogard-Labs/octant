import { describe, expect, it } from "vitest";
import {
  isPluginSettingsSectionEntryPoint,
  loadPluginSettingsSectionModule,
} from "./pluginModuleRegistry";

describe("plugin module registry", () => {
  it("returns the built-in GitHub settings module", () => {
    const Module = loadPluginSettingsSectionModule("builtin:github/settings");
    expect(Module).toBeDefined();
    expect(Module.name).toBe("GitHubSettingsSectionModule");
  });

  it("reports the built-in GitHub entry point as registered", () => {
    expect(isPluginSettingsSectionEntryPoint("builtin:github/settings")).toBe(true);
  });

  it("reports unknown entry points as unregistered", () => {
    expect(isPluginSettingsSectionEntryPoint("unknown:plugin/settings")).toBe(false);
  });

  it("throws for unknown entry points", () => {
    expect(() => loadPluginSettingsSectionModule("unknown:plugin/settings")).toThrow(
      "Unknown plugin settings-section entry point: unknown:plugin/settings",
    );
  });
});
