import {
  CUSTOM_THEME_PRESET_ID,
  decodeThemeHexColor,
  type ThemeCustomContrast,
  type ThemeCustomSeeds,
  type ThemeDensity,
  type ThemeSettings,
  type ThemeStyle,
} from "@octant/contracts/theme";
import { customThemeTokens } from "@octant/theme/custom-preset";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";
import { THEME_PRESETS } from "@octant/theme";
import type { BackgroundImageLibrary } from "../settings/AppBackgroundSettings";
import type { ThemeController } from "./useThemeController";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { SettingRow, SettingsDisclosure, SettingsSection } from "../settings/primitives";
import { FontFamilyPicker } from "./FontFamilyPicker";
import {
  ACCENT_SWATCHES,
  currentAccentSwatch,
  overridesForAccent,
  swatchDotColor,
} from "./accentSwatches";
import {
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  isAppearancePresetAvailable,
  type FirstPartyPluginComponentId,
} from "../shell/contributionRegistry";
import { usePluginThemes } from "./pluginThemes";

export function ThemeAppearanceEditor(props: {
  readonly controller: ThemeController;
  readonly effectivePlugins?: ReadonlyMap<FirstPartyPluginComponentId, boolean>;
  /** The control a Settings deep link or search result landed on. */
  readonly focusedSetting?: string;
  /**
   * Sections the page places between the theme's own: the window's glass and
   * the background after the colour scheme, reading after typography. The
   * page reads look, then text, then accessibility, rather than every theme
   * control first and the rest after.
   */
  readonly afterScheme?: ReactNode;
  readonly afterTypography?: ReactNode;
  /** The host's photo library; an imported theme's photo that is not in it is left out. */
  readonly photoLibrary?: BackgroundImageLibrary | undefined;
}) {
  const focusedSetting = props.focusedSetting;
  const theme = props.controller;
  const draft = theme.draft;
  const systemPrefersDark = useMediaQueryMatches("(prefers-color-scheme: dark)");
  // The chips show the fill the page will really use in the current mode.
  const shownMode: "light" | "dark" =
    draft?.mode === "dark" || (draft?.mode !== "light" && systemPrefersDark) ? "dark" : "light";
  // Stored "default" and the retired "vivid" both draw the colour look.
  const shownStyle: ThemeStyle = draft?.style === "mono" ? "mono" : "default";
  const pluginThemes = usePluginThemes();
  const availablePresets = [
    ...THEME_PRESETS.filter((preset) =>
      isAppearancePresetAvailable(
        preset.id,
        props.effectivePlugins ?? FIRST_PARTY_PLUGINS_EFFECTIVE,
      ),
    ),
    ...pluginThemes,
  ];
  const presetOptions = (mode: "light" | "dark") => [
    ...availablePresets
      .filter((preset) => preset.supportedModes.includes(mode))
      .map((preset) => ({ id: String(preset.id), label: preset.displayName })),
    { id: CUSTOM_THEME_PRESET_ID, label: "Custom" },
  ];
  // A stored preset that is no longer offered (its plugin was switched off or
  // removed) draws the default theme, so the picker shows the default too.
  // The stored choice is kept and returns with the plugin.
  const shownPreset = (mode: "light" | "dark", stored: string | undefined) =>
    stored !== undefined && presetOptions(mode).some((option) => option.id === stored)
      ? stored
      : "system";
  if (draft === undefined) {
    // The page's own sections do not wait on the theme: glass and reading are
    // shell settings, and they stayed reachable while the theme loaded before
    // they were placed between its sections.
    return (
      <>
        <p className="settings-view__empty" role="status">
          Loading Appearance settings…
        </p>
        {props.afterScheme}
        {props.afterTypography}
      </>
    );
  }
  const shownAccent = currentAccentSwatch(draft);
  const shownDensity: ThemeDensity = draft.density ?? "comfortable";
  const smoothText = draft.fontSmoothing !== "off";
  const setTypography = (surface: "ui" | "editor" | "terminal", patch: Record<string, unknown>) => {
    void theme.applyPatch({
      typography: {
        ...draft.typography,
        [surface]: { ...draft.typography[surface], ...patch },
      } as ThemeSettings["typography"],
    });
  };
  return (
    <div className="settings-theme-editor" aria-label="Appearance preview controls">
      <div className="settings-feedback-slot" aria-live="polite">
        {theme.error !== undefined ? (
          <OctantAlert className="settings-view__error" tone="danger">
            {theme.error}
          </OctantAlert>
        ) : null}
      </div>
      <SettingsSection
        className="settings-theme-editor__scheme-section"
        id="settings-color-scheme"
        title="Color scheme"
      >
        <div className="setgroup">
          <div
            aria-label="Theme mode"
            className="settings-scheme"
            onKeyDown={moveWithinRadioGroup}
            role="radiogroup"
          >
            {(
              [
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ] as const
            ).map((option) => (
              <OctantButton
                aria-checked={draft.mode === option.value}
                className="settings-scheme__card window-no-drag"
                key={option.value}
                onClick={() => void theme.applyPatch({ mode: option.value })}
                role="radio"
                type="button"
                variant="bare"
              >
                <span
                  aria-hidden="true"
                  className={`settings-scheme__preview settings-scheme__preview--${option.value}`}
                >
                  <span className="settings-scheme__preview-pane settings-scheme__preview-pane--light">
                    <span className="settings-scheme__preview-sidebar" />
                    <span className="settings-scheme__preview-content">
                      <span />
                      <span />
                    </span>
                  </span>
                  <span className="settings-scheme__preview-pane settings-scheme__preview-pane--dark">
                    <span className="settings-scheme__preview-sidebar" />
                    <span className="settings-scheme__preview-content">
                      <span />
                      <span />
                    </span>
                  </span>
                </span>
                <span className="settings-scheme__label">{option.label}</span>
              </OctantButton>
            ))}
          </div>
          <SettingRow
            label="Light preset"
            scope="app"
            settingId="appearance.scheme.light-preset"
            focused={focusedSetting === "appearance.scheme.light-preset"}
          >
            <span className="settings-preset-choice">
              <PresetSwatch mode="light" presetId={shownPreset("light", draft.lightPresetId)} />
              <OctantSelectField
                aria-label="Light preset"
                className="settings-view__select"
                onValueChange={(value) => void theme.applyPatch({ lightPresetId: value as never })}
                options={presetOptions("light")}
                value={shownPreset("light", draft.lightPresetId)}
              />
            </span>
          </SettingRow>
          <SettingRow
            label="Dark preset"
            scope="app"
            settingId="appearance.scheme.dark-preset"
            focused={focusedSetting === "appearance.scheme.dark-preset"}
          >
            <span className="settings-preset-choice">
              <PresetSwatch mode="dark" presetId={shownPreset("dark", draft.darkPresetId)} />
              <OctantSelectField
                aria-label="Dark preset"
                className="settings-view__select"
                onValueChange={(value) => void theme.applyPatch({ darkPresetId: value as never })}
                options={presetOptions("dark")}
                value={shownPreset("dark", draft.darkPresetId)}
              />
            </span>
          </SettingRow>
          {draft.lightPresetId === CUSTOM_THEME_PRESET_ID ? (
            <CustomSeedsEditor
              focusedSetting={focusedSetting}
              mode="light"
              onChange={(seeds) => void theme.applyPatch({ customThemeLight: seeds })}
              seeds={draft.customThemeLight}
            />
          ) : null}
          {draft.darkPresetId === CUSTOM_THEME_PRESET_ID ? (
            <CustomSeedsEditor
              focusedSetting={focusedSetting}
              mode="dark"
              onChange={(seeds) => void theme.applyPatch({ customThemeDark: seeds })}
              seeds={draft.customThemeDark}
            />
          ) : null}
          <SettingRow
            description="Comfortable is the default. Compact takes less room: shorter navigation and Settings rows, a narrower thread gutter, and a tighter prompt."
            focused={focusedSetting === "appearance.density"}
            label="Density"
            scope="app"
            settingId="appearance.density"
          >
            <OctantToggleGroup<ThemeDensity>
              aria-label="Density"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected === undefined || selected === shownDensity) return;
                void theme.applyPatch({ density: selected });
              }}
              value={[shownDensity]}
            >
              <OctantToggleGroupItem value="comfortable">Comfortable</OctantToggleGroupItem>
              <OctantToggleGroupItem value="compact">Compact</OctantToggleGroupItem>
            </OctantToggleGroup>
          </SettingRow>
          <SettingRow
            description="Colour gives Octant an accent, status hues, and coloured tiles, board marks, and Project accents. Mono keeps everything grey."
            focused={focusedSetting === "appearance.scheme.style"}
            label="Style"
            scope="app"
            settingId="appearance.scheme.style"
          >
            <OctantToggleGroup<ThemeStyle>
              aria-label="Style"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected === undefined || selected === shownStyle) return;
                void theme.applyPatch({ style: selected });
              }}
              value={[shownStyle]}
            >
              <OctantToggleGroupItem value="default">Colour</OctantToggleGroupItem>
              <OctantToggleGroupItem value="mono">Mono</OctantToggleGroupItem>
            </OctantToggleGroup>
          </SettingRow>
          <SettingRow
            description="Switches, primary buttons, and selected states. Mono is the grey look and sets Style to Mono."
            focused={focusedSetting === "appearance.scheme.accent"}
            label="Accent"
            scope="app"
            settingId="appearance.scheme.accent"
          >
            <div
              aria-label="Accent colour"
              className="settings-accent"
              onKeyDown={moveWithinRadioGroup}
              role="radiogroup"
            >
              {ACCENT_SWATCHES.map((swatch) => {
                const checked = shownAccent === swatch.id;
                return (
                  <OctantButton
                    aria-checked={checked}
                    aria-label={swatch.label}
                    className="settings-accent__swatch hover:no-underline"
                    key={swatch.id}
                    onClick={() =>
                      void theme.applyPatch({
                        ...(swatch.id === "mono" ? { style: "mono" as const } : {}),
                        semanticOverrides: overridesForAccent(
                          draft.semanticOverrides,
                          swatch.id,
                          draft.style,
                        ),
                      })
                    }
                    role="radio"
                    style={
                      {
                        "--settings-accent-swatch":
                          swatchDotColor(swatch, shownMode) ?? "var(--octant-text-primary)",
                      } as CSSProperties
                    }
                    title={swatch.label}
                    type="button"
                    variant="link"
                  >
                    <span aria-hidden="true" className="settings-accent__dot" />
                  </OctantButton>
                );
              })}
            </div>
          </SettingRow>
        </div>
      </SettingsSection>
      {props.afterScheme}
      {/* The interface font and its size are among the most-changed settings
          in the app, so they are not worth a click to reach. */}
      <SettingsSection
        className="settings-theme-editor__disclosure"
        id="settings-typography"
        title="Typography"
      >
        <div className="setgroup settings-theme-editor__disclosure-body">
          <TypographyControl
            label="Interface typography"
            familyLabel="Interface font"
            surface="ui"
            focusedSetting={focusedSetting}
            value={draft.typography.ui}
            onChange={(patch) => setTypography("ui", patch)}
            hideLegend
          />
          {runsOnMac() ? (
            <SettingRow
              description="Smooth edges at a heavier weight, so text stays strong. Off draws the system's fuller, grainier strokes."
              focused={focusedSetting === "appearance.typography.smoothing"}
              label="Smooth text"
              scope="app"
              settingId="appearance.typography.smoothing"
            >
              <OctantSwitch
                checked={smoothText}
                label="Smooth text"
                onCheckedChange={(value) =>
                  void theme.applyPatch({ fontSmoothing: value ? "on" : "off" })
                }
              />
            </SettingRow>
          ) : null}
          <SettingsDisclosure
            title="Code typography"
            defaultOpen={focusedSetting?.startsWith("appearance.typography.editor.") === true}
            description="Font, size, and spacing inside code editors."
          >
            <TypographyControl
              label="Code typography"
              familyLabel="Code font"
              surface="editor"
              focusedSetting={focusedSetting}
              value={draft.typography.editor}
              onChange={(patch) => setTypography("editor", patch)}
              extended
              hideLegend
            />
          </SettingsDisclosure>
          <SettingsDisclosure
            title="Terminal typography"
            defaultOpen={focusedSetting?.startsWith("appearance.typography.terminal.") === true}
            description="Font, size, and spacing inside terminals."
          >
            <TypographyControl
              label="Terminal typography"
              familyLabel="Terminal font family"
              surface="terminal"
              focusedSetting={focusedSetting}
              value={draft.typography.terminal}
              onChange={(patch) => setTypography("terminal", patch)}
              extended
              hideLegend
            />
          </SettingsDisclosure>
        </div>
      </SettingsSection>
      {props.afterTypography}
      <SettingsSection
        className="settings-theme-editor__accessibility"
        id="settings-accessibility"
        title="Accessibility"
      >
        <div className="setgroup">
          <SettingRow
            label="Increased contrast"
            scope="app"
            settingId="appearance.accessibility.increased-contrast"
            focused={focusedSetting === "appearance.accessibility.increased-contrast"}
          >
            <OctantSwitch
              checked={draft.increasedContrast}
              label="Increased contrast"
              onCheckedChange={(value) => void theme.applyPatch({ increasedContrast: value })}
            />
          </SettingRow>
          <SettingRow
            label="Reduced motion"
            scope="app"
            settingId="appearance.accessibility.reduced-motion"
            focused={focusedSetting === "appearance.accessibility.reduced-motion"}
          >
            <OctantSwitch
              checked={draft.reducedMotion}
              label="Reduced motion"
              onCheckedChange={(value) => void theme.applyPatch({ reducedMotion: value })}
            />
          </SettingRow>
          <SettingRow
            label="Reduced transparency"
            scope="app"
            settingId="appearance.accessibility.reduced-transparency"
            focused={focusedSetting === "appearance.accessibility.reduced-transparency"}
          >
            <OctantSwitch
              checked={draft.reducedTransparency}
              label="Reduced transparency"
              onCheckedChange={(value) => void theme.applyPatch({ reducedTransparency: value })}
            />
          </SettingRow>
        </div>
      </SettingsSection>
      <OctantCollapsible
        chevron="end"
        chevronSize={16}
        className="settings-card-section settings-card-section--open settings-theme-editor__disclosure"
        {...(focusedSetting === "appearance.theme-import-export" ? { open: true } : {})}
        summary={<span>Import or export theme</span>}
      >
        <div className="setgroup settings-theme-editor__disclosure-body">
          <ThemeTransfer
            controller={theme}
            focused={focusedSetting === "appearance.theme-import-export"}
            photoLibrary={props.photoLibrary}
          />
        </div>
      </OctantCollapsible>
    </div>
  );
}

/** Smoothing is a macOS rendering choice; the switch is hidden on any other system. */
function runsOnMac(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

const DEFAULT_CUSTOM_SEEDS: Readonly<Record<"light" | "dark", ThemeCustomSeeds>> = {
  light: {
    ground: decodeThemeHexColor("#f4f4f2"),
    ink: decodeThemeHexColor("#1c1c1e"),
    accent: decodeThemeHexColor("#1f6f96"),
    contrast: "standard",
  },
  dark: {
    ground: decodeThemeHexColor("#161616"),
    ink: decodeThemeHexColor("#ececec"),
    accent: decodeThemeHexColor("#6aa9d6"),
    contrast: "standard",
  },
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The seeds of the Custom preset for one mode: Ground, Ink, Accent and a
 * Contrast step. Seeds that cannot keep a text role readable are refused with
 * the failing role named, and the saved seeds stay where they were.
 */
function CustomSeedsEditor(props: {
  readonly mode: "light" | "dark";
  readonly seeds: ThemeCustomSeeds | undefined;
  readonly onChange: (seeds: ThemeCustomSeeds) => void;
  readonly focusedSetting?: string | undefined;
}) {
  const seeds = props.seeds ?? DEFAULT_CUSTOM_SEEDS[props.mode];
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const modeLabel = props.mode === "light" ? "Light" : "Dark";
  const commit = (next: ThemeCustomSeeds) => {
    const result = customThemeTokens(next, props.mode);
    if (result.status === "refused") {
      setRefusal(`${result.role} would not stay readable with those colours.`);
      return;
    }
    setRefusal(undefined);
    props.onChange(next);
  };
  const colour = (field: "ground" | "ink" | "accent", label: string) => (
    <SettingRow
      focused={props.focusedSetting === `appearance.custom.${props.mode}.${field}`}
      label={`${modeLabel} ${label}`}
      scope="app"
      settingId={`appearance.custom.${props.mode}.${field}`}
    >
      <OctantInput
        aria-label={`${modeLabel} ${label} colour`}
        className="settings-view__select"
        defaultValue={String(seeds[field])}
        key={String(seeds[field])}
        maxLength={7}
        onBlur={(event) => {
          const value = event.currentTarget.value.trim();
          if (!HEX_COLOR.test(value)) {
            setRefusal(`${label} needs a six-digit colour such as #1b1d23.`);
            return;
          }
          commit({ ...seeds, [field]: decodeThemeHexColor(value) });
        }}
        spellCheck={false}
      />
    </SettingRow>
  );
  return (
    <>
      {colour("ground", "ground")}
      {colour("ink", "ink")}
      {colour("accent", "accent")}
      <SettingRow
        description="Soft, Standard or Firm moves every derived wash and edge one step each way."
        focused={props.focusedSetting === `appearance.custom.${props.mode}.contrast`}
        label={`${modeLabel} contrast`}
        scope="app"
        settingId={`appearance.custom.${props.mode}.contrast`}
      >
        <OctantToggleGroup<ThemeCustomContrast>
          aria-label={`${modeLabel} contrast`}
          onValueChange={(value) => {
            const selected = value[0];
            if (selected === undefined || selected === seeds.contrast) return;
            commit({ ...seeds, contrast: selected });
          }}
          value={[seeds.contrast]}
        >
          <OctantToggleGroupItem value="soft">Soft</OctantToggleGroupItem>
          <OctantToggleGroupItem value="standard">Standard</OctantToggleGroupItem>
          <OctantToggleGroupItem value="firm">Firm</OctantToggleGroupItem>
        </OctantToggleGroup>
      </SettingRow>
      {refusal === undefined ? null : (
        <OctantAlert className="settings-view__error" tone="danger">
          {refusal}
        </OctantAlert>
      )}
    </>
  );
}

function TypographyControl(props: {
  readonly label: string;
  readonly familyLabel: string;
  readonly surface: "ui" | "editor" | "terminal";
  readonly value: {
    readonly family: string;
    readonly size: number;
    readonly weight: number;
    readonly lineHeight?: number;
    readonly ligatures?: boolean;
  };
  readonly onChange: (patch: Record<string, unknown>) => void;
  readonly extended?: boolean;
  readonly hideLegend?: boolean;
  readonly focusedSetting?: string | undefined;
}) {
  const rowId = (field: string) => `appearance.typography.${props.surface}.${field}`;
  return (
    <fieldset className="settings-view__theme-group">
      <legend className={props.hideLegend ? "sr-only" : undefined}>{props.label}</legend>
      <SettingRow
        label={props.familyLabel}
        scope="app"
        settingId={rowId("family")}
        focused={props.focusedSetting === rowId("family")}
      >
        <FontFamilyPicker
          label={props.familyLabel}
          onChange={(family) => props.onChange({ family })}
          surface={props.surface}
          value={props.value.family}
        />
      </SettingRow>
      <SettingsDisclosure
        className="settings-font-picker__custom"
        title="Custom font stack"
        variant="inline"
      >
        <OctantInput
          aria-label={`${props.familyLabel} custom stack`}
          onChange={(event) => props.onChange({ family: event.currentTarget.value })}
          value={props.value.family}
        />
      </SettingsDisclosure>
      <SettingRow
        label="Font size"
        scope="app"
        settingId={rowId("size")}
        focused={props.focusedSetting === rowId("size")}
      >
        <OctantNumberStepper
          field
          label={`${props.label} font size`}
          max={32}
          min={8}
          onChange={(size) => props.onChange({ size })}
          suffix="px"
          value={props.value.size}
        />
      </SettingRow>
      {props.extended ? (
        <>
          <SettingRow
            label="Line height"
            scope="app"
            settingId={rowId("line-height")}
            focused={props.focusedSetting === rowId("line-height")}
          >
            <OctantNumberStepper
              field
              label={`${props.label} line height`}
              max={2.5}
              min={1}
              onChange={(lineHeight) => props.onChange({ lineHeight })}
              step={0.1}
              value={props.value.lineHeight ?? 1.4}
            />
          </SettingRow>
          <SettingRow
            label={`${props.label} ligatures`}
            scope="app"
            settingId={rowId("ligatures")}
            focused={props.focusedSetting === rowId("ligatures")}
          >
            <OctantSwitch
              checked={props.value.ligatures ?? false}
              label={`${props.label} ligatures`}
              onCheckedChange={(value) => props.onChange({ ligatures: value })}
            />
          </SettingRow>
        </>
      ) : null}
    </fieldset>
  );
}

const MISSING_PHOTO_NOTES = {
  "background-photo": "The theme's photo is not on this computer, so the background is plain.",
  "sidebar-photo":
    "The theme's sidebar photo is not on this computer, so the sidebar keeps its own look.",
} as const;

function ThemeTransfer(props: {
  readonly controller: ThemeController;
  readonly focused: boolean;
  readonly photoLibrary: BackgroundImageLibrary | undefined;
}) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [dropped, setDropped] = useState<ReadonlyArray<string>>([]);
  const pluginThemes = usePluginThemes();
  return (
    <div className="settings-view__theme-transfer">
      {dropped.length === 0 ? null : (
        <OctantAlert className="settings-view__error" tone="danger">
          {`The export left out ${String(dropped.length)} override this theme does not accept: ${[...new Set(dropped)].join(", ")}.`}
        </OctantAlert>
      )}
      <SettingRow
        focused={props.focused}
        label="Theme JSON"
        scope="app"
        settingId="appearance.theme-import-export"
      >
        <OctantTextarea
          aria-label="Theme JSON"
          className="textarea settings-view__textarea"
          onChange={(event) => setValue(event.currentTarget.value)}
          value={value}
        />
      </SettingRow>
      <div className="settings-view__actions">
        <OctantButton
          onClick={() => {
            setNote("");
            // The library listing the Background settings already read. When it
            // cannot be read the theme is imported as it is.
            const listed = props.photoLibrary?.list().then(
              (photos) => new Set(photos.map((photo) => String(photo.id))),
              () => undefined,
            );
            void Promise.resolve(listed).then((photoIds) => {
              const outcome = props.controller.importJson(
                value,
                photoIds === undefined ? undefined : { photoIds },
              );
              if (outcome.status === "imported" && outcome.missing.length > 0) {
                setNote(outcome.missing.map((missing) => MISSING_PHOTO_NOTES[missing]).join(" "));
              }
            });
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Import theme JSON
        </OctantButton>
        <OctantButton
          onClick={() => {
            const exported = props.controller.exportJson();
            if (exported !== undefined) setValue(exported);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Export theme JSON
        </OctantButton>
        {/* Design tokens, for a project outside Octant to consume. Both
          readings of the theme are written, and an override the theme refused
          is reported rather than exported as if it had been kept. */}
        <OctantButton
          onClick={() => {
            const exported = props.controller.exportTokens("css", pluginThemes);
            if (exported === undefined) return;
            setValue(exported.content);
            setDropped(exported.droppedOverrides.map((entry) => entry.role));
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Export design tokens (CSS)
        </OctantButton>
        <OctantButton
          onClick={() => {
            const exported = props.controller.exportTokens("json", pluginThemes);
            if (exported === undefined) return;
            setValue(exported.content);
            setDropped(exported.droppedOverrides.map((entry) => entry.role));
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Export design tokens (JSON)
        </OctantButton>
      </div>
      {/* The note's two lines are kept from the first paint, so filling it in
        after an import moves nothing below it either. */}
      <p
        aria-live="polite"
        className="settings-view__preview-note settings-theme-editor__import-note"
        role="status"
      >
        {note}
      </p>
    </div>
  );
}

import { useState, type CSSProperties, type ReactNode } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { useMediaQueryMatches } from "./useMediaQueryMatches";
import { moveWithinRadioGroup } from "../ui/base/radioGroupKeys";

/**
 * A small window drawn from a preset's own tokens (the band, the sidebar, the
 * page, one card and the accent), so a theme choice can be seen before the
 * sheet closes. System and Custom have no fixed palette of their own: they are
 * drawn from the theme the window is wearing now.
 */
function PresetSwatch(props: { readonly mode: "light" | "dark"; readonly presetId: string }) {
  const tokens = THEME_PRESETS.find((preset) => String(preset.id) === props.presetId)?.tokens[
    props.mode
  ];
  const pick = (role: string, live: string) => tokens?.[role] ?? `var(${live})`;
  const style: Record<string, string> = {
    "--swatch-band": pick("chrome", "--octant-chrome"),
    "--swatch-sidebar": pick("sidebar", "--octant-sidebar"),
    "--swatch-page": pick("workspace", "--octant-workspace"),
    "--swatch-card": pick("control", "--octant-control"),
    "--swatch-accent": pick("accent", "--oct-accent"),
    "--swatch-edge": pick("border", "--oct-border"),
  };
  return (
    <span aria-hidden="true" className="settings-preset-swatch" style={style}>
      <span className="settings-preset-swatch__band" />
      <span className="settings-preset-swatch__sidebar" />
      <span className="settings-preset-swatch__card" />
      <span className="settings-preset-swatch__accent" />
    </span>
  );
}
