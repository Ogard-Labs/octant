import { useFonts } from "expo-font";

/**
 * Loads JetBrainsMono Nerd Font for Distilled mono/code surfaces.
 * Call once at app root before rendering ScreenCanvas code lattice.
 */
export function useDistilledFonts(): { readonly ready: boolean } {
  const [loaded] = useFonts({
    JetBrainsMonoNerdFont: require("../../assets/fonts/JetBrainsMonoNerdFont-Regular.ttf"),
  });
  return { ready: loaded };
}
