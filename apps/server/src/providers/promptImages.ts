/**
 * Images a person attached to a turn, as a direct endpoint's request carries
 * them in the user message. Only the image types every supported protocol
 * documents are sent; a turn reaches a transport with any other attachment
 * only if admission let it, and admission takes images alone, so nothing is
 * dropped here that a person was told would be sent.
 */

const SENT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface PromptImage {
  readonly mediaType: string;
  /** Base64 of the image's bytes. */
  readonly data: string;
}

export function promptImagesOf(
  attachments:
    | ReadonlyArray<{ readonly mediaType: string; readonly bytes: Uint8Array }>
    | undefined,
): ReadonlyArray<PromptImage> {
  return (attachments ?? [])
    .filter((attachment) => SENT_IMAGE_TYPES.has(attachment.mediaType))
    .map((attachment) => ({
      mediaType: attachment.mediaType,
      data: Buffer.from(attachment.bytes).toString("base64"),
    }));
}

/** Chat Completions: text first, then each image as an `image_url` data URL part. */
export function chatCompletionsUserContent(
  text: string,
  images: ReadonlyArray<PromptImage> | undefined,
): string | ReadonlyArray<Record<string, unknown>> {
  if (images === undefined || images.length === 0) return text;
  return [
    ...(text.length === 0 ? [] : [{ type: "text", text }]),
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    })),
  ];
}

/** Responses: `input_text`, then each image as an `input_image` data URL part. */
export function responsesUserContent(
  text: string,
  images: ReadonlyArray<PromptImage> | undefined,
): string | ReadonlyArray<Record<string, unknown>> {
  if (images === undefined || images.length === 0) return text;
  return [
    ...(text.length === 0 ? [] : [{ type: "input_text", text }]),
    ...images.map((image) => ({
      type: "input_image",
      image_url: `data:${image.mediaType};base64,${image.data}`,
    })),
  ];
}

/** Messages: each image as a base64 `image` block, then the text. */
export function anthropicUserContent(
  text: string,
  images: ReadonlyArray<PromptImage>,
): ReadonlyArray<Record<string, unknown>> {
  return [
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    })),
    ...(text.length === 0 ? [] : [{ type: "text", text }]),
  ];
}

/**
 * What a direct endpoint claims about attachments: it sends an attached image
 * in the user message (above), so it takes attachments exactly when one of
 * its models reads images. Admission still checks the turn's own model, so a
 * text-only sibling is never sent one.
 */
export function attachedImagesSupport(
  models: ReadonlyArray<{ readonly inputModalities: ReadonlyArray<string> }>,
): "supported" | "unsupported" {
  return models.some((model) => model.inputModalities.includes("image"))
    ? "supported"
    : "unsupported";
}

/** Whether every attachment of a turn is an image this transport sends. */
export function sendsEveryAttachment(
  attachments: ReadonlyArray<{ readonly mediaType: string }>,
): boolean {
  return attachments.every((attachment) => SENT_IMAGE_TYPES.has(attachment.mediaType));
}
