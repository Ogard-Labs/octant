import { useMemo, useState, type ReactNode } from "react";
import type {
  ZenAppearance,
  ZenBackground,
  ZenBackgroundFill,
  ZenGradientStyle,
  ZenGroundEffect,
} from "@octant/contracts/zen";
import { DEFAULT_ZEN_GROUND_EFFECT, ZEN_BUILTIN_BACKGROUNDS } from "@octant/contracts/zen";
import { ImagePlus, Monitor } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSlider } from "../ui/base/OctantSlider";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

export interface ZenAppearancePanelProps {
  readonly appearance: ZenAppearance;
  readonly onUpdateAppearance?: (
    patch: Partial<ZenAppearance> & Pick<ZenAppearance, "dimming" | "elementOpacity">,
  ) => void;
  readonly onUploadBackground?: (file: File) => void;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const EFFECTS = [
  { id: "none", label: "Off" },
  { id: "pixelate", label: "Pixelate" },
  { id: "dither", label: "Dither" },
] as const satisfies ReadonlyArray<{ id: ZenGroundEffect["kind"]; label: string }>;

const FILLS = [
  { id: "cover", label: "Fill" },
  { id: "contain", label: "Fit" },
  { id: "tile", label: "Tile" },
] as const satisfies ReadonlyArray<{ id: ZenBackgroundFill; label: string }>;

const GROUPS = ["landscape", "forest", "wood", "abstract"] as const;

/**
 * The badge under a tile is the one place a background says it moves, so a
 * title that already ends in "animated" drops it rather than saying it twice
 * ("Perspective dots animated" beside a badge reading Animated).
 */
function presetName(title: string): string {
  return title.replace(/\s+animated$/i, "");
}

function isPicture(
  background: ZenBackground,
): background is Extract<ZenBackground, { kind: "image" | "builtin" }> {
  return background.kind === "image" || background.kind === "builtin";
}

export function ZenAppearancePanel(props: ZenAppearancePanelProps) {
  const background = props.appearance.background;
  const picture = isPicture(background);
  const effect = props.appearance.groundEffect ?? DEFAULT_ZEN_GROUND_EFFECT;
  // Dimming and a picture's own overlay both darken the ground and the
  // surface draws whichever is stronger. Two sliders for one result read as
  // a bug, so the panel shows one and writes both.
  const dim = Math.max(props.appearance.dimming, picture ? background.overlay : 0);
  const fill: ZenBackgroundFill = picture ? (background.fill ?? "cover") : "cover";

  const [solidColor, setSolidColor] = useState(
    background.kind === "solid" ? background.color : "#1a1a2e",
  );
  const [gradientFrom, setGradientFrom] = useState(
    background.kind === "gradient" ? background.from : "#1a1a2e",
  );
  const [gradientTo, setGradientTo] = useState(
    background.kind === "gradient" ? background.to : "#16213e",
  );
  const [gradientStyle, setGradientStyle] = useState<ZenGradientStyle>(
    background.kind === "gradient" ? (background.style ?? "linear") : "linear",
  );
  const [gradientAngle, setGradientAngle] = useState(
    background.kind === "gradient" ? background.angle : 180,
  );

  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        group,
        presets: ZEN_BUILTIN_BACKGROUNDS.filter((preset) => preset.group === group),
      })),
    [],
  );

  function update(patch: Partial<ZenAppearance>): void {
    props.onUpdateAppearance?.({
      dimming: props.appearance.dimming,
      elementOpacity: props.appearance.elementOpacity,
      ...patch,
    });
  }

  function commit(next: ZenBackground): void {
    update({ background: next });
  }

  function updateEffect(patch: Partial<ZenGroundEffect>): void {
    update({ groundEffect: { ...effect, ...patch } });
  }

  const effectNote =
    background.kind === "theme"
      ? "The app background has its own dither in Settings › Appearance › Background."
      : picture
        ? null
        : "Effects print pictures. Choose one below.";

  return (
    <div className="zen-appearance">
      <Section title="Look">
        <SliderRow
          label="Dim"
          readout={`${String(dim)}%`}
          slider={
            <OctantSlider
              aria-label="Zen dimming"
              max="90"
              min="0"
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                update({
                  dimming: next,
                  ...(picture ? { background: { ...background, overlay: next } } : {}),
                });
              }}
              value={dim}
            />
          }
        />
        <SliderRow
          label="Windows"
          readout={`${String(Math.round(props.appearance.elementOpacity * 100))}%`}
          slider={
            <OctantSlider
              aria-label="Zen element opacity"
              max="1"
              min="0.1"
              onChange={(event) => update({ elementOpacity: Number(event.currentTarget.value) })}
              step="0.05"
              value={props.appearance.elementOpacity}
            />
          }
        />
        {picture ? (
          <div className="zen-appearance__row">
            <span className="zen-appearance__label">Picture</span>
            <OctantToggleGroup<ZenBackgroundFill>
              aria-label="Zen image fill"
              className="zen-appearance__segments"
              onValueChange={(value) => {
                const next = value[0];
                if (next !== undefined) commit({ ...background, fill: next });
              }}
              value={[fill]}
            >
              {FILLS.map((option) => (
                <OctantToggleGroupItem key={option.id} value={option.id}>
                  {option.label}
                </OctantToggleGroupItem>
              ))}
            </OctantToggleGroup>
          </div>
        ) : null}
      </Section>

      <Section title="Effect">
        <OctantToggleGroup<ZenGroundEffect["kind"]>
          aria-label="Zen ground effect"
          className="zen-appearance__segments zen-appearance__segments--wide"
          disabled={!picture}
          onValueChange={(value) => {
            const next = value[0];
            if (next !== undefined) updateEffect({ kind: next });
          }}
          value={[picture ? effect.kind : "none"]}
        >
          {EFFECTS.map((option) => (
            <OctantToggleGroupItem key={option.id} value={option.id}>
              {option.label}
            </OctantToggleGroupItem>
          ))}
        </OctantToggleGroup>
        {effectNote === null ? null : <p className="zen-appearance__note">{effectNote}</p>}
        {picture && effect.kind !== "none" ? (
          <>
            <SliderRow
              label="Pixel size"
              readout={`${String(effect.cell)} px`}
              slider={
                <OctantSlider
                  aria-label="Zen effect pixel size"
                  max="16"
                  min="2"
                  onChange={(event) => updateEffect({ cell: Number(event.currentTarget.value) })}
                  value={effect.cell}
                />
              }
            />
            {effect.kind === "dither" ? (
              <SliderRow
                label="Tones"
                readout={String(effect.levels)}
                slider={
                  <OctantSlider
                    aria-label="Zen effect tones"
                    max="16"
                    min="2"
                    onChange={(event) =>
                      updateEffect({ levels: Number(event.currentTarget.value) })
                    }
                    value={effect.levels}
                  />
                }
              />
            ) : null}
          </>
        ) : null}
      </Section>

      <Section title="Background">
        <div className="zen-appearance__preset-grid">
          {/* Not a picture: it is the ground the rest of Octant already
              stands on, with the dials set in Settings. */}
          <OctantButton
            aria-label="App background"
            aria-pressed={background.kind === "theme"}
            className="zen-appearance__preset"
            onClick={() => commit({ kind: "theme" })}
            type="button"
            variant="ghost"
          >
            <span aria-hidden="true" className="zen-appearance__thumb zen-appearance__thumb--app">
              <Monitor size={16} />
            </span>
            <span className="zen-appearance__preset-name">App background</span>
          </OctantButton>
          <label
            className="zen-appearance__preset zen-appearance__upload"
            data-selected={background.kind === "image" ? "true" : "false"}
          >
            <span
              aria-hidden="true"
              className="zen-appearance__thumb zen-appearance__thumb--upload"
            >
              <ImagePlus size={16} />
            </span>
            <span className="zen-appearance__preset-name">Your picture</span>
            {/* ui-boundary-exception: native-file-input */}
            <input
              accept="image/png,image/jpeg,image/webp,image/gif"
              aria-label="Upload local Zen background"
              className="zen-appearance__file"
              disabled={props.onUploadBackground === undefined}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file !== undefined) props.onUploadBackground?.(file);
                event.currentTarget.value = "";
              }}
              type="file"
            />
          </label>
        </div>
        {groups.map(({ group, presets }) => (
          <div className="zen-appearance__group" key={group}>
            <h4>{group}</h4>
            <div className="zen-appearance__preset-grid">
              {presets.map((preset) => (
                <OctantButton
                  /* The tile's two visible texts are separate elements, so the
                     computed name ran them together ("Perspective dotsAnimated").
                     The preset's own title already reads as a sentence and
                     already says when it moves, so it is the label. */
                  aria-label={preset.title}
                  aria-pressed={background.kind === "builtin" && background.presetId === preset.id}
                  className="zen-appearance__preset"
                  key={preset.id}
                  onClick={() => {
                    commit({ kind: "builtin", presetId: preset.id, overlay: dim, fill });
                  }}
                  type="button"
                  variant="ghost"
                >
                  {/* An animated preset is a moving WebP. The picker shows its
                      still frame instead, so choosing a background does not set
                      eight of them playing at once behind the sheet. */}
                  <img
                    alt=""
                    className="zen-appearance__thumb"
                    loading="lazy"
                    src={"stillSrc" in preset ? preset.stillSrc : preset.src}
                  />
                  <span className="zen-appearance__preset-name">{presetName(preset.title)}</span>
                  {preset.motion === "animated" ? (
                    <span className="zen-appearance__preset-motion">Animated</span>
                  ) : null}
                </OctantButton>
              ))}
            </div>
          </div>
        ))}

        {/* Controls that only matter to someone mixing their own colour.
            Open they doubled the sheet's height and pushed the built-in
            pictures off the bottom of it. */}
        <details className="zen-appearance__custom">
          <summary>Custom fill</summary>
          <label>
            Solid color
            <OctantInput
              aria-label="Solid color"
              onChange={(event) => setSolidColor(event.currentTarget.value)}
              type="color"
              value={HEX.test(solidColor) ? solidColor : "#1a1a2e"}
            />
          </label>
          <OctantButton
            onClick={() => {
              if (!HEX.test(solidColor)) return;
              commit({ kind: "solid", color: solidColor });
            }}
            type="button"
            variant="secondary"
          >
            Apply solid color
          </OctantButton>
          <label>
            Gradient style
            <OctantSelectField
              aria-label="Gradient style"
              onValueChange={(value) => setGradientStyle(value as ZenGradientStyle)}
              options={[
                { id: "linear", label: "Linear" },
                { id: "radial", label: "Radial" },
                { id: "conic", label: "Conic" },
              ]}
              value={gradientStyle}
            />
          </label>
          <label>
            Gradient start
            <OctantInput
              aria-label="Gradient start"
              onChange={(event) => setGradientFrom(event.currentTarget.value)}
              type="color"
              value={HEX.test(gradientFrom) ? gradientFrom : "#1a1a2e"}
            />
          </label>
          <label>
            Gradient end
            <OctantInput
              aria-label="Gradient end"
              onChange={(event) => setGradientTo(event.currentTarget.value)}
              type="color"
              value={HEX.test(gradientTo) ? gradientTo : "#16213e"}
            />
          </label>
          <label>
            Gradient angle
            <OctantSlider
              aria-label="Gradient angle"
              max="360"
              min="0"
              onChange={(event) => setGradientAngle(Number(event.currentTarget.value))}
              value={gradientAngle}
            />
          </label>
          <OctantButton
            onClick={() => {
              if (!HEX.test(gradientFrom) || !HEX.test(gradientTo)) return;
              commit({
                kind: "gradient",
                style: gradientStyle,
                from: gradientFrom,
                to: gradientTo,
                angle: gradientAngle,
              });
            }}
            type="button"
            variant="secondary"
          >
            Apply custom gradient
          </OctantButton>
        </details>
      </Section>
    </div>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="zen-appearance__section">
      <h3 className="zen-appearance__heading">{props.title}</h3>
      {props.children}
    </section>
  );
}

function SliderRow(props: {
  readonly label: string;
  readonly readout: string;
  readonly slider: ReactNode;
}) {
  return (
    <div className="zen-appearance__slider">
      <span className="zen-appearance__label">{props.label}</span>
      <span className="zen-appearance__readout">{props.readout}</span>
      {props.slider}
    </div>
  );
}
