import { Schema } from "effect";
import type {
  ExtensionComponent,
  ExtensionComponentId,
  ExtensionPackageId,
  ExtensionPackageManifest,
  ExtensionPackageState,
} from "@octant/contracts/extensions";
import { ThemePresetId } from "@octant/contracts/theme";
import { validateThemePreset, type ThemePreset } from "@octant/theme";

const decodeThemePresetId = Schema.decodeSync(ThemePresetId);

/**
 * The preset id a contributed theme is stored and picked under. It comes from
 * host-owned identity (the package id and component id), never from the
 * package, so a plugin cannot take a built-in preset's id or another
 * plugin's.
 */
export function contributedThemePresetId(
  packageId: ExtensionPackageId | string,
  componentId: ExtensionComponentId | string,
): ThemePresetId {
  return decodeThemePresetId(`plugin:${String(packageId)}:${String(componentId)}`);
}

export type ContributedThemeReading =
  | { readonly status: "accepted"; readonly preset: ThemePreset }
  | {
      readonly status: "refused";
      readonly reason: "not-a-theme" | "theme-invalid";
      /** Host-worded validation errors; no text from the package. */
      readonly errors: ReadonlyArray<string>;
    };

/**
 * Reads one theme component as a preset and checks it with the same
 * validation the built-in presets pass: every semantic role present in each
 * supported mode, six-digit colours only, and text that meets contrast.
 */
export function readContributedTheme(input: {
  readonly packageId: ExtensionPackageId | string;
  readonly packageDisplayName?: string | undefined;
  readonly component: ExtensionComponent;
}): ContributedThemeReading {
  const { component } = input;
  const theme = component.theme;
  if (component.kind !== "theme" || theme === undefined) {
    return { status: "refused", reason: "not-a-theme", errors: [] };
  }
  const preset: ThemePreset = {
    id: contributedThemePresetId(input.packageId, component.id),
    displayName: component.displayName,
    description: component.description ?? input.packageDisplayName ?? component.displayName,
    supportedModes: theme.supportedModes,
    tokens: {
      ...(theme.tokens.light === undefined ? {} : { light: theme.tokens.light }),
      ...(theme.tokens.dark === undefined ? {} : { dark: theme.tokens.dark }),
    },
    ...(theme.patternPalette === undefined ? {} : { patternPalette: theme.patternPalette }),
  };
  const validation = validateThemePreset(preset);
  return validation.valid
    ? { status: "accepted", preset }
    : { status: "refused", reason: "theme-invalid", errors: validation.errors };
}

/**
 * The first theme in a package that fails validation, so the host refuses the
 * whole package at install rather than listing part of it.
 */
export function refusedThemeContribution(
  manifest: ExtensionPackageManifest,
):
  | { readonly componentId: ExtensionComponentId; readonly errors: ReadonlyArray<string> }
  | undefined {
  for (const component of manifest.components) {
    if (component.kind !== "theme") continue;
    const reading = readContributedTheme({
      packageId: manifest.packageId,
      packageDisplayName: manifest.displayName,
      component,
    });
    if (reading.status === "refused") return { componentId: component.id, errors: reading.errors };
  }
  return undefined;
}

/**
 * The themes the picker may offer: those whose component the host reports
 * effective, which already means installed, trusted, and enabled at both the
 * plugin and the component. A theme that fails validation is left out even
 * then, so a row written before a stricter check cannot reach the page.
 */
export function effectiveContributedThemes(
  packages: ReadonlyArray<Pick<ExtensionPackageState, "packageId" | "displayName" | "components">>,
): ReadonlyArray<ThemePreset> {
  return packages.flatMap((pkg) =>
    pkg.components.flatMap((state) => {
      if (state.component.kind !== "theme" || state.effectiveState.kind !== "effective") return [];
      const reading = readContributedTheme({
        packageId: pkg.packageId,
        packageDisplayName: pkg.displayName,
        component: state.component,
      });
      return reading.status === "accepted" ? [reading.preset] : [];
    }),
  );
}
