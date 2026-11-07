import {
  decodeExtensionContentDigest,
  decodeExtensionPackageManifest,
  type ExtensionContribution,
  type ExtensionPackageManifest,
} from "@octant/contracts/extensions";

/**
 * The first-party plugins built into Octant: one definition that the server
 * (which journals the switches a person can turn) and the renderer (which
 * draws their contributions) both read. Adding a bundled plugin is one entry
 * in `FIRST_PARTY_PLUGINS` below.
 */
export type FirstPartyPluginComponentId =
  | "board"
  | "github-integration"
  | "linear-integration"
  | "azure-arm-integration"
  | "appearance-pack"
  | "preview-viewers"
  | "zen";

const digest = (nibble: string) => decodeExtensionContentDigest(`sha256:${nibble.repeat(64)}`);

function firstPartyManifest(value: unknown): ExtensionPackageManifest {
  return decodeExtensionPackageManifest(value);
}

const boardPlugin = firstPartyManifest({
  manifestVersion: 1,
  extensionId: "10000000-0000-4000-8000-0000000000b1",
  packageId: "20000000-0000-4000-8000-0000000000b1",
  slug: "board",
  displayName: "Board",
  version: "1.0.0",
  digest: digest("b"),
  source: { kind: "bundled", sourceRef: "app:board" },
  provenance: { publisher: "Octant", reviewed: true },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: {
    platforms: ["macos"],
    modes: ["work", "code"],
    providerFamilies: [],
  },
  declaredCapabilities: [],
  primaryComponentId: "board",
  components: [
    {
      id: "board",
      kind: "board",
      displayName: "Board",
      declaredCapabilities: [],
      entryPoint: "builtin:board",
    },
  ],
  contributions: [
    {
      point: "sidebar.destination",
      componentId: "board",
      destinationId: "thread-board",
      label: "Board",
      modes: ["work", "code"],
      entryPoint: "builtin:board/destination",
    },
    {
      point: "board.view",
      componentId: "board",
      viewId: "thread-status",
      label: "Board",
      modes: ["work", "code"],
    },
  ],
});

const githubPlugin = firstPartyManifest({
  manifestVersion: 1,
  extensionId: "10000000-0000-4000-8000-0000000000c1",
  packageId: "20000000-0000-4000-8000-0000000000c1",
  slug: "github",
  displayName: "GitHub",
  version: "1.0.0",
  digest: digest("c"),
  source: { kind: "bundled", sourceRef: "app:github" },
  provenance: { publisher: "Octant", reviewed: true },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: {
    platforms: ["macos"],
    modes: ["code"],
    providerFamilies: [],
  },
  declaredCapabilities: ["network", "credentials"],
  primaryComponentId: "github-integration",
  components: [
    {
      id: "github-integration",
      kind: "integration",
      displayName: "GitHub",
      declaredCapabilities: ["network", "credentials"],
      entryPoint: "builtin:github",
    },
  ],
  contributions: [
    {
      point: "sidebar.destination",
      componentId: "github-integration",
      destinationId: "pull-requests",
      label: "Pull requests",
      modes: ["code"],
      entryPoint: "builtin:github/sidebar-destination",
    },
    {
      point: "sidebar.destination",
      componentId: "github-integration",
      destinationId: "github-issues",
      label: "Issues",
      modes: ["code"],
      entryPoint: "builtin:github/issues-destination",
    },
    {
      point: "settings.section",
      componentId: "github-integration",
      sectionId: "github",
      label: "GitHub",
      scope: "host",
      keywords:
        "github account gh cli authentication connection setup sign in refresh scopes repositories issues pull requests",
      entryPoint: "builtin:github/settings",
      description: "Connect the GitHub CLI and manage authentication scopes.",
    },
  ],
});

const linearPlugin = firstPartyManifest({
  manifestVersion: 1,
  extensionId: "10000000-0000-4000-8000-0000000000e1",
  packageId: "20000000-0000-4000-8000-0000000000e1",
  slug: "linear",
  displayName: "Linear",
  version: "1.0.0",
  digest: digest("e"),
  source: { kind: "bundled", sourceRef: "app:linear" },
  provenance: { publisher: "Octant", reviewed: true },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: {
    platforms: ["macos"],
    modes: ["code"],
    providerFamilies: [],
  },
  declaredCapabilities: ["network", "credentials"],
  primaryComponentId: "linear-integration",
  components: [
    {
      id: "linear-integration",
      kind: "integration",
      displayName: "Linear",
      declaredCapabilities: ["network", "credentials"],
      entryPoint: "builtin:linear",
    },
  ],
  contributions: [
    {
      point: "sidebar.destination",
      componentId: "linear-integration",
      destinationId: "linear-issues",
      label: "Linear",
      modes: ["code"],
      entryPoint: "builtin:linear/sidebar-destination",
    },
    {
      point: "settings.section",
      componentId: "linear-integration",
      sectionId: "linear",
      label: "Linear",
      scope: "host",
      keywords:
        "linear workspace authentication connection setup oauth connect disconnect reconnect issues",
      entryPoint: "builtin:linear/settings",
      description: "Connect Linear with OAuth. Tokens stay on this host.",
    },
  ],
});

/**
 * Bundled appearance pack. Host built-ins (system, light, dark) stay in the
 * host; this package contributes the branded Octant preset so disabling the
 * pack removes that surface and nothing else.
 */
const appearancePlugin = firstPartyManifest({
  manifestVersion: 1,
  extensionId: "10000000-0000-4000-8000-0000000000a1",
  packageId: "20000000-0000-4000-8000-0000000000a1",
  slug: "appearance",
  displayName: "Octant appearance",
  version: "1.0.0",
  digest: digest("a"),
  source: { kind: "bundled", sourceRef: "app:appearance" },
  provenance: { publisher: "Octant", reviewed: true },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: {
    platforms: ["macos"],
    modes: ["chat", "work", "code"],
    providerFamilies: [],
  },
  declaredCapabilities: [],
  primaryComponentId: "appearance-pack",
  components: [
    {
      id: "appearance-pack",
      kind: "appearance-pack",
      displayName: "Octant appearance",
      declaredCapabilities: [],
    },
  ],
  contributions: [
    {
      point: "appearance.preset",
      componentId: "appearance-pack",
      presetId: "octant",
      label: "Octant",
    },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "moss", label: "Moss" },
    {
      point: "appearance.preset",
      componentId: "appearance-pack",
      presetId: "lagoon",
      label: "Lagoon",
    },
    {
      point: "appearance.preset",
      componentId: "appearance-pack",
      presetId: "harbor",
      label: "Harbor",
    },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "iris", label: "Iris" },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "rose", label: "Rose" },
    {
      point: "appearance.preset",
      componentId: "appearance-pack",
      presetId: "ember",
      label: "Ember",
    },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "ink", label: "Ink" },
    {
      point: "appearance.preset",
      componentId: "appearance-pack",
      presetId: "coral",
      label: "Coral",
    },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "clay", label: "Clay" },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "sand", label: "Sand" },
    {
      point: "appearance.preset",
      componentId: "appearance-pack",
      presetId: "olive",
      label: "Olive",
    },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "mint", label: "Mint" },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "sky", label: "Sky" },
    {
      point: "appearance.preset",
      componentId: "appearance-pack",
      presetId: "slate",
      label: "Slate",
    },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "plum", label: "Plum" },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "ash", label: "Ash" },
    {
      point: "appearance.preset",
      componentId: "appearance-pack",
      presetId: "obsidian",
      label: "Obsidian",
    },
    { point: "appearance.preset", componentId: "appearance-pack", presetId: "onyx", label: "Onyx" },
    {
      point: "appearance.preset",
      componentId: "appearance-pack",
      presetId: "pride",
      label: "Pride",
    },
    {
      point: "appearance.preset",
      componentId: "appearance-pack",
      presetId: "norway",
      label: "Norway",
    },
  ],
});

/**
 * Bundled structured preview viewers. Text, markdown, and image stay
 * host-owned; PDF, tables, workbooks, documents, and slides come from this
 * package so a disabled pack cannot select those viewers.
 */
const previewPlugin = firstPartyManifest({
  manifestVersion: 1,
  extensionId: "10000000-0000-4000-8000-0000000000d1",
  packageId: "20000000-0000-4000-8000-0000000000d1",
  slug: "preview-viewers",
  displayName: "Structured preview",
  version: "1.0.0",
  digest: digest("d"),
  source: { kind: "bundled", sourceRef: "app:preview-viewers" },
  provenance: { publisher: "Octant", reviewed: true },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: {
    platforms: ["macos"],
    modes: ["chat", "work", "code"],
    providerFamilies: [],
  },
  declaredCapabilities: [],
  primaryComponentId: "preview-viewers",
  components: [
    {
      id: "preview-viewers",
      kind: "preview-viewer",
      displayName: "Structured preview",
      declaredCapabilities: [],
    },
  ],
  contributions: [
    {
      point: "preview.viewer",
      componentId: "preview-viewers",
      viewerId: "structured-documents",
      label: "Structured documents",
      kinds: ["pdf", "table", "workbook", "document", "slides"],
    },
  ],
});

const azurePlugin = firstPartyManifest({
  manifestVersion: 1,
  extensionId: "10000000-0000-4000-8000-0000000000f1",
  packageId: "20000000-0000-4000-8000-0000000000f1",
  slug: "azure-arm",
  displayName: "Azure Resource Manager reads",
  version: "1.0.0",
  digest: digest("f"),
  source: { kind: "bundled", sourceRef: "app:azure-arm" },
  provenance: { publisher: "Octant", reviewed: true },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: { platforms: ["macos", "linux"], modes: ["code"], providerFamilies: [] },
  declaredCapabilities: ["network", "credentials"],
  primaryComponentId: "azure-arm-integration",
  components: [
    {
      id: "azure-arm-integration",
      kind: "integration",
      displayName: "Azure Resource Manager reads",
      declaredCapabilities: ["network", "credentials"],
      entryPoint: "builtin:azure-arm",
    },
  ],
  contributions: [],
});

/**
 * Bundled Zen workspace. The Zen layouts, backgrounds, focus zones and events
 * stay on disk when the plugin is off; the surface, its routes and its
 * assistant tool are what go away. The built-in background catalog stays in
 * the host because app backdrops use it too.
 */
const zenPlugin = firstPartyManifest({
  manifestVersion: 1,
  extensionId: "10000000-0000-4000-8000-000000000051",
  packageId: "20000000-0000-4000-8000-000000000051",
  slug: "zen",
  displayName: "Zen",
  version: "1.0.0",
  digest: digest("5"),
  source: { kind: "bundled", sourceRef: "app:zen" },
  provenance: { publisher: "Octant", reviewed: true },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: {
    platforms: ["macos"],
    modes: ["chat", "work", "code"],
    providerFamilies: [],
  },
  declaredCapabilities: [],
  primaryComponentId: "zen",
  components: [
    {
      id: "zen",
      kind: "ui-surface",
      displayName: "Zen",
      declaredCapabilities: [],
    },
  ],
  contributions: [],
});

/**
 * Every first-party plugin, and whether a person may switch it off in
 * Settings. A switchable plugin starts on and keeps its data while off; the
 * others are core parts of Octant that have no switch. Maintainers decided on
 * 2026-11-07 that GitHub, thread boards, and Zen are the switchable ones.
 */
const FIRST_PARTY_PLUGINS: ReadonlyArray<{
  readonly manifest: ExtensionPackageManifest;
  readonly switchable: boolean;
}> = [
  { manifest: boardPlugin, switchable: true },
  { manifest: githubPlugin, switchable: true },
  { manifest: linearPlugin, switchable: false },
  { manifest: azurePlugin, switchable: false },
  { manifest: appearancePlugin, switchable: false },
  { manifest: previewPlugin, switchable: false },
  { manifest: zenPlugin, switchable: true },
];

export const FIRST_PARTY_PLUGIN_CATALOG: ReadonlyArray<ExtensionPackageManifest> =
  FIRST_PARTY_PLUGINS.map((plugin) => plugin.manifest);

/** The bundled plugins a person can switch on or off; each is on until switched off. */
export const SWITCHABLE_FIRST_PARTY_PLUGINS: ReadonlyArray<ExtensionPackageManifest> =
  FIRST_PARTY_PLUGINS.filter((plugin) => plugin.switchable).map((plugin) => plugin.manifest);

/** The switchable bundled plugin with this extension id, if it is one. */
export function switchableFirstPartyPlugin(
  extensionId: string,
): ExtensionPackageManifest | undefined {
  return SWITCHABLE_FIRST_PARTY_PLUGINS.find(
    (manifest) => String(manifest.extensionId) === extensionId,
  );
}

export function firstPartyContributions(): ReadonlyArray<ExtensionContribution> {
  return FIRST_PARTY_PLUGIN_CATALOG.flatMap((plugin) => plugin.contributions ?? []);
}

export function isFirstPartyPluginComponentId(value: string): value is FirstPartyPluginComponentId {
  return FIRST_PARTY_PLUGIN_CATALOG.some((plugin) =>
    plugin.components.some((component) => String(component.id) === value),
  );
}
