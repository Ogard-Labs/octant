import { Schema } from "effect";

/** Stable ids for the first-party image catalog shared by Zen and the app ground. */
export const ZEN_BUILTIN_BACKGROUND_IDS = [
  "nordic-fjord-aurora",
  "lofoten-night",
  "aurora-crimson-ridge",
  "rain-black-valley",
  "spruce-wall-dusk",
  "weathered-ash-planks",
  "near-black-oak-planks",
  "warm-walnut-planks",
  "perspective-dot-plane",
  "perspective-dot-plane-light",
  "waving-dot-field",
  "waving-dot-field-light",
  "curling-dash-wave",
  "curling-dash-wave-light",
  "perspective-dot-plane-animated",
  "perspective-dot-plane-light-animated",
  "waving-dot-field-animated",
  "waving-dot-field-light-animated",
  "curling-dash-wave-animated",
  "curling-dash-wave-light-animated",
] as const;

export type ZenBuiltinBackgroundId = (typeof ZEN_BUILTIN_BACKGROUND_IDS)[number];

export const ZenBuiltinBackgroundId = Schema.Literal(...ZEN_BUILTIN_BACKGROUND_IDS);
