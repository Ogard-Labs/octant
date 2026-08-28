import {
  decodeExtensionContentDigest,
  decodeExtensionPackageManifest,
  type ExtensionContribution,
  type ExtensionPackageManifest,
} from "@octant/contracts/extensions";

/**
 * First-party plugins the renderer currently knows how to contribute from.
 * Narrower than the general component-id space: only the bundled packages
 * whose surfaces the contribution registry already owns. Step 4 seeds the
 * board and GitHub packages on the server; this catalog stays a static
 * first-party list until that catalog is the source of availability.
 */
export type FirstPartyPluginComponentId =
  | "board"
  | "github-integration"
  | "linear-integration"
  | "appearance-pack"
  | "preview-viewers";

const digest = (nibble: string) => decodeExtensionContentDigest(`sha256:${nibble.repeat(64)}`);

function firstPartyManifest(value: unknown): ExtensionPackageManifest {
  return decodeExtensionPackageManifest(value);
}

const boardPlugin = firstPartyManifest({
  manifestVersion: 1,
  extensionId: "10000000-0000-4000-8000-0000000000b1",
  packageId: "20000000-0000-4000-8000-0000000000b1",
  slug: "board",
  displayName: "Thread board",
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
      displayName: "Thread board",
      declaredCapabilities: [],
      entryPoint: "builtin:board",
    },
  ],
  contributions: [
    {
      point: "sidebar.destination",
      componentId: "board",
      destinationId: "thread-board",
      label: "Thread board",
      modes: ["work", "code"],
      entryPoint: "builtin:board/destination",
    },
    {
      point: "board.view",
      componentId: "board",
      viewId: "thread-status",
      label: "Thread board",
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

export const FIRST_PARTY_PLUGIN_CATALOG: ReadonlyArray<ExtensionPackageManifest> = [
  boardPlugin,
  githubPlugin,
  linearPlugin,
  appearancePlugin,
  previewPlugin,
];

/**
 * Stand-in for the server's first-party plugin activation state. Most
 * packages are bundled and enabled by default with no toggle UI yet; Linear
 * is bundled-off until that catalog is sourced from the server. Step 4
 * replaces this with a value sourced from the server catalog.
 */
export const FIRST_PARTY_PLUGINS_EFFECTIVE: ReadonlyMap<FirstPartyPluginComponentId, boolean> =
  new Map([
    ["board", true],
    ["github-integration", true],
    ["linear-integration", false],
    ["appearance-pack", true],
    ["preview-viewers", true],
  ]);

export function firstPartyContributions(): ReadonlyArray<ExtensionContribution> {
  return FIRST_PARTY_PLUGIN_CATALOG.flatMap((plugin) => plugin.contributions ?? []);
}

export function isFirstPartyPluginComponentId(value: string): value is FirstPartyPluginComponentId {
  return (
    value === "board" ||
    value === "github-integration" ||
    value === "linear-integration" ||
    value === "appearance-pack" ||
    value === "preview-viewers"
  );
}
