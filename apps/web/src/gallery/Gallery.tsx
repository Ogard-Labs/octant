import { DEFAULT_THEME_SETTINGS, type ThemeSettings } from "@octant/contracts/theme";
import { useCallback, useRef, useState } from "react";
import { ThemeSettingsProvider } from "../theme/ThemeSettingsProvider";
import { ThemeTypographyProvider } from "../theme/TypographyProvider";
import { IconDefaults } from "../ui/IconDefaults";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { ControlSections } from "./controls";
import { ColourRoles, IconScale, Radii, SpacingScale, TypeRoles } from "./foundations";
import { OverlaySections } from "./overlays";
import { PatternSections } from "./patterns";
import "../styles.css";
import "../styles/shell.css";
import "../styles/dock.css";
import "../styles/environment.css";
// Settings screens load this where they mount; the gallery shows two of its controls.
import "../styles/settings.css";
// The shared component/material layer loads last, as it does in the app.
import "../styles/components.css";
import "./gallery.css";

const SIZES = [12, 13, 14, 15, 16] as const;

const CONTENTS = [
  ["type", "Type"],
  ["colour", "Colour"],
  ["spacing", "Spacing"],
  ["radii", "Radii"],
  ["icons", "Icons"],
  ["buttons", "Buttons"],
  ["icon-buttons", "Icon button"],
  ["fields", "Fields"],
  ["labels", "Labels and tabs"],
  ["menus", "Menus"],
  ["popups", "Popups"],
  ["dialogs", "Dialogs and notices"],
  ["patterns", "Patterns"],
] as const;

/**
 * Moves keyboard focus to the specimen after `previous` among those marked as
 * focus samples, so focus-visible can be seen on each, and returns its index.
 * The caller keeps the index: a click focuses the stepping button itself in
 * most browsers, so the focused element cannot say where the walk had reached,
 * and every press went back to the first sample.
 */
function stepFocus(previous: number): number {
  const samples = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-focus-sample] :is(button, input, textarea, [role=switch], [role=combobox])",
    ),
  );
  if (samples.length === 0) return -1;
  const index = (previous + 1) % samples.length;
  document.documentElement.dataset.octantInput = "keyboard";
  samples[index]?.focus();
  return index;
}

/**
 * The component gallery: the shared adapters and the shipped stylesheets drawn
 * together, with no host, thread or server behind them. Development only; see
 * `component-gallery.html`.
 */
export function Gallery() {
  const [mode, setMode] = useState<"dark" | "light">("dark");
  const [glass, setGlass] = useState(false);
  const [size, setSize] = useState<number>(13);
  const settings: ThemeSettings = {
    ...DEFAULT_THEME_SETTINGS,
    mode,
    reducedTransparency: !glass,
    typography: {
      ...DEFAULT_THEME_SETTINGS.typography,
      ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, size },
    },
  };
  const measureKey = `${mode}-${String(size)}-${String(glass)}`;
  const focusStep = useRef(-1);
  const onStepFocus = useCallback(() => {
    focusStep.current = stepFocus(focusStep.current);
  }, []);
  return (
    <ThemeSettingsProvider rememberMode={false} settings={settings}>
      <IconDefaults>
        <ThemeTypographyProvider typography={settings.typography}>
          <div className={glass ? "gallery shell--material-translucent" : "gallery"}>
            <header className="gallery-bar">
              <h1 className="oct-page-title">Component gallery</h1>
              <div className="gallery-bar__controls">
                <OctantToggleGroup<string>
                  aria-label="Mode"
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "dark" || next === "light") setMode(next);
                  }}
                  value={[mode]}
                >
                  <OctantToggleGroupItem value="dark">Dark</OctantToggleGroupItem>
                  <OctantToggleGroupItem value="light">Light</OctantToggleGroupItem>
                </OctantToggleGroup>
                <label className="gallery-bar__field oct-row-detail">
                  Glass
                  <OctantSwitch checked={glass} label="Glass material" onCheckedChange={setGlass} />
                </label>
                <OctantToggleGroup<string>
                  aria-label="Interface size"
                  onValueChange={(value) => {
                    const next = SIZES.find((candidate) => String(candidate) === value[0]);
                    if (next !== undefined) setSize(next);
                  }}
                  value={[String(size)]}
                >
                  {SIZES.map((candidate) => (
                    <OctantToggleGroupItem key={candidate} value={String(candidate)}>
                      {candidate}
                    </OctantToggleGroupItem>
                  ))}
                </OctantToggleGroup>
                <OctantButton onClick={onStepFocus} size="sm" type="button" variant="outline">
                  Step keyboard focus
                </OctantButton>
              </div>
              <nav aria-label="Sections" className="gallery-bar__contents">
                {CONTENTS.map(([id, label]) => (
                  <a href={`#${id}`} key={id}>
                    {label}
                  </a>
                ))}
              </nav>
            </header>
            <main className="gallery-main">
              <TypeRoles sizeKey={measureKey} />
              <ColourRoles themeKey={measureKey} />
              <SpacingScale sizeKey={measureKey} />
              <Radii sizeKey={measureKey} />
              <IconScale sizeKey={measureKey} />
              <ControlSections />
              <OverlaySections />
              <PatternSections />
            </main>
          </div>
        </ThemeTypographyProvider>
      </IconDefaults>
    </ThemeSettingsProvider>
  );
}
