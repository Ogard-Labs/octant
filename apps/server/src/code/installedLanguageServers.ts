import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import type { ExtensionCompatibility } from "@octant/contracts/extensions";
import {
  isExtensionComponentModeSafe,
  resolveExtensionActivation,
} from "@octant/plugin-host/activation";
import type { CodeLanguageServerComponent } from "./codeLanguageService";

/**
 * Language servers a person installed through the extension package store,
 * as components the Code language service may start. Canonical:
 * docs/design/language-services.md (user-added servers).
 *
 * A server contributes only while the activation ladder makes it effective in
 * Code: installed, not quarantined, its source trusted, the plugin and the
 * component switched on, and compatible with this host. Installing it alone
 * never does, so a server nobody reviewed never starts. The binary is
 * resolved at each start from the stored version, and only after that version
 * verifies against the digest the person reviewed. A `repo-tooling` server
 * also needs a person's approval for the checkout before it starts, which the
 * language service asks for.
 */

export interface InstalledLanguageServerStore {
  readonly contentRoot: (target: InstalledVersion) => string;
  readonly verifiedEntryPoint: (
    target: InstalledVersion,
    componentId: string,
  ) => Promise<string | undefined>;
}

interface InstalledVersion {
  readonly extensionId: string;
  readonly packageId: string;
  readonly version: string;
  readonly digest: string;
}

export interface InstalledLanguageServerOptions {
  readonly snapshot: () => ExtensionSnapshot;
  readonly store: InstalledLanguageServerStore;
  /** Whether a package's declared platforms and app range admit this host. */
  readonly compatible: (compatibility: ExtensionCompatibility) => boolean;
}

/**
 * The installed language servers effective in Code, read on every request so
 * a server whose trust or switch is withdrawn stops contributing at once.
 * Ordered by package name, so which of two servers for one language serves it
 * never depends on install order.
 */
export function installedLanguageServerComponents(
  options: InstalledLanguageServerOptions,
): () => ReadonlyArray<CodeLanguageServerComponent> {
  return () => {
    const components: Array<CodeLanguageServerComponent & { readonly order: string }> = [];
    for (const packageState of options.snapshot().packages) {
      // A bundled server is declared by the host itself and never comes from
      // the store, so nothing in the store can stand in for one.
      if (packageState.source.kind === "bundled") continue;
      const target: InstalledVersion = {
        extensionId: String(packageState.extensionId),
        packageId: String(packageState.packageId),
        version: String(packageState.version),
        digest: String(packageState.digest),
      };
      for (const { component, activation } of packageState.components) {
        const declaration = component.languageServer;
        if (component.kind !== "language-server" || declaration === undefined) continue;
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
        try {
          installRoot = options.store.contentRoot(target);
        } catch {
          continue;
        }
        const componentId = String(component.id);
        // The digest is part of the key, so an update is a new server with
        // its own cache rather than the old binary's process and files.
        const componentKey = `${target.extensionId}:${componentId}:${target.digest}`;
        components.push({
          order: `${packageState.slug ?? ""}\0${target.extensionId}\0${componentId}`,
          componentKey,
          // The package's lifecycle version moves with every change a person
          // makes to it, so an approval given before a switch, a change of
          // trust, or an update does not cover what runs after it.
          approvalKey: `${componentKey}@${String(packageState.stateVersion)}`,
          languages: declaration.languages,
          launchClass: declaration.launchClass,
          executable: () => options.store.verifiedEntryPoint(target, componentId),
          // A user-added server is started with no arguments: its package
          // declares none, so nothing but the binary decides how it runs.
          args: [],
          installRoot,
          sourceLabel: packageState.slug ?? "language-server",
        });
      }
    }
    return components
      .sort((left, right) => (left.order < right.order ? -1 : left.order > right.order ? 1 : 0))
      .map(({ order: _order, ...component }) => component);
  };
}
