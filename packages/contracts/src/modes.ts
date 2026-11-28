import { Schema } from "effect";

export const OctantMode = Schema.Literals(["chat", "work", "code"]);
export type OctantMode = typeof OctantMode.Type;

export const ProductSurfaceSettings = Schema.Struct({
  chatEnabled: Schema.Boolean,
  workEnabled: Schema.Boolean,
});
export type ProductSurfaceSettings = typeof ProductSurfaceSettings.Type;

export const DEFAULT_PRODUCT_SURFACE_SETTINGS: ProductSurfaceSettings = {
  chatEnabled: true,
  workEnabled: true,
};
