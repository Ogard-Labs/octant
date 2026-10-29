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
  bundledProviderDriverWithheldReason,
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
  "amazon-bedrock",
] as const satisfies ReadonlyArray<typeof ProviderDriverKind.Type>;

describe("bundled provider-driver plugins", () => {
  it("declares each in-tree vendor driver as a reviewed provider-driver component", () => {
    expect(BUNDLED_PROVIDER_DRIVER_PLUGINS.map((plugin) => plugin.driverKind).sort()).toEqual(
      [...everyDriverKind].sort(),
    );
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

  // Activation state is stored against a plugin's extension id, so a driver
  // whose id or digest moved would pick up another plugin's switches.
  it("keeps every bundled driver's plugin identity across releases", () => {
    const seeds: Readonly<Record<(typeof everyDriverKind)[number], readonly [string, string]>> = {
      codex: ["0", "01"],
      claude: ["1", "02"],
      opencode: ["2", "03"],
      kilo: ["3", "04"],
      pi: ["4", "05"],
      "oh-my-pi": ["5", "06"],
      devin: ["6", "07"],
      "mistral-vibe": ["7", "08"],
      ollama: ["8", "09"],
      "kimi-code": ["9", "0a"],
      grok: ["a", "0b"],
      "openai-compatible": ["b", "0c"],
      "anthropic-compatible": ["c", "0d"],
      "azure-foundry": ["d", "0e"],
      goose: ["e", "0f"],
      glm: ["f", "10"],
      gemini: ["10", "11"],
      copilot: ["11", "12"],
      cline: ["12", "13"],
      qwen: ["13", "14"],
      fx: ["14", "15"],
      "amazon-bedrock": ["19", "1a"],
    };
    for (const plugin of BUNDLED_PROVIDER_DRIVER_PLUGINS) {
      const [digestSeed, idSuffix] = seeds[plugin.driverKind as (typeof everyDriverKind)[number]];
      const hex = digestSeed.length === 1 ? digestSeed.repeat(64) : digestSeed.repeat(32);
      expect(plugin.manifest.extensionId, plugin.driverKind).toBe(
        `10000000-0000-4000-8000-0000000002${idSuffix}`,
      );
      expect(plugin.manifest.digest, plugin.driverKind).toBe(
        `sha256:${hex === "1".repeat(64) && digestSeed.length !== 1 ? "1b".repeat(32) : hex}`,
      );
    }
  });

  it("admits every bundled driver by default except the withheld fx", () => {
    expect([...admittedBundledProviderDriverKinds()].sort()).toEqual(
      everyDriverKind.filter((kind) => kind !== "fx").sort(),
    );
    for (const plugin of BUNDLED_PROVIDER_DRIVER_PLUGINS) {
      expect(isBundledProviderDriverEffective(plugin), plugin.driverKind).toBe(
        plugin.driverKind !== "fx",
      );
      expect(bundledProviderDriverPlugin(plugin.driverKind)).toBe(plugin);
    }
  });

  it("withholds fx with a reason a person can read, and no other driver", () => {
    expect(bundledProviderDriverWithheldReason("fx")).toMatch(
      /certificates inside Octant's sandbox/,
    );
    for (const kind of everyDriverKind.filter((candidate) => candidate !== "fx")) {
      expect(bundledProviderDriverWithheldReason(kind), kind).toBeUndefined();
    }
    const fx = bundledProviderDriverPlugin("fx");
    if (fx === undefined) throw new Error("fx plugin is missing");
    expect(resolveBundledProviderDriverActivation(fx)).toEqual({
      kind: "blocked",
      reason: "incompatible",
    });
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
    expect(catalog).toHaveLength(22);
    for (const listing of catalog) {
      expect(listing.installed).toBe(true);
      expect(listing.trusted).toBe(true);
      expect(listing.activation, listing.entry.driverKind).toEqual(
        listing.entry.driverKind === "fx"
          ? { kind: "blocked", reason: "incompatible" }
          : { kind: "effective" },
      );
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
