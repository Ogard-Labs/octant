import type { ProviderDriverKind } from "@octant/contracts/providers";
import type {
  ExtensionActivationState,
  ExtensionPackageManifest,
} from "@octant/contracts/extensions";
import {
  decodeExtensionContentDigest,
  decodeExtensionPackageManifest,
} from "@octant/contracts/extensions";
import {
  isExtensionComponentModeSafe,
  resolveExtensionActivation,
  type ExtensionActivationContext,
} from "./activation";

const BUNDLED_PROVIDER_DRIVERS = [
  { driverKind: "codex", displayName: "Codex CLI", digestNibble: "0", uuidNibble: "01" },
  { driverKind: "claude", displayName: "Claude Code", digestNibble: "1", uuidNibble: "02" },
  { driverKind: "opencode", displayName: "OpenCode CLI", digestNibble: "2", uuidNibble: "03" },
  { driverKind: "kilo", displayName: "Kilo ACP", digestNibble: "3", uuidNibble: "04" },
  { driverKind: "pi", displayName: "Pi RPC", digestNibble: "4", uuidNibble: "05" },
  { driverKind: "oh-my-pi", displayName: "Oh My Pi", digestNibble: "5", uuidNibble: "06" },
  { driverKind: "devin", displayName: "Devin ACP", digestNibble: "6", uuidNibble: "07" },
  {
    driverKind: "mistral-vibe",
    displayName: "Mistral Vibe ACP",
    digestNibble: "7",
    uuidNibble: "08",
  },
  { driverKind: "ollama", displayName: "Ollama", digestNibble: "8", uuidNibble: "09" },
  { driverKind: "kimi-code", displayName: "Kimi Code CLI", digestNibble: "9", uuidNibble: "0a" },
  { driverKind: "grok", displayName: "Grok Build", digestNibble: "a", uuidNibble: "0b" },
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
] as const satisfies ReadonlyArray<{
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly digestNibble: string;
  readonly uuidNibble: string;
}>;

const PROVIDER_DRIVER_COMPONENT_ID = "provider-driver";

export interface BundledProviderDriverPlugin {
  readonly driverKind: ProviderDriverKind;
  readonly manifest: ExtensionPackageManifest;
}

const digest = (nibble: string) => decodeExtensionContentDigest(`sha256:${nibble.repeat(64)}`);

function bundledProviderDriverManifest(spec: (typeof BUNDLED_PROVIDER_DRIVERS)[number]) {
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
  const activation = bundledProviderDriverActivation(patch);
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

export function bundledProviderDriverPlugin(
  driverKind: ProviderDriverKind,
): BundledProviderDriverPlugin | undefined {
  return BUNDLED_PROVIDER_DRIVER_PLUGINS.find((plugin) => plugin.driverKind === driverKind);
}
