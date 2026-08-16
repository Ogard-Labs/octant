import type { ThemeSettings } from "@octant/contracts/theme";
import { THEME_PRESETS } from "@octant/theme";
import { ChevronDown } from "lucide-react";
import type { ThemeController } from "./useThemeController";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantSlider } from "../ui/base/OctantSlider";

export function ThemeAppearanceEditor(props: { readonly controller: ThemeController }) {
  const theme = props.controller;
  const draft = theme.draft;
  if (draft === undefined) {
    return (
      <p className="settings-view__empty" role="status">
        Loading Appearance settings…
      </p>
    );
  }
  const setTypography = (surface: "ui" | "editor" | "terminal", patch: Record<string, unknown>) => {
    theme.updateDraft({
      typography: {
        ...draft.typography,
        [surface]: { ...draft.typography[surface], ...patch },
      } as ThemeSettings["typography"],
    });
  };
  const setOverride = (role: string, color: string) => {
    const rest = draft.semanticOverrides.filter((entry) => entry.role !== role);
    theme.updateDraft({
      semanticOverrides: [...rest, { role: role as never, color: color as never }],
    });
  };
  return (
    <div className="settings-theme-editor" aria-label="Appearance preview controls">
      {theme.hasDraftChanges ? (
        <div className="settings-theme-editor__draft-bar">
          <p className="settings-view__preview-note" role="status">
            Previewing unsaved changes. Apply saves them to this app.
          </p>
          <div className="settings-view__actions">
            <OctantButton
              disabled={theme.status === "loading"}
              onClick={() => void theme.apply()}
              type="button"
            >
              Apply
            </OctantButton>
            <OctantButton onClick={theme.cancel} type="button" variant="secondary">
              Cancel
            </OctantButton>
            <OctantButton onClick={theme.reset} type="button" variant="secondary">
              Reset
            </OctantButton>
          </div>
        </div>
      ) : null}
      {theme.error !== undefined ? (
        <p className="settings-view__error" role="alert">
          {theme.error}
        </p>
      ) : null}
      <section aria-label="Theme" className="settings-theme-editor__card">
        <h3>Color scheme</h3>
        <div aria-label="Theme mode" className="settings-scheme" role="radiogroup">
          {(
            [
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ] as const
          ).map((option) => (
            <button
              aria-checked={draft.mode === option.value}
              className="settings-scheme__card window-no-drag"
              key={option.value}
              onClick={() => theme.updateDraft({ mode: option.value })}
              role="radio"
              type="button"
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
            </button>
          ))}
        </div>
        <label className="settings-view__field">
          <span>Light preset</span>
          <OctantNativeSelect
            aria-label="Light preset"
            className="settings-view__select"
            onChange={(event) =>
              theme.updateDraft({ lightPresetId: event.currentTarget.value as never })
            }
            value={draft.lightPresetId ?? "system"}
          >
            {THEME_PRESETS.filter((preset) => preset.supportedModes.includes("light")).map(
              (preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.displayName}
                </option>
              ),
            )}
          </OctantNativeSelect>
        </label>
        <label className="settings-view__field">
          <span>Dark preset</span>
          <OctantNativeSelect
            aria-label="Dark preset"
            className="settings-view__select"
            onChange={(event) =>
              theme.updateDraft({ darkPresetId: event.currentTarget.value as never })
            }
            value={draft.darkPresetId ?? "system"}
          >
            {THEME_PRESETS.filter((preset) => preset.supportedModes.includes("dark")).map(
              (preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.displayName}
                </option>
              ),
            )}
          </OctantNativeSelect>
        </label>
        <label className="settings-view__field">
          <span>Density</span>
          <OctantNativeSelect
            aria-label="Theme density"
            className="settings-view__select"
            onChange={(event) =>
              theme.updateDraft({ density: event.currentTarget.value as ThemeSettings["density"] })
            }
            value={draft.density}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </OctantNativeSelect>
        </label>
      </section>
      <details className="settings-theme-editor__disclosure">
        <summary>
          <span>Typography</span>
          <ChevronDown
            aria-hidden="true"
            className="settings-theme-editor__disclosure-icon"
            size={15}
          />
        </summary>
        <div className="settings-theme-editor__disclosure-body">
          <TypographyControl
            label="UI typography"
            familyLabel="UI font family"
            value={draft.typography.ui}
            onChange={(patch) => setTypography("ui", patch)}
          />
          <TypographyControl
            label="Editor typography"
            familyLabel="Editor font family"
            value={draft.typography.editor}
            onChange={(patch) => setTypography("editor", patch)}
            extended
          />
          <TypographyControl
            label="Terminal typography"
            familyLabel="Terminal font family"
            value={draft.typography.terminal}
            onChange={(patch) => setTypography("terminal", patch)}
            extended
          />
        </div>
      </details>
      <fieldset className="settings-theme-editor__card settings-theme-editor__accessibility">
        <legend>Accessibility</legend>
        <SettingSwitch
          label="Increased contrast"
          checked={draft.increasedContrast}
          onChange={(value) => theme.updateDraft({ increasedContrast: value })}
        />
        <SettingSwitch
          label="Reduced motion"
          checked={draft.reducedMotion}
          onChange={(value) => theme.updateDraft({ reducedMotion: value })}
        />
        <SettingSwitch
          label="Reduced transparency"
          checked={draft.reducedTransparency}
          onChange={(value) => theme.updateDraft({ reducedTransparency: value })}
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
      </fieldset>
      <details className="settings-theme-editor__disclosure">
        <summary>
          <span>Import or export theme</span>
          <ChevronDown
            aria-hidden="true"
            className="settings-theme-editor__disclosure-icon"
            size={15}
          />
        </summary>
        <div className="settings-theme-editor__disclosure-body">
          <ThemeTransfer controller={theme} />
        </div>
      </details>
    </div>
  );
}

function TypographyControl(props: {
  readonly label: string;
  readonly familyLabel: string;
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
        <OctantInput
          aria-label={props.familyLabel}
          className="settings-view__text-input"
          onChange={(event) => props.onChange({ family: event.currentTarget.value })}
          value={props.value.family}
        />
      </label>
      <label className="settings-view__field">
        <span>Font size</span>
        <OctantSlider
          aria-label={`${props.label} font size`}
          className="settings-view__range"
          min={8}
          max={32}
          onChange={(event) => props.onChange({ size: Number(event.currentTarget.value) })}
          value={props.value.size}
        />
      </label>
      {props.extended ? (
        <>
          <label className="settings-view__field">
            <span>Line height</span>
            <OctantSlider
              aria-label={`${props.label} line height`}
              className="settings-view__range"
              min={1}
              max={2.5}
              step={0.1}
              onChange={(event) =>
                props.onChange({ lineHeight: Number(event.currentTarget.value) })
              }
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
  return (
    <div className="settings-view__theme-transfer">
      <label className="settings-view__field">
        <span>Theme JSON</span>
        <textarea
          aria-label="Theme JSON"
          className="settings-view__textarea"
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
        <OctantButton onClick={props.controller.reset} type="button" variant="secondary">
          Reset appearance
        </OctantButton>
      </div>
    </div>
  );
}

import { useState } from "react";
