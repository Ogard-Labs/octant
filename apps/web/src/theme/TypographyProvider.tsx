import { DEFAULT_THEME_SETTINGS, type ThemeTypography } from "@octant/contracts/theme";
import {
  resolveTypographyProjection,
  type EditorTypographyProjection,
  type ResolvedTypographyProjection,
  type TerminalTypographyProjection,
  type UiTypographyProjection,
} from "@octant/theme/typography";
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo } from "react";

type TypographyContextValue = ResolvedTypographyProjection;

const GENERIC_FONT_FAMILIES = new Set([
  "cursive",
  "emoji",
  "fantasy",
  "fangsong",
  "math",
  "monospace",
  "serif",
  "sans-serif",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

const defaultProjection = resolveTypographyProjection(DEFAULT_THEME_SETTINGS.typography, []);
const TypographyContext = createContext<TypographyContextValue>(defaultProjection);

export interface ThemeTypographyProviderProps {
  readonly availableFonts?: ReadonlyArray<string>;
  readonly children: ReactNode;
  readonly typography?: ThemeTypography;
}

export function ThemeTypographyProvider(props: ThemeTypographyProviderProps) {
  const typography = props.typography ?? DEFAULT_THEME_SETTINGS.typography;
  const availableFonts = useMemo(
    () => props.availableFonts ?? detectAvailableFontFamilies(typography),
    [props.availableFonts, typography],
  );
  const projection = useMemo(
    () => resolveTypographyProjection(typography, availableFonts),
    [availableFonts, typography],
  );

  useLayoutEffect(() => applyTypographyVariables(projection), [projection]);

  return (
    <TypographyContext.Provider value={projection}>{props.children}</TypographyContext.Provider>
  );
}

export function useTypographyProjection(surface: "ui"): UiTypographyProjection;
export function useTypographyProjection(surface: "editor"): EditorTypographyProjection;
export function useTypographyProjection(surface: "terminal"): TerminalTypographyProjection;
export function useTypographyProjection(
  surface: "ui" | "editor" | "terminal",
): UiTypographyProjection | EditorTypographyProjection | TerminalTypographyProjection {
  const projection = useContext(TypographyContext);
  return projection[surface];
}

function applyTypographyVariables(projection: ResolvedTypographyProjection): () => void {
  const root = document.documentElement;
  const values: Readonly<Record<string, string>> = {
    "--octant-ui-font-family": projection.ui.fontFamily,
    "--octant-ui-font-size": `${projection.ui.fontSize}px`,
    "--octant-ui-font-weight": `${projection.ui.fontWeight}`,
    "--octant-editor-font-family": projection.editor.fontFamily,
    "--octant-editor-font-size": `${projection.editor.fontSize}px`,
    "--octant-editor-font-weight": `${projection.editor.fontWeight}`,
    "--octant-editor-line-height": `${projection.editor.lineHeight}`,
    "--octant-editor-font-ligatures": projection.editor.fontLigatures ? "common-ligatures" : "none",
    "--octant-terminal-font-family": projection.terminal.fontFamily,
    "--octant-terminal-font-size": `${projection.terminal.fontSize}px`,
    "--octant-terminal-font-weight": `${projection.terminal.fontWeight}`,
    "--octant-terminal-line-height": `${projection.terminal.lineHeight}`,
    "--octant-terminal-font-ligatures": projection.terminal.fontLigatures
      ? "common-ligatures"
      : "none",
  };
  const previous = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, root.style.getPropertyValue(name));
    root.style.setProperty(name, value);
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === "") root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    }
  };
}

function detectAvailableFontFamilies(typography: ThemeTypography): ReadonlyArray<string> {
  if (typeof document === "undefined" || typeof document.fonts?.check !== "function") return [];
  const names = new Set<string>();
  for (const family of [
    typography.ui.family,
    typography.editor.family,
    typography.terminal.family,
  ]) {
    if (typeof family !== "string") continue;
    for (const token of family.split(",")) {
      const normalized = token.trim().replace(/^["']|["']$/g, "");
      if (normalized.length > 0 && !isGenericFontFamily(normalized)) names.add(normalized);
    }
  }
  return [...names].filter((family) => {
    try {
      return document.fonts.check(`16px "${family.replaceAll('"', '\\"')}"`);
    } catch {
      return false;
    }
  });
}

function isGenericFontFamily(value: string): boolean {
  return GENERIC_FONT_FAMILIES.has(value.toLowerCase());
}
