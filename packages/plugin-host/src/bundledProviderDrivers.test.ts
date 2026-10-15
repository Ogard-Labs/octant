import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ProviderDriverKind } from "@octant/contracts/providers";
import {
  admittedBundledImageDriverKinds,
  admittedBundledProviderDriverKinds,
  BUNDLED_IMAGE_DRIVER_PLUGINS,
  BUNDLED_PROVIDER_DRIVER_PLUGINS,
  bundledProviderDriverCatalog,
  bundledProviderDriverComponent,
  bundledProviderDriverPlugin,
  isBundledProviderDriverEffective,
  resolveBundledProviderDriverActivation,
} from "./bundledProviderDrivers";

const everyDriverKind = [
  "codex",
  "claude",
  "opencode",
  "kilo",
  "pi",
  "oh-my-pi",
  "devin",
  "mistral-vibe",
  "ollama",
  "kimi-code",
  "grok",
  "goose",
  "glm",
  "gemini",
  "copilot",
  "cline",
  "qwen",
  "fx",
  "openai-compatible",
  "anthropic-compatible",
  "azure-foundry",
] as const satisfies ReadonlyArray<typeof ProviderDriverKind.Type>;

describe("bundled provider-driver plugins", () => {
  it("declares each in-tree vendor driver as a reviewed provider-driver component", () => {
    expect(BUNDLED_PROVIDER_DRIVER_PLUGINS.map((plugin) => plugin.driverKind)).toEqual([
      ...everyDriverKind,
    ]);
    for (const driverKind of everyDriverKind) {
      expect(Schema.decodeUnknownSync(ProviderDriverKind)(driverKind)).toBe(driverKind);
    }

    const slugs = new Set<string>();
    const digests = new Set<string>();
    const extensionIds = new Set<string>();
    for (const plugin of BUNDLED_PROVIDER_DRIVER_PLUGINS) {
      const component = bundledProviderDriverComponent(plugin);
      expect(plugin.manifest.slug).toBe(plugin.driverKind);
      expect(plugin.manifest.source).toEqual({
        kind: "bundled",
        sourceRef: `app:provider-driver-${plugin.driverKind}`,
      });
      expect(plugin.manifest.provenance.reviewed).toBe(true);
      expect(plugin.manifest.declaredCapabilities).toEqual([]);
      expect(plugin.manifest.compatibility.modes).toEqual(["chat", "work", "code"]);
      expect(component.kind).toBe("provider-driver");
      expect(component.declaredCapabilities).toEqual([]);
      expect(component.entryPoint).toBe(`builtin:provider-driver/${plugin.driverKind}`);
      slugs.add(plugin.manifest.slug);
      digests.add(plugin.manifest.digest);
      extensionIds.add(plugin.manifest.extensionId);
    }
    expect(slugs.size).toBe(everyDriverKind.length);
    expect(digests.size).toBe(everyDriverKind.length);
    expect(extensionIds.size).toBe(everyDriverKind.length);
  });

  it("admits every bundled driver by default", () => {
    expect([...admittedBundledProviderDriverKinds()].sort()).toEqual([...everyDriverKind].sort());
    for (const plugin of BUNDLED_PROVIDER_DRIVER_PLUGINS) {
      expect(isBundledProviderDriverEffective(plugin)).toBe(true);
      expect(bundledProviderDriverPlugin(plugin.driverKind)).toBe(plugin);
    }
  });

  it("contributes no driver kinds when the plugin or component is disabled", () => {
    expect(
      admittedBundledProviderDriverKinds({
        codex: { pluginDesired: false },
        claude: { componentDesired: false },
      }).has("codex"),
    ).toBe(false);
    expect(
      admittedBundledProviderDriverKinds({
        codex: { pluginDesired: false },
        claude: { componentDesired: false },
      }).has("claude"),
    ).toBe(false);
    expect(
      admittedBundledProviderDriverKinds({
        codex: { pluginDesired: false },
      }).has("opencode"),
    ).toBe(true);
  });

  it("contributes no driver kinds when the plugin is incompatible", () => {
    const plugin = bundledProviderDriverPlugin("grok");
    expect(plugin).toBeDefined();
    if (plugin === undefined) return;
    expect(resolveBundledProviderDriverActivation(plugin, { compatible: false })).toEqual({
      kind: "blocked",
      reason: "incompatible",
    });
    expect(admittedBundledProviderDriverKinds({ grok: { compatible: false } }).has("grok")).toBe(
      false,
    );
  });

  it("lists every bundled driver in the catalog as installed and trusted, validated by the public schema", () => {
    const catalog = bundledProviderDriverCatalog();
    expect(catalog.map((listing) => listing.entry.driverKind)).toEqual(
      BUNDLED_PROVIDER_DRIVER_PLUGINS.map((plugin) => plugin.driverKind),
    );
    expect(catalog).toHaveLength(21);
    for (const listing of catalog) {
      expect(listing.installed).toBe(true);
      expect(listing.trusted).toBe(true);
      expect(listing.activation).toEqual({ kind: "effective" });
      expect(listing.entry.manifest.source.kind).toBe("bundled");
    }
  });

  it("repeats the activation ladder's facts in the catalog rather than inventing its own", () => {
    const listing = bundledProviderDriverCatalog({ gemini: { pluginDesired: false } }).find(
      (candidate) => candidate.entry.driverKind === "gemini",
    );
    expect(listing?.installed).toBe(true);
    expect(listing?.activation).toEqual({ kind: "blocked", reason: "plugin-disabled" });
  });
});

describe("bundled image-driver plugins", () => {
  const imageDriverKinds = ["openai-image", "gemini-native-image", "bfl-image", "ideogram-image"];

  it("admits every bundled image provider by default, apart from the chat-driver catalog", () => {
    expect([...admittedBundledImageDriverKinds()]).toEqual(imageDriverKinds);
    expect(
      bundledProviderDriverCatalog().some((listing) =>
        imageDriverKinds.includes(listing.entry.driverKind),
      ),
    ).toBe(false);
    const every = [...BUNDLED_PROVIDER_DRIVER_PLUGINS, ...BUNDLED_IMAGE_DRIVER_PLUGINS];
    expect(new Set(every.map((plugin) => plugin.manifest.digest)).size).toBe(every.length);
    expect(new Set(every.map((plugin) => plugin.manifest.extensionId)).size).toBe(every.length);
  });

  it("stops admitting an image provider whose plugin is disabled", () => {
    const admitted = admittedBundledImageDriverKinds({ "bfl-image": { pluginDesired: false } });
    expect(admitted.has("bfl-image")).toBe(false);
    expect(admitted.has("ideogram-image")).toBe(true);
  });
});
