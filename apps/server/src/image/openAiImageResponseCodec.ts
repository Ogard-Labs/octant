export type OpenAiImageDecoded =
  | {
      readonly kind: "ok";
      readonly images: ReadonlyArray<string>;
      readonly usage?: { inputTokens?: number; outputTokens?: number; size?: string };
    }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "url-rejected" }
  | { readonly kind: "invalid" };

export function decodeOpenAiImageResponse(value: unknown): OpenAiImageDecoded {
  if (!isRecord(value)) return { kind: "invalid" };
  const safety = safetyMessageFromUnknown(value);
  if (safety !== undefined) return { kind: "refused", message: safety };
  if (!Array.isArray(value.data)) return { kind: "invalid" };
  const images: Array<string> = [];
  for (const item of value.data) {
    if (!isRecord(item)) return { kind: "invalid" };
    if (typeof item.url === "string") return { kind: "url-rejected" };
    if (typeof item.b64_json !== "string" || item.b64_json.length === 0) return { kind: "invalid" };
    images.push(item.b64_json);
  }
  const usage = decodeOpenAiUsage(value.usage);
  return {
    kind: "ok",
    images,
    ...(usage === undefined ? {} : { usage }),
  };
}

export function decodeOpenAiUsage(
  value: unknown,
): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = asNonNegativeInt(value.input_tokens);
  const outputTokens = asNonNegativeInt(value.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

export function safetyMessageFromUnknown(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = isRecord(value.error) ? value.error : value;
  const code = typeof error.code === "string" ? error.code : "";
  const type = typeof error.type === "string" ? error.type : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (
    code === "moderation_blocked" ||
    code === "content_policy_violation" ||
    type === "image_generation_user_error" ||
    /safety|content policy|moderation/i.test(message)
  ) {
    return message.length > 0 ? message.slice(0, 2_000) : "The provider refused this request.";
  }
  return undefined;
}

export function decodeBase64Image(value: string): Uint8Array | undefined {
  try {
    const bytes = Uint8Array.from(Buffer.from(value, "base64"));
    if (bytes.byteLength === 0) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
