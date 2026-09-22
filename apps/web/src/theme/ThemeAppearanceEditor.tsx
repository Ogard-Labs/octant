import type { ThemeSettings } from "@octant/contracts/theme";
import { THEME_PRESETS } from "@octant/theme";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ThemeController } from "./useThemeController";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { SettingRow, SettingsDisclosure } from "../settings/primitives";
import { FontFamilyPicker } from "./FontFamilyPicker";
import {
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  isAppearancePresetAvailable,
  type FirstPartyPluginComponentId,
} from "../shell/contributionRegistry";

export function ThemeAppearanceEditor(props: {
  readonly controller: ThemeController;
  readonly effectivePlugins?: ReadonlyMap<FirstPartyPluginComponentId, boolean>;
}) {
  const theme = props.controller;
  const draft = theme.draft;
  const availablePresets = THEME_PRESETS.filter((preset) =>
    isAppearancePresetAvailable(preset.id, props.effectivePlugins ?? FIRST_PARTY_PLUGINS_EFFECTIVE),
  );
  if (draft === undefined) {
    return (
      <p className="settings-view__empty" role="status">
        Loading Appearance settings…
      </p>
    );
  }
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
          <p className="settings-view__error" role="alert">
            {theme.error}
          </p>
        ) : null}
      </div>
      <section
        aria-label="Theme"
        className="settings-card-section settings-card-section--open settings-theme-editor__scheme-section"
      >
        <h2>Color scheme</h2>
        <div className="setgroup">
          <div aria-label="Theme mode" className="settings-scheme" role="radiogroup">
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
                variant={draft.mode === option.value ? "secondary" : "ghost"}
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
            label={<label htmlFor="appearance-scheme-light-preset">Light preset</label>}
            scope="app"
            settingId="appearance.scheme.light-preset"
          >
            <OctantSelectField
              aria-label="Light preset"
              className="settings-view__select"
              id="appearance-scheme-light-preset"
              onValueChange={(value) => void theme.applyPatch({ lightPresetId: value as never })}
              options={availablePresets
                .filter((preset) => preset.supportedModes.includes("light"))
                .map((preset) => ({ id: preset.id, label: preset.displayName }))}
              value={draft.lightPresetId ?? "system"}
            />
          </SettingRow>
          <SettingRow
            label={<label htmlFor="appearance-scheme-dark-preset">Dark preset</label>}
            scope="app"
            settingId="appearance.scheme.dark-preset"
          >
            <OctantSelectField
              aria-label="Dark preset"
              className="settings-view__select"
              id="appearance-scheme-dark-preset"
              onValueChange={(value) => void theme.applyPatch({ darkPresetId: value as never })}
              options={availablePresets
                .filter((preset) => preset.supportedModes.includes("dark"))
                .map((preset) => ({ id: preset.id, label: preset.displayName }))}
              value={draft.darkPresetId ?? "system"}
            />
          </SettingRow>
          <SettingRow
            label={<label htmlFor="appearance-density">Density</label>}
            scope="app"
            settingId="appearance.density"
          >
            <OctantSelectField
              aria-label="Theme density"
              className="settings-view__select"
              id="appearance-density"
              onValueChange={(value) =>
                void theme.applyPatch({
                  density: value as ThemeSettings["density"],
                })
              }
              options={[
                { id: "comfortable", label: "Comfortable" },
                { id: "compact", label: "Compact" },
              ]}
              value={draft.density}
            />
          </SettingRow>
        </div>
      </section>
      {/* The interface font and its size are among the most-changed settings
          in the app, so they are not worth a click to reach. */}
      <section className="settings-card-section settings-card-section--open settings-theme-editor__disclosure">
        <h2>Typography</h2>
        <div className="setgroup settings-theme-editor__disclosure-body">
          <TypographyControl
            label="Interface typography"
            familyLabel="Interface font"
            surface="ui"
            value={draft.typography.ui}
            onChange={(patch) => setTypography("ui", patch)}
          />
          <SettingsDisclosure
            title="Code typography"
            description="Font, size, and spacing inside code editors."
          >
            <TypographyControl
              label="Code typography"
              familyLabel="Code font"
              surface="editor"
              value={draft.typography.editor}
              onChange={(patch) => setTypography("editor", patch)}
              extended
              hideLegend
            />
          </SettingsDisclosure>
          <SettingsDisclosure
            title="Terminal typography"
            description="Font, size, and spacing inside terminals."
          >
            <TypographyControl
              label="Terminal typography"
              familyLabel="Terminal font family"
              surface="terminal"
              value={draft.typography.terminal}
              onChange={(patch) => setTypography("terminal", patch)}
              extended
              hideLegend
            />
          </SettingsDisclosure>
        </div>
      </section>
      <fieldset className="settings-card-section settings-card-section--open settings-theme-editor__accessibility">
        <legend>Accessibility</legend>
        <div className="setgroup">
          <SettingRow
            label="Increased contrast"
            scope="app"
            settingId="appearance.accessibility.increased-contrast"
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
          >
            <OctantSwitch
              checked={draft.reducedTransparency}
              label="Reduced transparency"
              onCheckedChange={(value) => void theme.applyPatch({ reducedTransparency: value })}
            />
          </SettingRow>
        </div>
      </fieldset>
      <details className="settings-card-section settings-card-section--open settings-theme-editor__disclosure">
        <summary>
          <span>Import or export theme</span>
          <ChevronDown
            aria-hidden="true"
            className="settings-theme-editor__disclosure-icon"
            size={16}
          />
        </summary>
        <div className="setgroup settings-theme-editor__disclosure-body">
          <ThemeTransfer controller={theme} />
        </div>
      </details>
    </div>
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
}) {
  return (
    <fieldset className="settings-view__theme-group">
      <legend className={props.hideLegend ? "sr-only" : undefined}>{props.label}</legend>
      <SettingRow
        label={props.familyLabel}
        scope="app"
        settingId={`appearance.typography.${props.surface}.family`}
      >
        <FontFamilyPicker
          id={`appearance-typography-${props.surface}-family`}
          label={props.familyLabel}
          onChange={(family) => props.onChange({ family })}
          surface={props.surface}
          value={props.value.family}
        />
      </SettingRow>
      <details className="settings-disclosure settings-font-picker__custom">
        <summary>
          <ChevronRight aria-hidden="true" size={12} />
          Custom font stack
        </summary>
        <OctantInput
          aria-label={`${props.familyLabel} custom stack`}
          onChange={(event) => props.onChange({ family: event.currentTarget.value })}
          value={props.value.family}
        />
      </details>
      <SettingRow
        label="Font size"
        scope="app"
        settingId={`appearance.typography.${props.surface}.size`}
      >
        <OctantNumberStepper
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
            settingId={`appearance.typography.${props.surface}.line-height`}
          >
            <OctantNumberStepper
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
            settingId={`appearance.typography.${props.surface}.ligatures`}
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

function ThemeTransfer(props: { readonly controller: ThemeController }) {
  const [value, setValue] = useState("");
  const [dropped, setDropped] = useState<ReadonlyArray<string>>([]);
  return (
    <div className="settings-view__theme-transfer">
      {dropped.length === 0 ? null : (
        <p className="settings-view__error" role="alert">
          {`The export left out ${String(dropped.length)} override this theme does not accept: ${[...new Set(dropped)].join(", ")}.`}
        </p>
      )}
      <SettingRow label="Theme JSON" scope="app" settingId="appearance.theme-import-export">
        <OctantTextarea
          aria-label="Theme JSON"
          className="textarea settings-view__textarea"
          onChange={(event) => setValue(event.currentTarget.value)}
          value={value}
        />
      </SettingRow>
      <div className="settings-view__actions">
        <OctantButton
          onClick={() => props.controller.importJson(value)}
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
            const exported = props.controller.exportTokens("css");
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
            const exported = props.controller.exportTokens("json");
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
    </div>
  );
}

import { useState } from "react";
