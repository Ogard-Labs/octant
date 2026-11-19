import type {
  ExtensionComponentId,
  ExtensionGroundDeclaration,
  ExtensionPackageId,
  ExtensionPackageState,
} from "@octant/contracts/extensions";

/**
 * One character ground a plugin offers: the values to copy into a person's
 * ground when they pick it (the person's copy never refers back to the
 * plugin). The id comes from host-owned identity, never from the package.
 */
export interface ContributedGround {
  readonly id: string;
  readonly displayName: string;
  /** The plugin's own name, so two plugins' grounds can be told apart. */
  readonly pluginName: string;
  readonly ground: ExtensionGroundDeclaration;
}

export function contributedGroundId(
  packageId: ExtensionPackageId | string,
  componentId: ExtensionComponentId | string,
): string {
  return `plugin:${String(packageId)}:${String(componentId)}`;
}

/**
 * The grounds the picker may offer: those whose component the host reports
 * effective, which already means installed, trusted, and enabled at both the
 * plugin and the component. A ground is data the manifest decode has already
 * bounded, so nothing else is read from the package.
 */
export function groundContributions(
  packages: ReadonlyArray<
    Pick<ExtensionPackageState, "packageId" | "slug" | "displayName" | "components">
  >,
): ReadonlyArray<ContributedGround> {
  return packages.flatMap((pkg) =>
    pkg.components.flatMap((state) => {
      const { component } = state;
      if (
        component.kind !== "ground" ||
        component.ground === undefined ||
        state.effectiveState.kind !== "effective"
      ) {
        return [];
      }
      return [
        {
          id: contributedGroundId(pkg.packageId, component.id),
          displayName: component.displayName,
          pluginName: pkg.displayName ?? String(pkg.slug),
          ground: component.ground,
        },
      ];
    }),
  );
}
