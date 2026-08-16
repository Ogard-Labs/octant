import type { ReactNode } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { glassChromeStyle } from "./materials";
import { radii, type GlassMaterial } from "./tokens";
import { useTheme } from "./theme";

export interface GlassSurfaceProps {
  readonly children?: ReactNode;
  readonly material?: GlassMaterial;
  readonly radius?: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly contentStyle?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

function flatFillFor(
  material: GlassMaterial,
  surfaceSolid: string,
  surfaceElevatedSolid: string,
): string {
  switch (material) {
    case "ultraThin":
    case "thin":
      return surfaceSolid;
    case "regular":
    case "chrome":
      return surfaceElevatedSolid;
    case "thick":
      return surfaceElevatedSolid;
  }
}

/**
 * Panel surface. In glass mode: frosted blur. In flat mode: solid Distilled fill
 * with a hairline border — no blur.
 */
export function GlassSurface(props: GlassSurfaceProps) {
  const { scheme, materials, colors, surfaceStyle } = useTheme();
  const material = props.material ?? "regular";
  const radius = props.radius ?? radii.md;
  const recipe = materials[material];
  const flat = surfaceStyle === "flat";
  const fill = flat
    ? flatFillFor(material, colors.surfaceSolid, colors.surfaceElevatedSolid)
    : recipe.fill;
  const chrome = flat
    ? ({
        backgroundColor: fill,
        borderRadius: radius,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        overflow: "hidden",
      } satisfies ViewStyle)
    : glassChromeStyle(material, radius, scheme);

  return (
    <View style={[chrome, props.style]} testID={props.testID}>
      {!flat && Platform.OS !== "web" ? (
        <BlurView
          intensity={recipe.blurIntensity}
          style={StyleSheet.absoluteFill}
          tint={recipe.blurTint}
        />
      ) : null}
      <View style={[styles.fill, { backgroundColor: fill }, props.contentStyle]}>
        {props.children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flexGrow: 1,
  },
});
