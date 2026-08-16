import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_SURFACE_SETTINGS, ProductSurfaceSettings } from "./modes";

describe("ProductSurfaceSettings", () => {
  it("decodes optional Chat and Work surfaces while Code remains implicit", () => {
    expect(
      Schema.decodeUnknownSync(ProductSurfaceSettings)({ chatEnabled: false, workEnabled: true }),
    ).toEqual({
      chatEnabled: false,
      workEnabled: true,
    });
    expect(DEFAULT_PRODUCT_SURFACE_SETTINGS).toEqual({ chatEnabled: true, workEnabled: true });
  });

  it("rejects an attempt to encode Code as disableable", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProductSurfaceSettings)({
        chatEnabled: true,
        workEnabled: true,
        codeEnabled: false,
      }),
    ).toThrow();
  });
});
