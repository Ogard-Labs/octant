import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
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
 * Panel surface. In glass mode: a translucent tinted fill over the ground (web
 * adds a backdrop blur). In flat mode: solid Distilled fill with a hairline
 * border.
 *
 * Native glass draws no blur view: expo-blur sets its intensity through a
 * paused UIViewPropertyAnimator in every view, so with glass on by default the
 * iOS acceptance run never saw the app go idle and timed out typing into the
 * composer. The desktop's glass tints its panes rather than blurring too.
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
      {/* The outer chrome already carries the fill; painting it again here
          stacked two translucent layers and read as a solid panel. */}
      <View style={[styles.fill, flat ? { backgroundColor: fill } : null, props.contentStyle]}>
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
