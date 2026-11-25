import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { GlassSurface, useTheme } from "../../design-system";
import type { ComposerSurfaceProps } from "./ComposerSurface";

/** The system's glass where it has it and the person has not chosen flat panels. */
export function ComposerSurface(props: ComposerSurfaceProps) {
  const { scheme, surfaceStyle } = useTheme();
  if (surfaceStyle === "flat" || !isLiquidGlassAvailable())
    return (
      <GlassSurface contentStyle={props.contentStyle} material="thick" radius={24}>
        {props.children}
      </GlassSurface>
    );
  return (
    <GlassView
      colorScheme={scheme}
      glassEffectStyle="regular"
      isInteractive
      style={[{ borderRadius: 24 }, props.contentStyle]}
    >
      {props.children}
    </GlassView>
  );
}
