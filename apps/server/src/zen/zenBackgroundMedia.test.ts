import { describe, expect, it } from "vitest";
import {
  extractZenBackgroundStillFrame,
  inspectZenBackgroundMedia,
  sniffZenBackgroundMedia,
} from "./zenBackgroundMedia";

const PNG = hex(
  "89504e470d0a1a0a0000000d49484452000000020000000108020000007b40e8dd0000000f49444154789c63f8cfc0c0f09f010007ff01ff017f89a70000000049454e44ae426082",
);
const GIF_ANIMATED = hex(
  "4749463839610200010081000000ff00ff000000000000000021ff0b4e45545343415045322e30030100000021f904000a0000002c000000000200010000080500030008080021f904010a0002002c000000000200010081ffff000000ff00000000000008050003000808003b",
);
const WEBP_STILL = hex(
  "524946463c000000574542505650382030000000b001009d012a0200010001402625a00274010efe02ec00ce3f5a17758823fff4d23ffe9a47ffd348f98b2b49a4920000",
);
const WEBP_ANIMATED = hex(
  "52494646f400000057454250565038580a00000002000000010000000000414e494d06000000000000000000414e4d466200000000000000000001000000000064000002565038204a0000005001009d012a0200010001402625a000058c0000fee2b9c9b3ed5f2ebfffd43ffe4ed94ffe2dbf93b653ff8b6fe4ed94ffe2dbf93b653ffff4d23ffe9a47ffd348f98b7f065b6cf20000414e4d465e0000000000000000000100000000006400000056503820460000005401009d012a0200010000002625a400058c0000fef94c1ffe12fbff479ffa23dfffe8b25fcc67fb111fffa2c97f319fec447ffe8b25fcc67fb111fffa2c97f319fec0400000",
);

describe("zen background media", () => {
  it("sniffs still and animated local formats from magic bytes", () => {
    expect(sniffZenBackgroundMedia(PNG)).toBe("image/png");
    expect(inspectZenBackgroundMedia(PNG)).toMatchObject({
      mediaType: "image/png",
      width: 2,
      height: 1,
      animated: false,
    });
    expect(inspectZenBackgroundMedia(GIF_ANIMATED)).toMatchObject({
      mediaType: "image/gif",
      width: 2,
      height: 1,
      animated: true,
    });
    expect(inspectZenBackgroundMedia(WEBP_STILL)).toMatchObject({
      mediaType: "image/webp",
      animated: false,
    });
    expect(inspectZenBackgroundMedia(WEBP_ANIMATED)).toMatchObject({
      mediaType: "image/webp",
      width: 2,
      height: 1,
      animated: true,
    });
  });

  it("extracts a still first frame from animated GIF and WebP", () => {
    const gifStill = extractZenBackgroundStillFrame(GIF_ANIMATED);
    expect(gifStill.mediaType).toBe("image/gif");
    expect(inspectZenBackgroundMedia(gifStill.bytes)).toMatchObject({
      mediaType: "image/gif",
      animated: false,
    });

    const webpStill = extractZenBackgroundStillFrame(WEBP_ANIMATED);
    expect(webpStill.mediaType).toBe("image/webp");
    expect(inspectZenBackgroundMedia(webpStill.bytes)).toMatchObject({
      mediaType: "image/webp",
      animated: false,
      width: 2,
      height: 1,
    });
  });
});

function hex(value: string): Uint8Array {
  const pairs = value.match(/../g);
  if (pairs === null) return new Uint8Array();
  return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}
