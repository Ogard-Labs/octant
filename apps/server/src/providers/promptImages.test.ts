import { describe, expect, it } from "vitest";
import { attachedImagesSupport, promptImagesOf, sendsEveryAttachment } from "./promptImages";

describe("images a direct endpoint sends", () => {
  it("claims attachments only when one of the endpoint's models reads images", () => {
    expect(attachedImagesSupport([{ inputModalities: ["text"] }])).toBe("unsupported");
    expect(
      attachedImagesSupport([{ inputModalities: ["text"] }, { inputModalities: ["text", "image"] }]),
    ).toBe("supported");
  });

  it("sends images only, and refuses a turn carrying anything it would drop", () => {
    expect(
      promptImagesOf([
        { mediaType: "image/webp", bytes: new Uint8Array([255]) },
        { mediaType: "application/pdf", bytes: new Uint8Array([1]) },
      ]),
    ).toEqual([{ mediaType: "image/webp", data: "/w==" }]);
    expect(sendsEveryAttachment([{ mediaType: "image/png" }])).toBe(true);
    expect(sendsEveryAttachment([{ mediaType: "image/png" }, { mediaType: "text/plain" }])).toBe(
      false,
    );
  });
});
