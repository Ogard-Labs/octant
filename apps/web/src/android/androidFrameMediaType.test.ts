import { describe, expect, it } from "vitest";
import { androidFrameMediaType } from "./androidFrameMediaType";

describe("android live frames", () => {
  it("treats a JPEG frame as JPEG and a PNG frame as PNG", () => {
    expect(androidFrameMediaType(Uint8Array.of(0xff, 0xd8, 0xff))).toBe("image/jpeg");
    expect(androidFrameMediaType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBe("image/png");
  });
});
