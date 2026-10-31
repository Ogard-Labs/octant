import { describe, expect, it } from "vitest";
import {
  decodeBrowserExtensionId,
  decodeProjectId,
  type BrowserExtensionAccess,
  type StoredBrowserProfile,
} from "@octant/contracts";
import {
  addedExtensionAccess,
  browserExtensionsEnabledIn,
  describeExtensionAccess,
  extensionAccessWidened,
  readExtensionManifest,
  reduceBrowserExtensions,
  type BrowserExtensionEvent,
} from "./browserExtensionPolicy";

const id = decodeBrowserExtensionId("a".repeat(32));
const otherId = decodeBrowserExtensionId("b".repeat(32));
const personal: StoredBrowserProfile = { kind: "personal" };
const project: StoredBrowserProfile = {
  kind: "project",
  projectId: decodeProjectId("11111111-2222-4333-8444-555555555555"),
};
const hash = "c".repeat(64);

const manifest = (overrides: Record<string, unknown> = {}) => ({
  manifest_version: 3,
  name: "Reading tool",
  version: "1.2.3",
  ...overrides,
});

describe("reading an extension manifest", () => {
  it("accepts a Manifest V3 extension and gathers everything it asks for", () => {
    const decision = readExtensionManifest(
      manifest({
        permissions: ["storage", "tabs"],
        optional_permissions: ["history"],
        host_permissions: ["https://example.com/*"],
        content_scripts: [{ matches: ["https://news.example/*"], js: ["a.js"] }],
        action: { default_popup: "popup.html" },
        options_ui: { page: "options.html" },
      }),
    );

    expect(decision).toEqual({
      kind: "valid",
      facts: {
        name: "Reading tool",
        version: "1.2.3",
        access: {
          permissions: ["storage", "tabs", "history"],
          hostPatterns: ["https://example.com/*", "https://news.example/*"],
        },
        popupPage: "popup.html",
        optionsPage: "options.html",
      },
    });
  });

  it("refuses Manifest V2 as unsupported", () => {
    expect(readExtensionManifest(manifest({ manifest_version: 2 }))).toMatchObject({
      kind: "refused",
      reason: "extension-unsupported",
    });
  });

  it("refuses an extension that needs native messaging", () => {
    expect(readExtensionManifest(manifest({ permissions: ["nativeMessaging"] }))).toMatchObject({
      kind: "refused",
      reason: "extension-unsupported",
    });
  });

  it("refuses a manifest with no usable name or version, and a non-manifest", () => {
    for (const bad of [
      manifest({ name: "" }),
      manifest({ name: "__MSG_appName__" }),
      manifest({ version: "latest" }),
      manifest({ version: undefined }),
      "not a manifest",
      null,
      [],
    ]) {
      expect(readExtensionManifest(bad)).toMatchObject({ kind: "refused", reason: "invalid" });
    }
  });

  it("ignores a page path that leaves the extension's folder", () => {
    const decision = readExtensionManifest(
      manifest({ action: { default_popup: "../outside.html" }, options_page: "/abs.html" }),
    );

    expect(decision).toMatchObject({
      kind: "valid",
      facts: { popupPage: undefined, optionsPage: undefined },
    });
  });
});

describe("what an update asks for", () => {
  const installed: BrowserExtensionAccess = {
    permissions: ["storage"],
    hostPatterns: ["https://a.example/*"],
  };

  it("is widened only when it adds a permission or a site pattern", () => {
    expect(extensionAccessWidened(installed, installed)).toBe(false);
    expect(
      extensionAccessWidened(installed, { permissions: [], hostPatterns: ["https://a.example/*"] }),
    ).toBe(false);
    expect(
      extensionAccessWidened(installed, {
        permissions: ["storage", "cookies"],
        hostPatterns: installed.hostPatterns,
      }),
    ).toBe(true);
    expect(
      extensionAccessWidened(installed, {
        permissions: ["storage"],
        hostPatterns: ["https://a.example/*", "https://b.example/*"],
      }),
    ).toBe(true);
  });

  it("names exactly what is new", () => {
    expect(
      addedExtensionAccess(installed, {
        permissions: ["storage", "cookies"],
        hostPatterns: ["https://b.example/*"],
      }),
    ).toEqual({ permissions: ["cookies"], hostPatterns: ["https://b.example/*"] });
  });

  it("says it in plain words, naming every-site access first", () => {
    expect(
      describeExtensionAccess({ permissions: ["cookies", "oddity"], hostPatterns: ["<all_urls>"] }),
    ).toEqual([
      "Read and change every website you open in this profile",
      "Read and change cookies",
      "Use the “oddity” permission",
    ]);
    expect(
      describeExtensionAccess({ permissions: [], hostPatterns: ["https://a.example/*"] }),
    ).toEqual(["Read and change https://a.example/*"]);
  });
});

function installed(
  overrides: Partial<{
    extensionId: typeof id;
    version: string;
    permissions: ReadonlyArray<string>;
    hostPatterns: ReadonlyArray<string>;
  }> = {},
  eventName:
    | "browser.extension-installed@1"
    | "browser.extension-updated@1" = "browser.extension-installed@1",
): BrowserExtensionEvent {
  return {
    eventName,
    payload: {
      extensionId: id,
      name: "Reading tool",
      version: "1.0.0",
      contentHash: hash,
      permissions: ["storage"],
      hostPatterns: ["https://a.example/*"],
      hasPopup: true,
      hasOptionsPage: false,
      ...overrides,
    },
  };
}
const enabled = (profile: StoredBrowserProfile, extensionId = id): BrowserExtensionEvent => ({
  eventName: "browser.extension-enabled@1",
  payload: { extensionId, profile },
});
const disabled = (profile: StoredBrowserProfile): BrowserExtensionEvent => ({
  eventName: "browser.extension-disabled@1",
  payload: { extensionId: id, profile },
});

describe("installed extensions rebuilt from the journal", () => {
  it("starts an installed extension off everywhere", () => {
    expect(reduceBrowserExtensions([installed()])).toMatchObject([
      { id, name: "Reading tool", enabledIn: [], needsConfirmation: [] },
    ]);
  });

  it("enables and disables per profile, and lists where it runs", () => {
    const state = reduceBrowserExtensions([
      installed(),
      enabled(personal),
      enabled(project),
      disabled(personal),
    ]);

    expect(state[0]?.enabledIn).toEqual([project]);
    expect(browserExtensionsEnabledIn(state, project)).toHaveLength(1);
    expect(browserExtensionsEnabledIn(state, personal)).toHaveLength(0);
  });

  it("keeps an update that asks for the same or less enabled where it was", () => {
    const state = reduceBrowserExtensions([
      installed(),
      enabled(personal),
      installed({ version: "1.1.0", permissions: [] }, "browser.extension-updated@1"),
    ]);

    expect(state[0]).toMatchObject({
      version: "1.1.0",
      enabledIn: [personal],
      needsConfirmation: [],
    });
    expect(state[0]?.addedAccess).toBeUndefined();
  });

  it("turns off an update that asks for more everywhere and asks again, showing what is new", () => {
    const state = reduceBrowserExtensions([
      installed(),
      enabled(personal),
      enabled(project),
      installed(
        { version: "2.0.0", permissions: ["storage", "cookies"] },
        "browser.extension-updated@1",
      ),
    ]);

    expect(state[0]).toMatchObject({
      version: "2.0.0",
      enabledIn: [],
      needsConfirmation: [personal, project],
      addedAccess: { permissions: ["cookies"], hostPatterns: [] },
    });
  });

  it("treats enabling a parked profile again as the confirmation", () => {
    const state = reduceBrowserExtensions([
      installed(),
      enabled(personal),
      enabled(project),
      installed({ permissions: ["storage", "cookies"] }, "browser.extension-updated@1"),
      enabled(personal),
    ]);

    expect(state[0]).toMatchObject({ enabledIn: [personal], needsConfirmation: [project] });
    const done = reduceBrowserExtensions([
      installed(),
      enabled(personal),
      installed({ permissions: ["storage", "cookies"] }, "browser.extension-updated@1"),
      enabled(personal),
    ]);
    expect(done[0]).toMatchObject({ enabledIn: [personal], needsConfirmation: [] });
    expect(done[0]?.addedAccess).toBeUndefined();
  });

  it("forgets a removed extension everywhere and ignores events for one that is not installed", () => {
    const state = reduceBrowserExtensions([
      installed(),
      enabled(personal),
      { eventName: "browser.extension-removed@1", payload: { extensionId: id } },
      enabled(personal, otherId),
    ]);

    expect(state).toEqual([]);
  });

  it("reinstalling a removed extension starts it off again", () => {
    const state = reduceBrowserExtensions([
      installed(),
      enabled(personal),
      { eventName: "browser.extension-removed@1", payload: { extensionId: id } },
      installed(),
    ]);

    expect(state[0]?.enabledIn).toEqual([]);
  });
});
