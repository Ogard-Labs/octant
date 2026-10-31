import { ACP_AGENT_KINDS, acpAgentProfile } from "@octant/contracts/acp-agent-profiles";
import type { ProviderDriverKind } from "@octant/contracts/providers";
import type {
  ExtensionActivationState,
  ExtensionEffectiveState,
  ExtensionPackageManifest,
} from "@octant/contracts/extensions";
import {
  decodeExtensionContentDigest,
  decodeExtensionPackageManifest,
} from "@octant/contracts/extensions";
import {
  decodeProviderDriverCatalogEntry,
  type ProviderDriverCatalogEntry,
} from "@octant/plugin-api/provider-driver-catalog";
import {
  isExtensionComponentModeSafe,
  resolveExtensionActivation,
  type ExtensionActivationContext,
} from "./activation";

interface BundledDriverSpec {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  /** Single-hex nibble or two-hex seed for bundled digest derivation. */
  readonly digestNibble: string;
  readonly uuidNibble: string;
}

const NATIVE_PROVIDER_DRIVERS = [
  { driverKind: "codex", displayName: "Codex CLI", digestNibble: "0", uuidNibble: "01" },
  { driverKind: "claude", displayName: "Claude Code", digestNibble: "1", uuidNibble: "02" },
  { driverKind: "opencode", displayName: "OpenCode CLI", digestNibble: "2", uuidNibble: "03" },
  { driverKind: "pi", displayName: "Pi RPC", digestNibble: "4", uuidNibble: "05" },
  { driverKind: "oh-my-pi", displayName: "Oh My Pi", digestNibble: "5", uuidNibble: "06" },
  { driverKind: "ollama", displayName: "Ollama", digestNibble: "8", uuidNibble: "09" },
  {
    driverKind: "openai-compatible",
    displayName: "OpenAI-compatible HTTP",
    digestNibble: "b",
    uuidNibble: "0c",
  },
  {
    driverKind: "anthropic-compatible",
    displayName: "Anthropic-compatible HTTP",
    digestNibble: "c",
    uuidNibble: "0d",
  },
  {
    driverKind: "azure-foundry",
    displayName: "Azure AI Foundry",
    digestNibble: "d",
    uuidNibble: "0e",
  },
  // The next seed after the image drivers', so no earlier plugin identity moves.
  {
    driverKind: "amazon-bedrock",
    displayName: "Amazon Bedrock",
    digestNibble: "19",
    uuidNibble: "1a",
  },
] as const satisfies ReadonlyArray<BundledDriverSpec>;

/**
 * Each ACP agent's plugin identity comes from its profile's serial, in the
 * same seed scheme the native drivers use: the serial in hex seeds the digest
 * and the next value ends the ids.
 */
const ACP_AGENT_DRIVERS: ReadonlyArray<BundledDriverSpec> = ACP_AGENT_KINDS.map((kind) => {
  const profile = acpAgentProfile(kind);
  return {
    driverKind: kind,
    displayName: profile.name,
    digestNibble: profile.bundledPluginSerial.toString(16),
    uuidNibble: (profile.bundledPluginSerial + 1).toString(16).padStart(2, "0"),
  };
});

const BUNDLED_PROVIDER_DRIVERS: ReadonlyArray<BundledDriverSpec> = [
  ...NATIVE_PROVIDER_DRIVERS,
  ...ACP_AGENT_DRIVERS,
];

/**
 * Image providers reach the image job service through the provider-sdk image
 * seam. They share the provider-driver component kind and activation ladder,
 * but stay out of the chat-driver catalog: they cannot start a turn.
 */
const BUNDLED_IMAGE_DRIVERS = [
  {
    driverKind: "openai-image",
    displayName: "OpenAI Images",
    digestNibble: "15",
    uuidNibble: "16",
  },
  {
    driverKind: "gemini-native-image",
    displayName: "Gemini Images",
    digestNibble: "16",
    uuidNibble: "17",
  },
  {
    driverKind: "bfl-image",
    displayName: "Black Forest Labs",
    digestNibble: "17",
    uuidNibble: "18",
  },
  { driverKind: "ideogram-image", displayName: "Ideogram", digestNibble: "18", uuidNibble: "19" },
] as const satisfies ReadonlyArray<BundledDriverSpec>;

const PROVIDER_DRIVER_COMPONENT_ID = "provider-driver";

export interface BundledProviderDriverPlugin {
  readonly driverKind: ProviderDriverKind;
  readonly manifest: ExtensionPackageManifest;
}

const digest = (seed: string) => {
  const hex = seed.length === 1 ? seed.repeat(64) : seed.repeat(32);
  // `11`.repeat(32) equals `1`.repeat(64), which Claude already uses.
  const normalized = seed.length !== 1 && hex === "1".repeat(64) ? "1b".repeat(32) : hex;
  return decodeExtensionContentDigest(`sha256:${normalized}`);
};

function bundledProviderDriverManifest(spec: BundledDriverSpec) {
  return decodeExtensionPackageManifest({
    manifestVersion: 1,
    extensionId: `10000000-0000-4000-8000-0000000002${spec.uuidNibble}`,
    packageId: `20000000-0000-4000-8000-0000000002${spec.uuidNibble}`,
    slug: spec.driverKind,
    displayName: spec.displayName,
    version: "1.0.0",
    digest: digest(spec.digestNibble),
    source: { kind: "bundled", sourceRef: `app:provider-driver-${spec.driverKind}` },
    provenance: { publisher: "Octant", reviewed: true },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: {
      platforms: ["macos"],
      modes: ["chat", "work", "code"],
      providerFamilies: [],
    },
    declaredCapabilities: [],
    primaryComponentId: PROVIDER_DRIVER_COMPONENT_ID,
    components: [
      {
        id: PROVIDER_DRIVER_COMPONENT_ID,
        kind: "provider-driver",
        displayName: spec.displayName,
        declaredCapabilities: [],
        entryPoint: `builtin:provider-driver/${spec.driverKind}`,
      },
    ],
  });
}

export const BUNDLED_PROVIDER_DRIVER_PLUGINS: ReadonlyArray<BundledProviderDriverPlugin> =
  BUNDLED_PROVIDER_DRIVERS.map((spec) => ({
    driverKind: spec.driverKind,
    manifest: bundledProviderDriverManifest(spec),
  }));

export const BUNDLED_IMAGE_DRIVER_PLUGINS: ReadonlyArray<BundledProviderDriverPlugin> =
  BUNDLED_IMAGE_DRIVERS.map((spec) => ({
    driverKind: spec.driverKind,
    manifest: bundledProviderDriverManifest(spec),
  }));

const defaultActivation: ExtensionActivationState = {
  installed: true,
  trusted: true,
  pluginDesired: true,
  componentDesired: true,
  compatible: true,
  policyAllowed: true,
  quarantined: false,
  draining: false,
  broken: false,
  unavailable: false,
  interrupted: false,
  waiting: false,
};

const defaultHostContext = {
  hostAllowed: true,
  modeAllowed: true,
  projectAllowed: true,
  threadAllowed: true,
  catalogCurrent: true,
} as const;

export type BundledProviderDriverActivationPatch = Partial<ExtensionActivationContext>;

/**
 * Bundled drivers Octant does not offer, each with the reason a person sees
 * where an existing instance of it reports unavailable. A withheld driver is
 * not admitted: discovery offers nothing for it, no instance is created, and no
 * process starts. Stored instances and their threads stay. Remove the entry to
 * offer the driver again.
 *
 * None is withheld today. fx was, until Octant let its sandboxed launches read
 * the System Keychain file it loads TLS roots from.
 */
const WITHHELD_BUNDLED_PROVIDER_DRIVERS: Readonly<
  Partial<Record<ProviderDriverKind, { readonly reason: string }>>
> = {};

/** Why Octant withholds this bundled driver, or undefined when it is offered. */
export function bundledProviderDriverWithheldReason(
  driverKind: ProviderDriverKind,
): string | undefined {
  return WITHHELD_BUNDLED_PROVIDER_DRIVERS[driverKind]?.reason;
}

const withheldPatch = (driverKind: ProviderDriverKind): BundledProviderDriverActivationPatch =>
  bundledProviderDriverWithheldReason(driverKind) === undefined ? {} : { compatible: false };

/**
 * Host-scope activation for bundled vendor drivers. Packages are reviewed,
 * enabled by default, and safe in Chat, Work, and Code. A patch can flip the
 * plugin switch, component switch, or compatibility without inventing a
 * second activation ladder.
 */
export function bundledProviderDriverActivation(
  patch: BundledProviderDriverActivationPatch = {},
): ExtensionActivationContext {
  return {
    ...defaultHostContext,
    ...defaultActivation,
    ...patch,
  };
}

export function bundledProviderDriverComponent(plugin: BundledProviderDriverPlugin) {
  const component = plugin.manifest.components.find(
    (entry) => entry.kind === "provider-driver" && entry.id === PROVIDER_DRIVER_COMPONENT_ID,
  );
  if (component === undefined) {
    throw new Error(
      `Bundled provider-driver plugin ${plugin.driverKind} is missing its component.`,
    );
  }
  return component;
}

export function resolveBundledProviderDriverActivation(
  plugin: BundledProviderDriverPlugin,
  patch: BundledProviderDriverActivationPatch = {},
) {
  const component = bundledProviderDriverComponent(plugin);
  const activation = bundledProviderDriverActivation({
    ...withheldPatch(plugin.driverKind),
    ...patch,
  });
  if (!isExtensionComponentModeSafe("chat", component)) {
    return { kind: "blocked" as const, reason: "mode-prohibited" as const };
  }
  return resolveExtensionActivation(activation);
}

export function isBundledProviderDriverEffective(
  plugin: BundledProviderDriverPlugin,
  patch: BundledProviderDriverActivationPatch = {},
): boolean {
  return resolveBundledProviderDriverActivation(plugin, patch).kind === "effective";
}

export function admittedBundledProviderDriverKinds(
  patches: Readonly<Partial<Record<ProviderDriverKind, BundledProviderDriverActivationPatch>>> = {},
): ReadonlySet<ProviderDriverKind> {
  return new Set(
    BUNDLED_PROVIDER_DRIVER_PLUGINS.filter((plugin) =>
      isBundledProviderDriverEffective(plugin, patches[plugin.driverKind] ?? {}),
    ).map((plugin) => plugin.driverKind),
  );
}

/** The bundled image providers the activation ladder admits. */
export function admittedBundledImageDriverKinds(
  patches: Readonly<Partial<Record<ProviderDriverKind, BundledProviderDriverActivationPatch>>> = {},
): ReadonlySet<ProviderDriverKind> {
  return new Set(
    BUNDLED_IMAGE_DRIVER_PLUGINS.filter((plugin) =>
      isBundledProviderDriverEffective(plugin, patches[plugin.driverKind] ?? {}),
    ).map((plugin) => plugin.driverKind),
  );
}

export function bundledProviderDriverPlugin(
  driverKind: ProviderDriverKind,
): BundledProviderDriverPlugin | undefined {
  return BUNDLED_PROVIDER_DRIVER_PLUGINS.find((plugin) => plugin.driverKind === driverKind);
}

/**
 * A provider driver as the provider catalog lists it: the entry, validated
 * through the public catalog schema, beside the package facts the activation
 * ladder holds for it. `installed` and `trusted` are read from the same context
 * that admits the driver, so the catalog can only repeat them, never set them.
 */
export interface ProviderDriverCatalogListing {
  readonly entry: ProviderDriverCatalogEntry;
  readonly installed: boolean;
  readonly trusted: boolean;
  readonly activation: ExtensionEffectiveState;
}

/**
 * Every bundled provider driver as a catalog listing, in bundle order. Listing
 * reads manifests and activation policy only; it starts nothing.
 */
export function bundledProviderDriverCatalog(
  patches: Readonly<Partial<Record<ProviderDriverKind, BundledProviderDriverActivationPatch>>> = {},
): ReadonlyArray<ProviderDriverCatalogListing> {
  return BUNDLED_PROVIDER_DRIVER_PLUGINS.map((plugin) => {
    const patch = patches[plugin.driverKind] ?? {};
    const activation = bundledProviderDriverActivation(patch);
    return {
      entry: decodeProviderDriverCatalogEntry({
        driverKind: plugin.driverKind,
        manifest: plugin.manifest,
      }),
      installed: activation.installed,
      trusted: activation.trusted,
      activation: resolveBundledProviderDriverActivation(plugin, patch),
    };
  });
}
