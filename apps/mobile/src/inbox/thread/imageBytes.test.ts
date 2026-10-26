import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptedMediaType, defaultAttachmentName, readUriBytes } from "./imageBytes";

afterEach(() => vi.unstubAllGlobals());

describe("read uri bytes", () => {
  it("reports an unreadable file instead of returning an error page as bytes", async () => {
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));

    expect(await readUriBytes("file:///gone.png")).toEqual({ status: "unreadable" });
  });

  it("returns the bytes of a readable file", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3])));

    expect(await readUriBytes("file:///a.png")).toEqual({
      status: "ok",
      bytes: new Uint8Array([1, 2, 3]),
    });
  });
});

describe("the media type a picked file uploads as", () => {
  const images = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  it("uses the type the picker reported when the thread takes it", () => {
    expect(acceptedMediaType({ reported: "image/png", name: "x.jpg", accepted: images })).toBe(
      "image/png",
    );
    expect(
      acceptedMediaType({ reported: "application/pdf", name: "x.pdf", accepted: images }),
    ).toBeUndefined();
  });

  it("falls back to the name's extension, but never guesses a type the name does not imply", () => {
    expect(acceptedMediaType({ reported: undefined, name: "IMG_1.JPG", accepted: images })).toBe(
      "image/jpeg",
    );
    expect(
      acceptedMediaType({ reported: null, name: "IMG_2.HEIC", accepted: images }),
    ).toBeUndefined();
  });

  it("names an unnamed camera photo by its type", () => {
    expect(defaultAttachmentName("image/jpeg", "0123456789abcdef")).toBe("photo-01234567.jpg");
  });
});
