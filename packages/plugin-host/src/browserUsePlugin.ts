import {
  decodeExtensionPackageManifest,
  decodeExtensionSelection,
  decodeExtensionComponentId,
  type ExtensionSelection,
} from "@octant/contracts/extensions";

/** The host-owned Browser capability addressed by `@Browser`. */
export const BROWSER_USE_PLUGIN = decodeExtensionPackageManifest({
  manifestVersion: 1,
  extensionId: "31b0bb51-a114-41a9-8de0-e31797c21503",
  packageId: "31b0bb51-a114-41a9-8de0-e31797c21504",
  slug: "browser",
  displayName: "Browser",
  version: "1.0.0",
  digest: "sha256:5c93bcbf74a13be17db3d72e5d60b2ff4a7a2fef8e5db0b4f2e1db7c57e4a1d3",
  source: { kind: "bundled", sourceRef: "app:browser" },
  provenance: { publisher: "Octant", reviewed: true },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: { platforms: ["macos", "linux", "windows"], modes: ["chat", "work", "code"], providerFamilies: [] },
  declaredCapabilities: ["browser"],
  primaryComponentId: "browser",
  components: [
    {
      id: "browser",
      kind: "mcp-server",
      displayName: "Browser",
      description: "Use Octant's isolated built-in browser for this task.",
      declaredCapabilities: ["browser"],
      entryPoint: "builtin:browser",
    },
  ],
});

export const BROWSER_SELECTION_GUIDANCE =
  "The user selected Octant's built-in Browser for this task. Use the octant_browser tool for web pages; do not launch an external browser or use shell networking. Browser origin approval is still required at the first action that needs it.";

export function browserUseSelection(reference: string): ExtensionSelection {
  return decodeExtensionSelection({
    kind: "plugin",
    extensionId: BROWSER_USE_PLUGIN.extensionId,
    packageId: BROWSER_USE_PLUGIN.packageId,
    componentId: decodeExtensionComponentId("browser"),
    packageVersion: BROWSER_USE_PLUGIN.version,
    packageDigest: BROWSER_USE_PLUGIN.digest,
    catalogEpoch: BROWSER_USE_PLUGIN.digest,
    origin: { kind: "draft", reference },
  });
}

export function isBrowserUseSelection(selection: ExtensionSelection): boolean {
  return (
    selection.kind === "plugin" &&
    (String(selection.extensionId) === String(BROWSER_USE_PLUGIN.extensionId) ||
      String(selection.packageId) === String(BROWSER_USE_PLUGIN.packageId))
  );
}

/** Validate every pinned field before a Browser selection reaches a provider. */
export function validateBrowserUseSelection(selection: ExtensionSelection): boolean {
  return (
    selection.kind === "plugin" &&
    String(selection.extensionId) === String(BROWSER_USE_PLUGIN.extensionId) &&
    String(selection.packageId) === String(BROWSER_USE_PLUGIN.packageId) &&
    String(selection.componentId) === "browser" &&
    String(selection.packageVersion) === String(BROWSER_USE_PLUGIN.version) &&
    String(selection.packageDigest) === String(BROWSER_USE_PLUGIN.digest) &&
    String(selection.catalogEpoch) === String(BROWSER_USE_PLUGIN.digest)
  );
}
