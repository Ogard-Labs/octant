import type { ComponentProps } from "react";
import { OctantSlider } from "../ui/base/OctantSlider";

export type SliderFieldProps = ComponentProps<typeof OctantSlider> & {
  /** Renders the current value. Defaults to the number on its own. */
  readonly format?: (value: number) => string;
};

/**
 * A slider that says where it is.
 *
 * Six sliders in Settings had a label, a track, and a 12px thumb, and no way
 * to read the value they were on: a person could set an opacity but not know
 * whether they had set it to 40 or 60, and could not return to what they had
 * before. The readout is the same detail size as a row description, aligned to
 * the right of the track, and uses tabular figures so it does not jitter while
 * the thumb moves.
 */
export function SliderField({ format, ...slider }: SliderFieldProps) {
  const value = typeof slider.value === "number" ? slider.value : Number(slider.value ?? 0);
  return (
    <span className="settings-view__slider-field">
      <OctantSlider {...slider} />
      <span aria-hidden="true" className="settings-view__slider-value">
        {format === undefined ? String(value) : format(value)}
      </span>
    </span>
  );
}
