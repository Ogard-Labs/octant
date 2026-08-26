import { useMemo, useState } from "react";
import type {
  ZenAppearance,
  ZenBackground,
  ZenBackgroundFill,
  ZenGradientStyle,
} from "@octant/contracts/zen";
import { ZEN_BUILTIN_BACKGROUNDS } from "@octant/contracts/zen";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSlider } from "../ui/base/OctantSlider";

export interface ZenAppearancePanelProps {
  readonly appearance: ZenAppearance;
  readonly onUpdateAppearance?: (
    patch: Partial<ZenAppearance> & Pick<ZenAppearance, "dimming" | "elementOpacity">,
  ) => void;
  readonly onUploadBackground?: (file: File) => void;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function ZenAppearancePanel(props: ZenAppearancePanelProps) {
  const background = props.appearance.background;
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
  const [fill, setFill] = useState<ZenBackgroundFill>(
    background.kind === "image" || background.kind === "builtin"
      ? (background.fill ?? "cover")
      : "cover",
  );
  const [overlay, setOverlay] = useState(
    background.kind === "image" || background.kind === "builtin" ? background.overlay : 35,
  );

  const groups = useMemo(() => {
    return {
      landscape: ZEN_BUILTIN_BACKGROUNDS.filter((preset) => preset.group === "landscape"),
      forest: ZEN_BUILTIN_BACKGROUNDS.filter((preset) => preset.group === "forest"),
      wood: ZEN_BUILTIN_BACKGROUNDS.filter((preset) => preset.group === "wood"),
      abstract: ZEN_BUILTIN_BACKGROUNDS.filter((preset) => preset.group === "abstract"),
    };
  }, []);

  function commit(next: ZenBackground): void {
    props.onUpdateAppearance?.({
      dimming: props.appearance.dimming,
      elementOpacity: props.appearance.elementOpacity,
      background: next,
    });
  }

  return (
    <>
      <label>
        Background opacity
        <OctantSlider
          aria-label="Zen dimming"
          max="90"
          min="0"
          onChange={(event) =>
            props.onUpdateAppearance?.({
              dimming: Number(event.currentTarget.value),
              elementOpacity: props.appearance.elementOpacity,
            })
          }
          value={props.appearance.dimming}
        />
      </label>
      <label>
        Card opacity
        <OctantSlider
          aria-label="Zen element opacity"
          max="1"
          min="0.1"
          onChange={(event) =>
            props.onUpdateAppearance?.({
              dimming: props.appearance.dimming,
              elementOpacity: Number(event.currentTarget.value),
            })
          }
          step="0.1"
          value={props.appearance.elementOpacity}
        />
      </label>
      {background.kind === "image" || background.kind === "builtin" ? (
        <>
          <label>
            Image overlay
            <OctantSlider
              aria-label="Zen image overlay"
              max="90"
              min="0"
              onChange={(event) => {
                const nextOverlay = Number(event.currentTarget.value);
                setOverlay(nextOverlay);
                commit({ ...background, overlay: nextOverlay });
              }}
              value={overlay}
            />
          </label>
          <label>
            Image fill
            <OctantSelectField
              aria-label="Zen image fill"
              onValueChange={(value) => {
                const nextFill = value as ZenBackgroundFill;
                setFill(nextFill);
                commit({ ...background, fill: nextFill });
              }}
              options={[
                { id: "cover", label: "Fill" },
                { id: "contain", label: "Fit" },
                { id: "tile", label: "Tile" },
              ]}
              value={fill}
            />
          </label>
        </>
      ) : null}

      <fieldset className="zen-appearance__presets">
        <legend>Built-in backgrounds</legend>
        {(["landscape", "forest", "wood", "abstract"] as const).map((group) => (
          <div className="zen-appearance__group" key={group}>
            <h3>{group}</h3>
            <div className="zen-appearance__preset-grid">
              {groups[group].map((preset) => (
                <OctantButton
                  aria-pressed={background.kind === "builtin" && background.presetId === preset.id}
                  key={preset.id}
                  onClick={() => {
                    commit({
                      kind: "builtin",
                      presetId: preset.id,
                      overlay,
                      fill,
                    });
                  }}
                  type="button"
                  variant="secondary"
                >
                  {preset.motion === "animated" ? `${preset.title} (animated)` : preset.title}
                </OctantButton>
              ))}
            </div>
          </div>
        ))}
      </fieldset>

      <fieldset>
        <legend>Custom fill</legend>
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
      </fieldset>

      <label>
        Local Zen background
        {/* ui-boundary-exception: native-file-input */}
        <input
          accept="image/png,image/jpeg,image/webp,image/gif"
          aria-label="Upload local Zen background"
          disabled={props.onUploadBackground === undefined}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file !== undefined) props.onUploadBackground?.(file);
            event.currentTarget.value = "";
          }}
          type="file"
        />
      </label>
    </>
  );
}
