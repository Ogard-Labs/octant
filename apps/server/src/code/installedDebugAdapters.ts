import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import {
  decodeExtensionComponentQualifiedId,
  type ExtensionCompatibility,
  type ExtensionComponentQualifiedId,
  type ExtensionDebugAdapterDeclaration,
} from "@octant/contracts/extensions";
import type { DebugAdapterPackageState } from "@octant/domain";
import {
  isExtensionComponentModeSafe,
  resolveExtensionActivation,
} from "@octant/plugin-host/activation";
import type { InstalledLanguageServerStore } from "./installedLanguageServers";

/**
 * Debug adapters a person installed through the extension package store, as
 * the Code debug service may start them. Canonical:
 * docs/design/language-services.md § Component and package.
 *
 * An adapter is offered only while the activation ladder makes it effective
 * in Code: installed, not quarantined, its source trusted, the plugin and the
 * component switched on, and compatible with this host. Its binary is
 * resolved at each start from the stored version, and only after that
 * version verifies against the digest the person reviewed. Octant bundles no
 * adapter (decision DB1), so every one comes from here.
 */

export interface CodeDebugAdapterComponent {
  /** What a configuration names: the extension and component ids. */
  readonly adapter: ExtensionComponentQualifiedId;
  readonly displayName: string;
  readonly declaration: ExtensionDebugAdapterDeclaration;
  /**
   * The reviewed package state a confirmation covers. Its lifecycle version
   * moves with every update, switch, trust change, and reinstall.
   */
  readonly packageState: DebugAdapterPackageState;
  /** The verified binary's absolute path, or undefined when the stored version changed. */
  readonly executable: () => Promise<string | undefined>;
  /** The adapter's stored version, readable inside the capsule. */
  readonly installRoot: string;
}

export interface InstalledDebugAdapterOptions {
  readonly snapshot: () => ExtensionSnapshot;
  readonly store: InstalledLanguageServerStore;
  /** Whether a package's declared platforms and app range admit this host. */
  readonly compatible: (compatibility: ExtensionCompatibility) => boolean;
}

/**
 * The installed debug adapters effective in Code, read on every request so
 * an adapter whose trust or switch is withdrawn is offered nowhere at once.
 * Ordered by package name, so the list never depends on install order.
 */
export function installedDebugAdapterComponents(
  options: InstalledDebugAdapterOptions,
): () => ReadonlyArray<CodeDebugAdapterComponent> {
  return () => {
    const components: Array<CodeDebugAdapterComponent & { readonly order: string }> = [];
    for (const packageState of options.snapshot().packages) {
      if (packageState.source.kind === "bundled") continue;
      const target = {
        extensionId: String(packageState.extensionId),
        packageId: String(packageState.packageId),
        version: String(packageState.version),
        digest: String(packageState.digest),
      };
      for (const { component, activation } of packageState.components) {
        const declaration = component.debugAdapter;
        if (component.kind !== "debug-adapter" || declaration === undefined) continue;
        const effective = resolveExtensionActivation({
          ...activation,
          compatible: activation.compatible && options.compatible(packageState.compatibility),
          hostAllowed: true,
          modeAllowed:
            packageState.compatibility.modes.includes("code") &&
            isExtensionComponentModeSafe("code", component),
          projectAllowed: true,
          threadAllowed: true,
          catalogCurrent: true,
        });
        if (effective.kind !== "effective") continue;
        let installRoot: string;
        let adapter: ExtensionComponentQualifiedId;
        try {
          installRoot = options.store.contentRoot(target);
          adapter = decodeExtensionComponentQualifiedId(
            `${target.extensionId}/${String(component.id)}`,
          );
        } catch {
          continue;
        }
        const componentId = String(component.id);
        components.push({
          order: `${packageState.slug ?? ""}\0${target.extensionId}\0${componentId}`,
          adapter,
          displayName: component.displayName,
          declaration,
          packageState: {
            extensionId: packageState.extensionId,
            componentId: component.id,
            packageDigest: packageState.digest,
            lifecycleVersion: packageState.stateVersion,
          },
          executable: () => options.store.verifiedEntryPoint(target, componentId),
          installRoot,
        });
      }
    }
    return components
      .sort((left, right) => (left.order < right.order ? -1 : left.order > right.order ? 1 : 0))
      .map(({ order: _order, ...component }) => component);
  };
}
