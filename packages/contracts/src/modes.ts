import { Schema } from "effect";

export const OctantMode = Schema.Literal("chat", "work", "code");
export type OctantMode = typeof OctantMode.Type;

export const ProductSurfaceSettings = Schema.Struct({
  chatEnabled: Schema.Boolean,
  workEnabled: Schema.Boolean,
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type ProductSurfaceSettings = typeof ProductSurfaceSettings.Type;

export const DEFAULT_PRODUCT_SURFACE_SETTINGS: ProductSurfaceSettings = {
  chatEnabled: true,
  workEnabled: true,
};
