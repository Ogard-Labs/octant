import { describe, expect, it } from "vitest";
import {
  decodeBrowserExtensionEnabled,
  decodeBrowserExtensionsCommand,
  decodeBrowserExtensionsResult,
} from "./browserExtensions";

const projectId = "40000000-0000-4000-8000-000000000001";
const extensionId = "a".repeat(32);
const contentHash = "b".repeat(64);

describe("Browser extensions contract", () => {
  it("names a folder only by the receipt the native picker issued", () => {
    expect(decodeBrowserExtensionsCommand({ kind: "install", receiptId: "receipt-1" })).toEqual({
      kind: "install",
      receiptId: "receipt-1",
    });
    expect(() =>
      decodeBrowserExtensionsCommand({ kind: "install", path: "/Users/person/extension" }),
    ).toThrow();
    expect(() =>
      decodeBrowserExtensionsCommand({ kind: "install", receiptId: "r", path: "/x" }),
    ).toThrow();
  });

  it("imports from another browser by the ids its listing gave, never by a path", () => {
    const command = {
      kind: "import",
      browser: "brave",
      sourceProfile: "Default",
      sourceExtensionId: "abcdefghijklmnopabcdefghijklmnop",
    };
    expect(decodeBrowserExtensionsCommand(command)).toEqual(command);
    expect(() => decodeBrowserExtensionsCommand({ ...command, browser: "firefox" })).toThrow();
    expect(() =>
      decodeBrowserExtensionsCommand({ ...command, sourceExtensionId: "../../etc" }),
    ).toThrow();
    expect(() => decodeBrowserExtensionsCommand({ ...command, path: "/x" })).toThrow();
  });

  it("enables an extension in a stored profile for the version the person saw, never in Private", () => {
    expect(
      decodeBrowserExtensionsCommand({
        kind: "enable",
        extensionId,
        profile: { kind: "project", projectId },
        contentHash,
      }),
    ).toMatchObject({ kind: "enable", profile: { kind: "project", projectId } });
    expect(() =>
      decodeBrowserExtensionsCommand({
        kind: "enable",
        extensionId,
        profile: { kind: "private" },
        contentHash,
      }),
    ).toThrow();
    expect(() =>
      decodeBrowserExtensionsCommand({
        kind: "enable",
        extensionId,
        profile: { kind: "personal" },
      }),
    ).toThrow();
    expect(() =>
      decodeBrowserExtensionsCommand({ kind: "remove", extensionId: "../../etc" }),
    ).toThrow();
  });

  it("states every refusal in words and refuses a reason it does not know", () => {
    expect(
      decodeBrowserExtensionsResult({
        kind: "browser-extension-refused",
        reason: "extension-not-local",
        message: "Extensions are managed from a window on this computer.",
      }),
    ).toMatchObject({ reason: "extension-not-local" });
    expect(() =>
      decodeBrowserExtensionsResult({
        kind: "browser-extension-refused",
        reason: "because",
        message: "No.",
      }),
    ).toThrow();
  });

  it("journals an enablement with the profile and the version enabled", () => {
    expect(
      decodeBrowserExtensionEnabled({
        kind: "browser-extension-enabled",
        extensionId,
        profile: { kind: "personal" },
        contentHash,
      }),
    ).toMatchObject({ profile: { kind: "personal" } });
  });
});
