import {
  decodeExtensionPackageManifest,
  type ExtensionActivationState,
  type ExtensionComponent,
  type ExtensionEffectiveState,
  type ExtensionLanguageServerDeclaration,
  type ExtensionPackageManifest,
} from "@octant/contracts/extensions";
import type { OctantMode } from "@octant/contracts/modes";
import {
  isExtensionComponentModeSafe,
  resolveExtensionActivation,
  type ExtensionActivationContext,
} from "./activation";

/**
 * Language servers Octant ships inside the app. Canonical:
 * docs/design/language-services.md (decisions D1 and D2).
 *
 * The bundled TypeScript server is an ordinary `language-server` package on
 * the activation ladder: reviewed because it ships with Octant, on by default,
 * and `static`, so it reads the checkout and writes only its own cache. Its
 * entry point names the binary the host resolves from its own install, never
 * a path a repository or a caller supplies.
 */
export const BUNDLED_TYPESCRIPT_LANGUAGE_SERVER_ENTRY_POINT = "builtin:language-server/typescript";

const LANGUAGE_SERVER_COMPONENT_ID = "language-server";

export const BUNDLED_TYPESCRIPT_LANGUAGE_SERVER: ExtensionPackageManifest =
  decodeExtensionPackageManifest({
    manifestVersion: 1,
    extensionId: "10000000-0000-4000-8000-000000000301",
    packageId: "20000000-0000-4000-8000-000000000301",
    slug: "typescript-language-server",
    displayName: "TypeScript and JavaScript",
    version: "7.0.2",
    digest: "sha256:309f4d8c110dd293513857b812ade24ea536dae31d2a09d04811f1d743fbaa6a",
    source: { kind: "bundled", sourceRef: "app:language-server-typescript" },
    provenance: { publisher: "Octant", reviewed: true },
    license: { kind: "spdx", identifier: "Apache-2.0" },
    compatibility: { platforms: ["macos", "linux"], modes: ["code"], providerFamilies: [] },
    declaredCapabilities: ["filesystem"],
    primaryComponentId: LANGUAGE_SERVER_COMPONENT_ID,
    components: [
      {
        id: LANGUAGE_SERVER_COMPONENT_ID,
        kind: "language-server",
        displayName: "TypeScript and JavaScript",
        declaredCapabilities: ["filesystem"],
        entryPoint: BUNDLED_TYPESCRIPT_LANGUAGE_SERVER_ENTRY_POINT,
        languageServer: {
          languages: ["javascript", "javascriptreact", "typescript", "typescriptreact"],
          launchClass: "static",
        },
      },
    ],
  });

export interface BundledLanguageServerComponent {
  readonly manifest: ExtensionPackageManifest;
  readonly component: ExtensionComponent;
  readonly entryPoint: string;
  readonly languageServer: ExtensionLanguageServerDeclaration;
}

export function bundledLanguageServerComponent(
  manifest: ExtensionPackageManifest,
): BundledLanguageServerComponent {
  const component = manifest.components.find(
    (entry) => entry.kind === "language-server" && entry.id === LANGUAGE_SERVER_COMPONENT_ID,
  );
  if (
    component?.entryPoint === undefined ||
    component.languageServer === undefined ||
    manifest.source.kind !== "bundled"
  ) {
    throw new Error(`Bundled language server ${manifest.slug} is missing its component.`);
  }
  return {
    manifest,
    component,
    entryPoint: component.entryPoint,
    languageServer: component.languageServer,
  };
}

const bundledActivation: ExtensionActivationState = {
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

/**
 * Whether a bundled language server contributes in `mode`. It is on by
 * default (D2); a patch carries what the host observed, such as a binary
 * missing from this install, without inventing a second ladder. Outside Code
 * the kind is mode-prohibited, so no patch can make it effective there.
 */
export function resolveBundledLanguageServerActivation(
  manifest: ExtensionPackageManifest,
  mode: OctantMode,
  patch: Partial<ExtensionActivationContext> = {},
): ExtensionEffectiveState {
  const { component } = bundledLanguageServerComponent(manifest);
  return resolveExtensionActivation({
    hostAllowed: true,
    projectAllowed: true,
    threadAllowed: true,
    catalogCurrent: true,
    ...bundledActivation,
    ...patch,
    modeAllowed: isExtensionComponentModeSafe(mode, component) && (patch.modeAllowed ?? true),
  });
}
