import {
  decodeExtensionPackageManifest,
  decodeExtensionSelection,
  decodeExtensionComponentId,
  type ExtensionSelection,
} from "@octant/contracts/extensions";
import { revalidateExtensionSelection, type ExtensionAddressingCatalog } from "./addressing";
import { resolveExtensionActivation } from "./activation";

export const COMPUTER_USE_PLUGIN = decodeExtensionPackageManifest({
  manifestVersion: 1,
  extensionId: "31b0bb51-a114-41a9-8de0-e31797c21501",
  packageId: "31b0bb51-a114-41a9-8de0-e31797c21502",
  slug: "computer",
  displayName: "Computer use",
  version: "1.0.0",
  digest: "sha256:62cfd10a3d7fba139542b85cfaaf92bcc07b98906ce992f771fa9387d28d124d",
  source: { kind: "bundled", sourceRef: "app:computer-use" },
  provenance: { publisher: "Octant", reviewed: true },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: { platforms: ["macos"], modes: ["chat", "work", "code"], providerFamilies: [] },
  declaredCapabilities: ["computer-use"],
  primaryComponentId: "computer",
  components: [
    {
      id: "computer",
      kind: "mcp-server",
      displayName: "Computer",
      description: "Control applications on this Mac through Octant's Computer use capability.",
      declaredCapabilities: ["computer-use"],
      entryPoint: "builtin:computer-use",
    },
  ],
});

export function computerUseCatalog(enabled: boolean): ExtensionAddressingCatalog {
  const plugin = COMPUTER_USE_PLUGIN;
  const componentId = decodeExtensionComponentId("computer");
  return {
    epoch: computerUseSelection("catalog").catalogEpoch,
    plugins: [
      {
        extensionId: plugin.extensionId,
        packageId: plugin.packageId,
        slug: plugin.slug,
        packageVersion: plugin.version,
        packageDigest: plugin.digest,
        primaryComponentId: componentId,
        components: [
          {
            componentId,
            label: "Computer",
            effectiveState: resolveExtensionActivation({
              installed: true,
              trusted: true,
              pluginDesired: enabled,
              componentDesired: true,
              compatible: true,
              policyAllowed: true,
              quarantined: false,
              draining: false,
              broken: false,
              unavailable: false,
              interrupted: false,
              waiting: false,
              hostAllowed: true,
              modeAllowed: true,
              projectAllowed: true,
              threadAllowed: true,
              catalogCurrent: true,
            }),
          },
        ],
      },
    ],
    skills: [],
  };
}

export function computerUseSelection(reference: string): ExtensionSelection {
  return decodeExtensionSelection({
    kind: "plugin",
    extensionId: COMPUTER_USE_PLUGIN.extensionId,
    packageId: COMPUTER_USE_PLUGIN.packageId,
    componentId: "computer",
    packageVersion: COMPUTER_USE_PLUGIN.version,
    packageDigest: COMPUTER_USE_PLUGIN.digest,
    catalogEpoch: COMPUTER_USE_PLUGIN.digest,
    origin: { kind: "draft", reference },
  });
}

export function validateComputerUseSelection(selection: unknown, enabled: boolean): boolean {
  try {
    return (
      revalidateExtensionSelection(
        decodeExtensionSelection(selection),
        computerUseCatalog(enabled),
        "send",
      ).kind === "selected"
    );
  } catch {
    return false;
  }
}

export function isComputerUseSelection(selection: ExtensionSelection): boolean {
  return (
    selection.kind === "plugin" &&
    (String(selection.extensionId) === String(COMPUTER_USE_PLUGIN.extensionId) ||
      String(selection.packageId) === String(COMPUTER_USE_PLUGIN.packageId))
  );
}
