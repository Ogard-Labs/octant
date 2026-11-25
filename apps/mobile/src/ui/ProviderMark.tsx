import { Image, type ImageSourcePropType } from "react-native";
import { PROVIDER_GLYPH_COLOR_FALLBACKS } from "@octant/theme";
import { useTheme } from "../../design-system";
import azureFoundry from "../../assets/providers/azure-foundry.png";
import claude from "../../assets/providers/claude.png";
import cline from "../../assets/providers/cline.png";
import codex from "../../assets/providers/codex.png";
import copilot from "../../assets/providers/copilot.png";
import devin from "../../assets/providers/devin.png";
import gemini from "../../assets/providers/gemini.png";
import grok from "../../assets/providers/grok.png";
import kilo from "../../assets/providers/kilo.png";
import kimiCode from "../../assets/providers/kimi-code.png";
import mistralVibe from "../../assets/providers/mistral-vibe.png";
import ollama from "../../assets/providers/ollama.png";
import opencode from "../../assets/providers/opencode.png";
import qwen from "../../assets/providers/qwen.png";

// Drawn by scripts/generate-mobile-provider-marks.ts from the desktop's table.
const MARKS: Readonly<Record<string, ImageSourcePropType>> = {
  "azure-foundry": azureFoundry,
  claude,
  cline,
  codex,
  copilot,
  devin,
  gemini,
  grok,
  kilo,
  "kimi-code": kimiCode,
  "mistral-vibe": mistralVibe,
  ollama,
  opencode,
  qwen,
};

/** The provider's mark in its colour; a provider with none draws nothing. */
export function ProviderMark(props: { readonly driverKind: string; readonly size: number }) {
  const { colors } = useTheme();
  const mark = MARKS[props.driverKind];
  if (mark === undefined) return null;
  return (
    <Image
      accessibilityElementsHidden
      accessible={false}
      resizeMode="contain"
      source={mark}
      style={{ width: props.size, height: props.size }}
      tintColor={PROVIDER_GLYPH_COLOR_FALLBACKS[props.driverKind] ?? colors.textSecondary}
    />
  );
}
