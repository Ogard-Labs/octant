import { describe, expect, it } from "vitest";
import type { ProviderObservedState } from "@octant/contracts/providers";
import {
  attachmentModality,
  buildImageAttachmentCapability,
  chatFileRefusal,
  supportsAttachmentFile,
} from "./composerAttachmentCapability";

function observation(input: {
  readonly nativeAttachments: "supported" | "unsupported";
  readonly modalities: ReadonlyArray<string>;
}): ProviderObservedState {
  return {
    capabilities: { nativeAttachments: input.nativeAttachments },
    models: [{ id: "model-a", inputModalities: input.modalities }],
  } as unknown as ProviderObservedState;
}

describe("attachmentModality", () => {
  it("classifies media types into provider input modalities", () => {
    expect(attachmentModality("image/png")).toBe("image");
    expect(attachmentModality("audio/wav")).toBe("audio");
    expect(attachmentModality("application/pdf")).toBe("document");
  });
});

describe("supportsAttachmentFile", () => {
  it("requires provider support, an allow-listed media type, and the model modality", () => {
    const ready = observation({ nativeAttachments: "supported", modalities: ["text", "image"] });

    expect(supportsAttachmentFile(ready, "model-a", { type: "image/png" })).toBe(true);
    expect(supportsAttachmentFile(ready, "model-a", { type: "image/svg+xml" })).toBe(false);
    expect(supportsAttachmentFile(ready, "model-a", { type: "application/pdf" })).toBe(false);
    expect(supportsAttachmentFile(ready, "model-b", { type: "image/png" })).toBe(false);
  });

  it("fails closed with no provider observation at all", () => {
    expect(supportsAttachmentFile(undefined, "model-a", { type: "image/png" })).toBe(false);
  });
});

describe("chatFileRefusal", () => {
  const text = new TextEncoder().encode("a,b\n1,2\n");
  const binary = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);

  it("takes a text file for any model, even one with no native attachments", () => {
    const textOnly = observation({ nativeAttachments: "unsupported", modalities: ["text"] });
    expect(chatFileRefusal(textOnly, "model-a", { type: "text/csv" }, text, "data.csv")).toBe(
      undefined,
    );
  });

  it("takes a file the model reads natively whatever its bytes", () => {
    const documents = observation({
      nativeAttachments: "supported",
      modalities: ["text", "document"],
    });
    expect(
      chatFileRefusal(documents, "model-a", { type: "application/pdf" }, binary, "report.pdf"),
    ).toBe(undefined);
  });

  it("refuses a binary file the model cannot read and says where it can go", () => {
    const textOnly = observation({ nativeAttachments: "unsupported", modalities: ["text"] });
    expect(
      chatFileRefusal(textOnly, "model-a", { type: "application/zip" }, binary, "bundle.zip"),
    ).toMatch(/^bundle\.zip is not text.*Work or Code thread/);
  });
});

describe("buildImageAttachmentCapability", () => {
  it("is supported only when the model declares the image modality", () => {
    expect(
      buildImageAttachmentCapability(
        observation({ nativeAttachments: "supported", modalities: ["text", "image"] }),
        "model-a",
      ),
    ).toEqual({ kind: "supported" });
  });

  it("names the model when the provider takes attachments but not images", () => {
    const capability = buildImageAttachmentCapability(
      observation({ nativeAttachments: "supported", modalities: ["text", "document"] }),
      "model-a",
    );

    expect(capability).toEqual({
      kind: "unavailable",
      reason: "This model cannot read images. Pick one that can.",
    });
  });

  it("names the provider when it takes no attachments at all", () => {
    const capability = buildImageAttachmentCapability(
      observation({ nativeAttachments: "unsupported", modalities: ["image"] }),
      "model-a",
    );

    expect(capability).toEqual({
      kind: "unavailable",
      reason: "The selected provider cannot accept attachments, so images cannot be sent.",
    });
  });
});
