import type { ThemeSettings } from "@octant/contracts/theme";
import { THEME_PRESETS } from "@octant/theme";
import { ChevronDown } from "lucide-react";
import type { ThemeController } from "./useThemeController";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTextarea } from "../ui/base/OctantTextarea";
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
  const setOverride = (role: string, color: string) => {
    const rest = draft.semanticOverrides.filter((entry) => entry.role !== role);
    void theme.applyPatch({
      semanticOverrides: [...rest, { role: role as never, color: color as never }],
    });
  };
  return (
    <div className="settings-theme-editor" aria-label="Appearance preview controls">
      {theme.error !== undefined ? (
        <p className="settings-view__error" role="alert">
          {theme.error}
        </p>
      ) : null}
      <section aria-label="Theme" className="settings-card-section">
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
                variant="ghost"
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
                      <span className="settings-scheme__preview-dot" />
                    </span>
                  </span>
                  <span className="settings-scheme__preview-pane settings-scheme__preview-pane--dark">
                    <span className="settings-scheme__preview-sidebar" />
                    <span className="settings-scheme__preview-content">
                      <span />
                      <span />
                      <span className="settings-scheme__preview-dot" />
                    </span>
                  </span>
                </span>
                <span className="settings-scheme__label">{option.label}</span>
              </OctantButton>
            ))}
          </div>
          <label className="settings-view__field">
            <span>Light preset</span>
            <OctantNativeSelect
              aria-label="Light preset"
              className="settings-view__select"
              onChange={(event) =>
                void theme.applyPatch({ lightPresetId: event.currentTarget.value as never })
              }
              value={draft.lightPresetId ?? "system"}
            >
              {availablePresets
                .filter((preset) => preset.supportedModes.includes("light"))
                .map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.displayName}
                  </option>
                ))}
            </OctantNativeSelect>
          </label>
          <label className="settings-view__field">
            <span>Dark preset</span>
            <OctantNativeSelect
              aria-label="Dark preset"
              className="settings-view__select"
              onChange={(event) =>
                void theme.applyPatch({ darkPresetId: event.currentTarget.value as never })
              }
              value={draft.darkPresetId ?? "system"}
            >
              {availablePresets
                .filter((preset) => preset.supportedModes.includes("dark"))
                .map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.displayName}
                  </option>
                ))}
            </OctantNativeSelect>
          </label>
          <label className="settings-view__field">
            <span>Density</span>
            <OctantNativeSelect
              aria-label="Theme density"
              className="settings-view__select"
              onChange={(event) =>
                void theme.applyPatch({
                  density: event.currentTarget.value as ThemeSettings["density"],
                })
              }
              value={draft.density}
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </OctantNativeSelect>
          </label>
        </div>
      </section>
      <details className="settings-card-section settings-theme-editor__disclosure" open>
        <summary>
          <span>Typography</span>
          <ChevronDown
            aria-hidden="true"
            className="settings-theme-editor__disclosure-icon"
            size={15}
          />
        </summary>
        <div className="setgroup settings-theme-editor__disclosure-body">
          <TypographyControl
            label="Interface typography"
            familyLabel="Interface font"
            surface="ui"
            value={draft.typography.ui}
            onChange={(patch) => setTypography("ui", patch)}
          />
          <TypographyControl
            label="Code typography"
            familyLabel="Code font"
            surface="editor"
            value={draft.typography.editor}
            onChange={(patch) => setTypography("editor", patch)}
            extended
          />
          <TypographyControl
            label="Terminal typography"
            familyLabel="Terminal font family"
            surface="terminal"
            value={draft.typography.terminal}
            onChange={(patch) => setTypography("terminal", patch)}
            extended
          />
        </div>
      </details>
      <fieldset className="settings-card-section settings-theme-editor__accessibility">
        <legend>Accessibility</legend>
        <div className="setgroup">
          <SettingSwitch
            label="Increased contrast"
            checked={draft.increasedContrast}
            onChange={(value) => void theme.applyPatch({ increasedContrast: value })}
          />
          <SettingSwitch
            label="Reduced motion"
            checked={draft.reducedMotion}
            onChange={(value) => void theme.applyPatch({ reducedMotion: value })}
          />
          <SettingSwitch
            label="Reduced transparency"
            checked={draft.reducedTransparency}
            onChange={(value) => void theme.applyPatch({ reducedTransparency: value })}
          />
          <label className="settings-view__field">
            <span>Focus ring color</span>
            <OctantInput
              aria-label="Focus ring color"
              className="settings-view__text-input"
              type="color"
              value={
                draft.semanticOverrides.find((entry) => entry.role === "focus-ring")?.color ??
                "#d8d8d4"
              }
              onChange={(event) => setOverride("focus-ring", event.currentTarget.value)}
            />
          </label>
        </div>
      </fieldset>
      <details className="settings-card-section settings-theme-editor__disclosure">
        <summary>
          <span>Import or export theme</span>
          <ChevronDown
            aria-hidden="true"
            className="settings-theme-editor__disclosure-icon"
            size={15}
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
}) {
  return (
    <fieldset className="settings-view__theme-group">
      <legend>{props.label}</legend>
      <label className="settings-view__field">
        <span>{props.familyLabel}</span>
        <FontFamilyPicker
          label={props.familyLabel}
          onChange={(family) => props.onChange({ family })}
          surface={props.surface}
          value={props.value.family}
        />
      </label>
      <details className="settings-font-picker__custom">
        <summary>Custom font stack</summary>
        <OctantInput
          aria-label={`${props.familyLabel} custom stack`}
          onChange={(event) => props.onChange({ family: event.currentTarget.value })}
          value={props.value.family}
        />
      </details>
      <label className="settings-view__field">
        <span>Font size</span>
        <OctantNumberStepper
          label={`${props.label} font size`}
          max={32}
          min={8}
          onChange={(size) => props.onChange({ size })}
          suffix="px"
          value={props.value.size}
        />
      </label>
      {props.extended ? (
        <>
          <label className="settings-view__field">
            <span>Line height</span>
            <OctantNumberStepper
              label={`${props.label} line height`}
              max={2.5}
              min={1}
              onChange={(lineHeight) => props.onChange({ lineHeight })}
              step={0.1}
              value={props.value.lineHeight ?? 1.4}
            />
          </label>
          <SettingSwitch
            label={`${props.label} ligatures`}
            checked={props.value.ligatures ?? false}
            onChange={(value) => props.onChange({ ligatures: value })}
          />
        </>
      ) : null}
    </fieldset>
  );
}

function SettingSwitch(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <div className="settings-view__field">
      <span>{props.label}</span>
      <OctantSwitch checked={props.checked} label={props.label} onCheckedChange={props.onChange} />
    </div>
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
      <label className="settings-view__field">
        <span>Theme JSON</span>
        <OctantTextarea
          aria-label="Theme JSON"
          className="textarea settings-view__textarea"
          onChange={(event) => setValue(event.currentTarget.value)}
          value={value}
        />
      </label>
      <div className="settings-view__actions">
        <OctantButton
          onClick={() => props.controller.importJson(value)}
          type="button"
          variant="secondary"
        >
          Import theme JSON
        </OctantButton>
        <OctantButton
          onClick={() => {
            const exported = props.controller.exportJson();
            if (exported !== undefined) setValue(exported);
          }}
          type="button"
          variant="secondary"
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
          type="button"
          variant="secondary"
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
          type="button"
          variant="secondary"
        >
          Export design tokens (JSON)
        </OctantButton>
        <OctantButton onClick={props.controller.reset} type="button" variant="secondary">
          Reset appearance
        </OctantButton>
      </div>
    </div>
  );
}

import { useState } from "react";
