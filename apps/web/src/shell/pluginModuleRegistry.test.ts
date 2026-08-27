import { describe, expect, it } from "vitest";
import {
  isPluginSettingsSectionEntryPoint,
  loadPluginSettingsSectionModule,
} from "./pluginModuleRegistry";

describe("plugin settings-section module registry", () => {
  it("returns the built-in GitHub settings section module", () => {
    const result = loadPluginSettingsSectionModule("builtin:github/settings");
    expect(result.kind).toBe("ready");
  });

  it("reports built-in entry points as registered", () => {
    expect(isPluginSettingsSectionEntryPoint("builtin:github/settings")).toBe(true);
  });

  it("returns an unknown result for unregistered entry points", () => {
    const result = loadPluginSettingsSectionModule("unknown:plugin/settings");
    expect(result).toEqual({ kind: "unknown", entryPoint: "unknown:plugin/settings" });
    expect(isPluginSettingsSectionEntryPoint("unknown:plugin/settings")).toBe(false);
  });

  it("does not resolve inherited Object.prototype names", () => {
    expect(isPluginSettingsSectionEntryPoint("constructor")).toBe(false);
    expect(isPluginSettingsSectionEntryPoint("toString")).toBe(false);
    expect(loadPluginSettingsSectionModule("constructor").kind).toBe("unknown");
    expect(loadPluginSettingsSectionModule("toString").kind).toBe("unknown");
  });
});
