import {
  type AnthropicCompatibleAuthentication,
  type AnthropicCompatibleProtocol,
  type AnthropicCompatibleProviderConfiguration,
  type AzureFoundryProviderConfiguration,
  type BflImageProviderConfiguration,
  type GeminiImageAspectRatio,
  type GeminiImageProviderConfiguration,
  type GeminiImageResolution,
  type IdeogramImageProviderConfiguration,
  type OpenAiCompatibleProtocol,
  type OpenAiCompatibleProviderConfiguration,
  type OpenAiImageProviderConfiguration,
  type OpenAiImageQuality,
  type OpenAiImageSize,
} from "@octant/contracts";

export function configurationFrom(data: FormData): OpenAiCompatibleProviderConfiguration {
  return {
    kind: "openai-compatible-http",
    baseUrl: String(data.get("baseUrl") ?? ""),
    authentication: String(data.get("authentication") ?? "bearer") as "bearer" | "none",
    protocol: String(data.get("protocol") ?? "auto") as OpenAiCompatibleProtocol,
    manualModelIds: parseManualModelIds(String(data.get("manualModelIds") ?? "")),
  };
}

export function anthropicConfigurationFrom(
  data: FormData,
): AnthropicCompatibleProviderConfiguration {
  return {
    kind: "anthropic-compatible-http",
    baseUrl: String(data.get("baseUrl") ?? ""),
    authentication: String(
      data.get("authentication") ?? "api-key",
    ) as AnthropicCompatibleAuthentication,
    protocol: String(data.get("protocol") ?? "auto") as AnthropicCompatibleProtocol,
    protocolVersion: String(data.get("protocolVersion") ?? "2023-06-01"),
    manualModelIds: parseManualModelIds(String(data.get("manualModelIds") ?? "")),
  };
}

export function foundryConfigurationFrom(data: FormData): AzureFoundryProviderConfiguration {
  return {
    kind: "azure-foundry-openai-http",
    baseUrl: String(data.get("baseUrl") ?? ""),
    authentication: "api-key",
    protocol: String(data.get("protocol") ?? "auto") as OpenAiCompatibleProtocol,
    manualModelIds: parseManualModelIds(String(data.get("manualModelIds") ?? "")),
  };
}

export function parseManualModelIds(
  value: string,
): OpenAiCompatibleProviderConfiguration["manualModelIds"] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ] as unknown as OpenAiCompatibleProviderConfiguration["manualModelIds"];
}

export function optionalSelectValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function openAiImageConfigurationFrom(data: FormData): OpenAiImageProviderConfiguration {
  const modelAllowlist = parseManualModelIds(String(data.get("modelAllowlist") ?? ""));
  const enteredDefault = String(data.get("defaultModel") ?? "").trim();
  const defaultModel = enteredDefault.length > 0 ? enteredDefault : (modelAllowlist[0] ?? "");
  const quality = optionalSelectValue(String(data.get("quality") ?? "")) as
    | OpenAiImageQuality
    | undefined;
  const size = optionalSelectValue(String(data.get("size") ?? "")) as OpenAiImageSize | undefined;
  return {
    kind: "openai-image-http",
    modelAllowlist: modelAllowlist as unknown as OpenAiImageProviderConfiguration["modelAllowlist"],
    defaultModel: defaultModel as OpenAiImageProviderConfiguration["defaultModel"],
    ...(quality === undefined ? {} : { quality }),
    ...(size === undefined ? {} : { size }),
  };
}

export function geminiImageConfigurationFrom(data: FormData): GeminiImageProviderConfiguration {
  const modelAllowlist = parseManualModelIds(String(data.get("modelAllowlist") ?? ""));
  const enteredDefault = String(data.get("defaultModel") ?? "").trim();
  const defaultModel = enteredDefault.length > 0 ? enteredDefault : (modelAllowlist[0] ?? "");
  const aspectRatio = optionalSelectValue(String(data.get("aspectRatio") ?? "")) as
    | GeminiImageAspectRatio
    | undefined;
  const resolution = optionalSelectValue(String(data.get("resolution") ?? "")) as
    | GeminiImageResolution
    | undefined;
  return {
    kind: "gemini-native-image-http",
    modelAllowlist: modelAllowlist as unknown as GeminiImageProviderConfiguration["modelAllowlist"],
    defaultModel: defaultModel as GeminiImageProviderConfiguration["defaultModel"],
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(resolution === undefined ? {} : { resolution }),
  };
}

export function bflImageConfigurationFrom(data: FormData): BflImageProviderConfiguration {
  const modelAllowlist = parseManualModelIds(String(data.get("modelAllowlist") ?? ""));
  const enteredDefault = String(data.get("defaultModel") ?? "").trim();
  const defaultModel = enteredDefault.length > 0 ? enteredDefault : (modelAllowlist[0] ?? "");
  return {
    kind: "bfl-image-http",
    modelAllowlist: modelAllowlist as unknown as BflImageProviderConfiguration["modelAllowlist"],
    defaultModel: defaultModel as BflImageProviderConfiguration["defaultModel"],
  };
}

export function ideogramImageConfigurationFrom(data: FormData): IdeogramImageProviderConfiguration {
  const modelAllowlist = parseManualModelIds(String(data.get("modelAllowlist") ?? ""));
  const enteredDefault = String(data.get("defaultModel") ?? "").trim();
  const defaultModel = enteredDefault.length > 0 ? enteredDefault : (modelAllowlist[0] ?? "");
  return {
    kind: "ideogram-image-http",
    modelAllowlist:
      modelAllowlist as unknown as IdeogramImageProviderConfiguration["modelAllowlist"],
    defaultModel: defaultModel as IdeogramImageProviderConfiguration["defaultModel"],
  };
}
