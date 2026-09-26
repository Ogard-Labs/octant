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
      "appearance",
      "sidebar",
      "keybindings",
      "chat",
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
