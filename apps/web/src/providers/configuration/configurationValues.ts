import {
  type AnthropicCompatibleAuthentication,
  type AnthropicCompatibleProtocol,
  type AnthropicCompatibleProviderConfiguration,
  type AzureFoundryProviderConfiguration,
  type BflImageProviderConfiguration,
  type DirectoryClientId,
  type DirectoryTenantId,
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

/**
 * An Azure AI Foundry configuration from its form. The form names how it signs
 * in; one without the field (an older form) keeps the API key. An organization
 * sign-in carries the tenant and client the person pasted, lowercased, since
 * the host compares them exactly and refuses anything but a GUID.
 */
export function foundryConfigurationFrom(data: FormData): AzureFoundryProviderConfiguration {
  const shared = {
    kind: "azure-foundry-openai-http",
    baseUrl: String(data.get("baseUrl") ?? ""),
    protocol: String(data.get("protocol") ?? "auto") as OpenAiCompatibleProtocol,
    manualModelIds: parseManualModelIds(String(data.get("manualModelIds") ?? "")),
  } as const;
  if (data.get("authentication") !== "directory-oauth") {
    return { ...shared, authentication: "api-key" };
  }
  return {
    ...shared,
    authentication: "directory-oauth",
    directory: {
      tenantId: directoryGuid(data.get("tenantId")) as DirectoryTenantId,
      clientId: directoryGuid(data.get("clientId")) as DirectoryClientId,
    },
    // Off is the absence of the opt-in; the host stores no `false`.
    ...(data.get("deviceCodeSignIn") === null ? {} : { deviceCodeSignIn: true }),
  };
}

/** A pasted directory id as the host compares it: trimmed and lowercase. */
export function directoryGuid(value: FormDataEntryValue | string | null): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const DIRECTORY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a pasted tenant or client id is a GUID once lowercased. */
export function isDirectoryGuid(value: string): boolean {
  return DIRECTORY_GUID.test(directoryGuid(value));
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
    ...optionalBaseUrl(data),
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
    ...optionalBaseUrl(data),
  };
}

/** Blank leaves the profile on its provider's own endpoint. */
function optionalBaseUrl(data: FormData): { readonly baseUrl?: string } {
  const baseUrl = String(data.get("baseUrl") ?? "").trim();
  return baseUrl.length === 0 ? {} : { baseUrl };
}
