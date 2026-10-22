import type { ImageSourcePropType } from "react-native";
import type { ThemeScheme } from "./tokens";
import type { GroundPicture } from "./groundPrint";
import { themeAtmosphereSources } from "./themeAtmospheres";

const SOFT_PICTURES = {
  "soft-glow": {
    light: require("../assets/backgrounds/soft-glow-light.jpg") as ImageSourcePropType,
    dark: require("../assets/backgrounds/soft-glow.jpg") as ImageSourcePropType,
  },
  "soft-graphite": {
    light: require("../assets/backgrounds/soft-graphite-light.jpg") as ImageSourcePropType,
    dark: require("../assets/backgrounds/soft-graphite.jpg") as ImageSourcePropType,
  },
  "soft-sunset": {
    light: require("../assets/backgrounds/soft-sunset-light.jpg") as ImageSourcePropType,
    dark: require("../assets/backgrounds/soft-sunset.jpg") as ImageSourcePropType,
  },
} as const;

/** The bundled print for a picture in a scheme; custom and plain have none. */
export function pictureSource(
  picture: GroundPicture,
  scheme: ThemeScheme,
): ImageSourcePropType | undefined {
  if (picture === "atmosphere") return themeAtmosphereSources[scheme];
  if (picture === "custom" || picture === "plain") return undefined;
  return SOFT_PICTURES[picture][scheme];
}
