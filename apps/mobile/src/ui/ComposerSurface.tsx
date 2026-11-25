import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { GlassSurface } from "../../design-system";

export interface ComposerSurfaceProps {
  readonly children: ReactNode;
  readonly contentStyle?: StyleProp<ViewStyle>;
}

/** What the composer stands on, over the end of the transcript. */
export function ComposerSurface(props: ComposerSurfaceProps) {
  return (
    <GlassSurface contentStyle={props.contentStyle} material="thick" radius={24}>
      {props.children}
    </GlassSurface>
  );
}
