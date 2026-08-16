import { describe, expect, it } from "vitest";
import type { ProviderObservedState } from "@octant/contracts/providers";
import {
  attachmentModality,
  buildAttachmentCapability,
  buildImageAttachmentCapability,
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

describe("buildAttachmentCapability", () => {
  it("reports the provider's own native attachment support", () => {
    expect(
      buildAttachmentCapability(
        observation({ nativeAttachments: "supported", modalities: ["text"] }),
      ),
    ).toEqual({ kind: "supported" });
    expect(
      buildAttachmentCapability(
        observation({ nativeAttachments: "unsupported", modalities: ["text"] }),
      ).kind,
    ).toBe("unavailable");
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
      reason: "The selected model does not accept images. Choose an image-capable model.",
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
