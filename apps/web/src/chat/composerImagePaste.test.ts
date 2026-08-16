import { describe, expect, it } from "vitest";
import {
  clipboardHasImage,
  collectPastedImages,
  pastedImageName,
  type ComposerClipboard,
} from "./composerImagePaste";

function file(name: string, type: string, size = 128): File {
  const value = new File([new Uint8Array(Math.max(size, 0))], name, { type });
  // `File` size is derived from its parts; a zero-byte fixture needs no override.
  return value;
}

function clipboard(files: ReadonlyArray<File>): ComposerClipboard {
  return {
    files,
    items: files.map((entry) => ({ kind: "file", getAsFile: () => entry })),
    types: files.length > 0 ? ["Files"] : ["text/plain"],
  };
}

describe("collectPastedImages", () => {
  it("accepts every image media type Chat already allows", () => {
    const files = [
      file("a.png", "image/png"),
      file("b.jpg", "image/jpeg"),
      file("c.webp", "image/webp"),
      file("d.gif", "image/gif"),
    ];

    const selection = collectPastedImages(clipboard(files));

    expect(selection.files.map((entry) => entry.type)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
    expect(selection.rejected).toEqual([]);
  });

  it("rejects an image media type outside the allow-list with a reason", () => {
    const selection = collectPastedImages(clipboard([file("vector.svg", "image/svg+xml")]));

    expect(selection.files).toEqual([]);
    expect(selection.rejected).toEqual([
      { displayName: "vector.svg", reason: "image/svg+xml images cannot be attached." },
    ]);
  });

  it("rejects an image over the attachment byte bound", () => {
    const selection = collectPastedImages(clipboard([file("big.png", "image/png", 4096)]), {
      maxBytes: 1024,
    });

    expect(selection.files).toEqual([]);
    expect(selection.rejected[0]!.reason).toBe("The pasted image is too large to attach.");
  });

  it("rejects an empty image", () => {
    const selection = collectPastedImages(clipboard([file("empty.png", "image/png", 0)]));

    expect(selection.rejected[0]!.reason).toBe("The pasted image is empty.");
  });

  it("leaves non-image clipboard content alone", () => {
    const selection = collectPastedImages({ files: [], items: [], types: ["text/plain"] });

    expect(selection).toEqual({ files: [], rejected: [] });
    expect(collectPastedImages(null)).toEqual({ files: [], rejected: [] });
  });

  it("does not double-count a file exposed through both files and items", () => {
    const entry = file("a.png", "image/png");

    const selection = collectPastedImages({
      files: [entry],
      items: [{ kind: "file", getAsFile: () => entry }],
    });

    expect(selection.files).toHaveLength(1);
  });
});

describe("clipboardHasImage", () => {
  it("is true only when the clipboard carries image bytes", () => {
    expect(clipboardHasImage(clipboard([file("a.png", "image/png")]))).toBe(true);
    expect(clipboardHasImage(clipboard([file("notes.txt", "text/plain")]))).toBe(false);
    expect(clipboardHasImage(undefined)).toBe(false);
  });
});

describe("pastedImageName", () => {
  it("names an unnamed clipboard image after its media type", () => {
    expect(pastedImageName(new File([new Uint8Array(1)], "", { type: "image/png" }))).toBe(
      "Pasted image.png",
    );
  });

  it("keeps a real file name", () => {
    expect(pastedImageName(file("screenshot.png", "image/png"))).toBe("screenshot.png");
  });
});
