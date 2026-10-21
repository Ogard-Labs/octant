import { Schema } from "effect";

// A brand is a handful of named values (a palette, two font stacks, a radius,
// a spacing step), not a stylesheet.
export const CANVAS_MAX_DESIGN_BRAND_TOKENS = 32;
export const CANVAS_MAX_DESIGN_BRAND_VALUE_LENGTH = 128;

/**
 * A design's own brand: named values a frame reads when `theme` is `brand`.
 * A name is a kind and a slug (`color-primary`, `font-heading`, `radius-card`,
 * `space-gutter`). Colours, font families, and lengths are checked by the
 * domain policy against the frame token safety rules, so a value can never end
 * a declaration or load anything. A Project's brand kit has the same shape, so
 * one rule validates both. It lives apart from the Canvas contract because a
 * Project record holds a kit and the Canvas contract already names Projects.
 */
export const CANVAS_DESIGN_BRAND_TOKEN_KINDS = ["color", "font", "radius", "space"] as const;
export type CanvasDesignBrandTokenKind = (typeof CANVAS_DESIGN_BRAND_TOKEN_KINDS)[number];
export const CanvasDesignBrandTokenName = Schema.String.pipe(
  Schema.pattern(/^(?:color|font|radius|space)-[a-z0-9][a-z0-9-]{0,31}$/),
);
export const CanvasDesignBrand = Schema.Record({
  key: CanvasDesignBrandTokenName,
  value: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(CANVAS_MAX_DESIGN_BRAND_VALUE_LENGTH)),
}).pipe(
  Schema.filter((brand) => Object.keys(brand).length <= CANVAS_MAX_DESIGN_BRAND_TOKENS, {
    message: () => `A brand holds at most ${String(CANVAS_MAX_DESIGN_BRAND_TOKENS)} tokens.`,
  }),
);
export type CanvasDesignBrand = typeof CanvasDesignBrand.Type;
