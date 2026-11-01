import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTION_IDS,
  SettingsDeepLink,
  type SettingsDeepLink as SettingsDeepLinkType,
  SettingsSectionId,
  SettingsSettingId,
} from "./settings";

describe("SettingsSectionId", () => {
  it("enumerates the durable Settings information architecture", () => {
    expect(SETTINGS_SECTION_IDS).toEqual([
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
      "access",
      "memory",
      "secret-stores",
      "data",
      "sync",
      "remote-access",
      "host",
      "usage",
    ]);
  });

  it("decodes a known section id and rejects an unknown one", () => {
    expect(Schema.decodeUnknownSync(SettingsSectionId)("appearance")).toBe("appearance");
    expect(Schema.decodeUnknownSync(SettingsSectionId)("github")).toBe("github");
    expect(() => Schema.decodeUnknownSync(SettingsSectionId)("theme")).toThrow();
  });
});

describe("SettingsSettingId", () => {
  it("decodes a non-empty trimmed string and rejects empty or whitespace", () => {
    expect(Schema.decodeUnknownSync(SettingsSettingId)("sidebar-width")).toBe("sidebar-width");
    expect(() => Schema.decodeUnknownSync(SettingsSettingId)("")).toThrow();
    expect(() => Schema.decodeUnknownSync(SettingsSettingId)("  ")).toThrow();
  });
});

describe("SettingsDeepLink", () => {
  it("decodes a section-only deep link", () => {
    expect(Schema.decodeUnknownSync(SettingsDeepLink)({ section: "providers" })).toEqual({
      section: "providers",
    });
  });

  it("decodes a section plus focused setting deep link", () => {
    expect(
      Schema.decodeUnknownSync(SettingsDeepLink)({
        section: "appearance",
        setting: "sidebar-width",
      }),
    ).toEqual({ section: "appearance", setting: "sidebar-width" });
  });

  it("reads a link to a retired section as the section that holds its settings now", () => {
    const decode = Schema.decodeUnknownSync(SettingsDeepLink);
    expect(decode({ section: "advanced", setting: "reset-layout" })).toEqual({
      section: "host",
      setting: "reset-layout",
    });
    expect(decode({ section: "agents" })).toEqual({ section: "harness" });
    // Pages folded into another by the 2026-10 regrouping.
    expect(decode({ section: "provider-catalog" })).toEqual({ section: "providers" });
    expect(decode({ section: "navigator-assistant", setting: "default-model" })).toEqual({
      section: "harness",
      setting: "default-model",
    });
    expect(decode({ section: "image-generation" })).toEqual({ section: "voice" });
    // A link to the removed SSH targets page.
    expect(decode({ section: "ssh-targets", setting: "ssh-target-add" })).toEqual({
      section: "host",
      setting: "ssh-target-add",
    });
    expect(Schema.encodeSync(SettingsDeepLink)({ section: "host" })).toEqual({ section: "host" });
  });

  it("rejects a deep link without a section", () => {
    expect(() =>
      Schema.decodeUnknownSync(SettingsDeepLink)({ setting: "sidebar-width" }),
    ).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() =>
      Schema.decodeUnknownSync(SettingsDeepLink)({
        section: "appearance",
        setting: "sidebar-width",
        host: "local",
      }),
    ).toThrow();
  });

  it("has a typed SettingsDeepLink export usable by consumers", () => {
    const link: SettingsDeepLinkType = { section: "general" };
    expect(link.section).toBe("general");
  });
});
